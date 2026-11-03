import { ChatStore, StoredFile } from './chatStore';
import { FileReceiveService } from './fileReceiveService';
import { FileReceiver } from './fileReceiver';
import { logError } from './logger';
import { NetworkService, TransferTask } from './networkService';
import { TypedEmitter } from './typedEmitter';

/**
 * 消息服务（不依赖 vscode）：把"收发消息与文件"的业务逻辑从侧边栏视图里拆出来。
 *
 * 之前这些逻辑（会话归属、文件接收重组、传输编排、状态更新）都塞在 1900 行的
 * chatViewProvider.ts 里，与界面代码缠在一起，无法单测。现在：
 * - 发送：文本与每个文件各自独立发送、各有各的状态（发送中 / 已送达 / 失败），可取消、可重试；
 * - 接收：文本与文件入库到对应联系人的会话；文件由 FileReceiver 流式落盘并回落盘确认；
 * - 界面只需要订阅 ChatStore 的变化并显示，不再持有业务状态。
 */

export interface IncomingNotice {
    conversationId: string;
    peerId: string;
    displayName: string;
    kind: 'text' | 'file';
    /** 通知里显示的摘要 */
    preview: string;
}

export interface MessagingEvents {
    /** 收到新消息（文本到达、文件接收完成），用于通知与未读徽标 */
    incoming: [notice: IncomingNotice];
}

export interface MessagingDeps {
    network: NetworkService;
    store: ChatStore;
    receiver: FileReceiver;
    /** 联系人的显示名（昵称 > 主机名 > 地址） */
    displayName: (peerId: string) => string;
}

export interface OutgoingFile {
    name: string;
    path: string;
    size: number;
}

export interface SendOutcome {
    messageId: string;
    ok: boolean;
    error?: string;
}

type Job =
    | { kind: 'text'; messageId: string; text: string }
    | { kind: 'file'; messageId: string; file: OutgoingFile };

/** 把底层错误翻译成用户能看懂的原因 */
function friendlyError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Connect timeout' || message.includes('超时') && message.startsWith('连接')) {
        return '连接失败，对方可能不在线（或防火墙拦截了端口）';
    }
    return message;
}

export class MessagingService extends TypedEmitter<MessagingEvents> {
    private readonly _network: NetworkService;
    private readonly _store: ChatStore;
    private readonly _displayName: (peerId: string) => string;
    private readonly _fileReceive: FileReceiveService;
    /** 进行中的发送：消息 id → 网络任务 id（用于取消） */
    private readonly _tasks: Map<string, string> = new Map();
    /** 网络任务 id → 它对应的消息（用于进度回写） */
    private readonly _taskIndex: Map<string, { conversationId: string; messageId: string; isFile: boolean }> = new Map();
    /** 接收中的文件：`${peerId}|${transferId}` → 消息位置 */
    private readonly _incomingFiles: Map<string, { conversationId: string; messageId: string }> = new Map();

    constructor(deps: MessagingDeps) {
        super();
        this._network = deps.network;
        this._store = deps.store;
        this._displayName = deps.displayName;
        this._fileReceive = new FileReceiveService(deps.network, deps.receiver);

        this._network.on('message', this._onMessage);
        this._network.on('transferTaskUpdated', this._onTaskUpdated);

        const receiver = deps.receiver;
        receiver.on('started', info => {
            const conv = this._store.getOrCreate(info.peerId, this._displayName(info.peerId));
            const msg = this._store.append(conv.id, {
                direction: 'in',
                text: '',
                file: { name: info.fileName, size: info.size, transferId: info.transferId, status: 'transferring', progress: 0 }
            });
            this._incomingFiles.set(`${info.peerId}|${info.transferId}`, { conversationId: conv.id, messageId: msg.id });
        });
        receiver.on('progress', info => {
            const at = this._incomingFiles.get(`${info.peerId}|${info.transferId}`);
            if (at) {
                // 进度是高频瞬时状态：只更新内存与界面，不触发写盘
                this._store.update(at.conversationId, at.messageId, { file: { name: info.fileName, size: info.size, status: 'transferring', progress: info.progress } }, false);
            }
        });
        receiver.on('completed', info => {
            const key = `${info.peerId}|${info.transferId}`;
            const at = this._incomingFiles.get(key);
            this._incomingFiles.delete(key);
            if (!at) {
                return;
            }
            this._store.update(at.conversationId, at.messageId, {
                file: { name: info.fileName, size: info.size, path: info.savedPath, status: 'completed', progress: 100 }
            });
            this.emit('incoming', {
                conversationId: at.conversationId,
                peerId: info.peerId,
                displayName: this._displayName(info.peerId),
                kind: 'file',
                preview: `📎 ${info.fileName}`
            });
        });
        receiver.on('failed', info => {
            const key = `${info.peerId}|${info.transferId}`;
            const at = this._incomingFiles.get(key);
            this._incomingFiles.delete(key);
            if (at) {
                this._store.update(at.conversationId, at.messageId, {
                    file: { name: info.fileName, size: info.size, status: 'failed', progress: 0, error: info.reason }
                });
            }
        });
    }

    dispose(): void {
        this._network.off('message', this._onMessage);
        this._network.off('transferTaskUpdated', this._onTaskUpdated);
        this._fileReceive.dispose();
    }

    // ==================== 发送 ====================

    /**
     * 向联系人发送文本与文件。文本与每个文件各自独立发送、各有各的状态：
     * 一个文件失败不影响其他文件，失败的消息保留在会话里，可以重试。
     */
    async send(peerId: string, text: string, files: OutgoingFile[] = []): Promise<SendOutcome[]> {
        const conv = this._store.getOrCreate(peerId, this._displayName(peerId));
        const jobs: Job[] = [];
        if (text.trim()) {
            const message = this._store.append(conv.id, { direction: 'out', text, status: 'sending' });
            jobs.push({ kind: 'text', messageId: message.id, text });
        }
        for (const file of files) {
            const message = this._store.append(conv.id, {
                direction: 'out',
                text: '',
                status: 'sending',
                file: { name: file.name, size: file.size, path: file.path, status: 'transferring', progress: 0 }
            });
            jobs.push({ kind: 'file', messageId: message.id, file });
        }

        const outcomes: SendOutcome[] = [];
        for (const job of jobs) {
            outcomes.push(await this._run(conv.id, conv.peerId || peerId, job));
        }
        return outcomes;
    }

    /** 取消一条正在发送的文件消息 */
    cancel(messageId: string): boolean {
        const taskId = this._tasks.get(messageId);
        return taskId ? this._network.cancelTransferTask(taskId) : false;
    }

    /** 重试一条失败的发出消息（文本或文件） */
    async retry(conversationId: string, messageId: string): Promise<SendOutcome | undefined> {
        const conv = this._store.get(conversationId);
        const message = conv?.messages.find(m => m.id === messageId);
        if (!conv || !message || message.direction !== 'out' || message.status === 'sending') {
            return undefined;
        }
        if (message.file) {
            if (!message.file.path) {
                return undefined;
            }
            const file: OutgoingFile = { name: message.file.name, path: message.file.path, size: message.file.size };
            this._store.update(conv.id, message.id, {
                status: 'sending',
                error: undefined,
                file: { ...message.file, status: 'transferring', progress: 0, error: undefined }
            });
            return this._run(conv.id, conv.peerId, { kind: 'file', messageId: message.id, file });
        }
        this._store.update(conv.id, message.id, { status: 'sending', error: undefined });
        return this._run(conv.id, conv.peerId, { kind: 'text', messageId: message.id, text: message.text });
    }

    private async _run(conversationId: string, peerId: string, job: Job): Promise<SendOutcome> {
        let taskId: string | undefined;
        try {
            const task = this._network.createTransferTask(
                peerId,
                job.kind === 'text' ? [job.text] : [],
                job.kind === 'file' ? [job.file] : []);
            taskId = task.id;
            this._tasks.set(job.messageId, task.id);
            this._taskIndex.set(task.id, { conversationId, messageId: job.messageId, isFile: job.kind === 'file' });

            await this._network.executeTransferTask(task.id);

            this._store.update(conversationId, job.messageId, {
                status: 'delivered',
                ...(job.kind === 'file' ? { file: this._fileState(conversationId, job.messageId, { status: 'completed', progress: 100 }) } : {})
            });
            return { messageId: job.messageId, ok: true };
        } catch (err) {
            const cancelled = !!taskId && this._network.getTransferTask(taskId)?.status === 'cancelled';
            const error = cancelled ? '已取消' : friendlyError(err);
            logError(`[消息] 发送失败：${error}`);
            this._store.update(conversationId, job.messageId, {
                status: 'failed',
                error,
                ...(job.kind === 'file'
                    ? { file: this._fileState(conversationId, job.messageId, { status: cancelled ? 'cancelled' : 'failed', error }) }
                    : {})
            });
            return { messageId: job.messageId, ok: false, error };
        } finally {
            this._tasks.delete(job.messageId);
            if (taskId) {
                this._taskIndex.delete(taskId);
            }
        }
    }

    /** 在现有文件信息上合并更新（保留名称、大小、路径） */
    private _fileState(conversationId: string, messageId: string, patch: Partial<StoredFile>): StoredFile {
        const current = this._store.get(conversationId)?.messages.find(m => m.id === messageId)?.file;
        return { name: '', size: 0, status: 'transferring', progress: 0, ...current, ...patch };
    }

    // ==================== 接收 ====================

    private readonly _onMessage = (msg: { type: string; from: string; content?: string }): void => {
        if (msg.type !== 'message' || typeof msg.content !== 'string') {
            return;
        }
        const conv = this._store.getOrCreate(msg.from, this._displayName(msg.from));
        this._store.append(conv.id, { direction: 'in', text: msg.content });
        this.emit('incoming', {
            conversationId: conv.id,
            peerId: conv.peerId,
            displayName: this._displayName(msg.from),
            kind: 'text',
            preview: msg.content.replace(/\s+/g, ' ').slice(0, 60)
        });
    };

    private readonly _onTaskUpdated = (task: TransferTask): void => {
        const at = this._taskIndex.get(task.id);
        if (!at || !at.isFile || task.status !== 'transferring') {
            return; // 最终状态由 _run 在任务结束后统一写入
        }
        this._store.update(at.conversationId, at.messageId, {
            file: this._fileState(at.conversationId, at.messageId, { status: 'transferring', progress: task.progress })
        }, false);
    };
}
