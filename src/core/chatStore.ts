import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from './logger';
import { TypedEmitter } from './typedEmitter';

/**
 * 聊天记录存储（不依赖 vscode）。
 *
 * 旧实现的问题：
 * - 会话不是一对一：新建会话再选目标会把当前会话改绑，同一个人有 5 个会话，收发还落在不同会话里；
 * - 每次变化（包括文件接收的每一块）都同步重写整份 chatSessions.json，阻塞扩展宿主；
 * - 非原子写、多窗口互相覆盖、没有大小上限。
 *
 * 现在：
 * - **一个联系人对应一个会话**（按联系人的规范 id，历史别名自动归并）；
 * - 每个会话一个文件，只写有变化的会话，防抖 + 异步 + 原子（临时文件 + 重命名）；
 * - 进度这类高频瞬时状态只更新内存，不触发写盘；
 * - 每个会话最多保留 2000 条，超出丢弃最旧的；
 * - 启动时把旧的 chatSessions.json 按联系人合并迁移，原文件改名保留作为备份。
 */

export type MessageDirection = 'in' | 'out' | 'system';
export type MessageStatus = 'sending' | 'delivered' | 'failed';

export interface StoredFile {
    name: string;
    size: number;
    /** 接收的文件为保存路径；发送的文件为源路径 */
    path?: string;
    transferId?: string;
    status: 'transferring' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    error?: string;
}

export interface StoredMessage {
    id: string;
    direction: MessageDirection;
    text: string;
    timestamp: number;
    /** 仅发出的消息有：发送中 / 已送达（对端传输层确认）/ 失败 */
    status?: MessageStatus;
    /** status 为 failed 时的原因 */
    error?: string;
    file?: StoredFile;
}

export interface Conversation {
    id: string;
    /** 联系人的规范 id；空串表示旧数据里无法关联联系人的残留会话 */
    peerId: string;
    title: string;
    messages: StoredMessage[];
    lastUpdated: number;
    unread: number;
}

export interface ChatStoreEvents {
    /** 会话内容变化（新消息、状态更新） */
    change: [conversationId: string];
    removed: [conversationId: string];
}

export interface ChatStoreOptions {
    /** 把任意 id（含旧版 ip:端口、历史别名）映射为联系人的规范 id */
    resolvePeerId?: (id: string) => string;
    /** 写盘防抖，默认 1 秒 */
    saveDelayMs?: number;
    /** 每个会话保留的最大消息数，默认 2000 */
    maxMessages?: number;
    /** 旧版 chatSessions.json 的路径：存在则在 load() 时迁移 */
    legacyPath?: string;
}

const DEFAULT_SAVE_DELAY = 1000;
const DEFAULT_MAX_MESSAGES = 2000;
const INCOMING_PREFIX = /^📨 来自 .*?:\n/;

/** 旧版会话与消息的结构（仅用于迁移） */
interface LegacyMessage {
    id?: string;
    type?: string;
    content?: string;
    timestamp?: number;
    attachment?: { name?: string; path?: string };
}
interface LegacySession {
    id?: string;
    title?: string;
    peerId?: string;
    peerName?: string;
    messages?: LegacyMessage[];
    lastUpdated?: number;
}

function newId(): string {
    return crypto.randomUUID();
}

/** 异步原子写：同目录临时文件 + 重命名，写到一半崩溃不会损坏原文件 */
async function writeFileAtomic(file: string, data: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, file);
    } catch (err) {
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw err;
    }
}

export class ChatStore extends TypedEmitter<ChatStoreEvents> {
    private _conversations: Map<string, Conversation> = new Map();
    private _dirty: Set<string> = new Set();
    private _removed: Set<string> = new Set();
    private _timer: NodeJS.Timeout | null = null;
    private _flushing: Promise<void> = Promise.resolve();

    constructor(private readonly _dir: string, private readonly _options: ChatStoreOptions = {}) {
        super();
    }

    // ==================== 读取 ====================

    /** 最近有动静的会话在前 */
    list(): Conversation[] {
        return Array.from(this._conversations.values()).sort((a, b) => b.lastUpdated - a.lastUpdated);
    }

    get(id: string): Conversation | undefined {
        return this._conversations.get(id);
    }

    /** 按联系人查找会话（别名与规范 id 等价） */
    findByPeer(peerId: string): Conversation | undefined {
        const canonical = this._canonical(peerId);
        for (const conv of this._conversations.values()) {
            if (conv.peerId !== '' && this._canonical(conv.peerId) === canonical) {
                return conv;
            }
        }
        return undefined;
    }

    // ==================== 写入 ====================

    /** 取得与联系人对应的会话，没有则创建；旧会话保存的别名 id 会升级为规范 id */
    getOrCreate(peerId: string, title: string): Conversation {
        const canonical = this._canonical(peerId);
        const existing = this.findByPeer(canonical);
        if (existing) {
            if (existing.peerId !== canonical) {
                existing.peerId = canonical;
                this._markDirty(existing.id);
            }
            return existing;
        }
        const conv: Conversation = { id: newId(), peerId: canonical, title, messages: [], lastUpdated: Date.now(), unread: 0 };
        this._conversations.set(conv.id, conv);
        this._markDirty(conv.id);
        return conv;
    }

    /** 追加一条消息；收到的消息（in）会增加未读数 */
    append(conversationId: string, message: Partial<StoredMessage> & Pick<StoredMessage, 'direction' | 'text'>): StoredMessage {
        const conv = this._require(conversationId);
        const stored: StoredMessage = { id: newId(), timestamp: Date.now(), ...message };
        conv.messages.push(stored);
        const max = this._options.maxMessages ?? DEFAULT_MAX_MESSAGES;
        if (conv.messages.length > max) {
            conv.messages.splice(0, conv.messages.length - max);
        }
        conv.lastUpdated = stored.timestamp;
        if (stored.direction === 'in') {
            conv.unread++;
        }
        this._markDirty(conv.id);
        this.emit('change', conv.id);
        return stored;
    }

    /**
     * 更新一条消息（状态、文件进度等）。
     * persist=false 用于文件进度这类高频瞬时状态：只更新内存与通知界面，不触发写盘。
     */
    update(conversationId: string, messageId: string, patch: Partial<Omit<StoredMessage, 'id'>>, persist: boolean = true): StoredMessage | undefined {
        const conv = this._conversations.get(conversationId);
        const message = conv?.messages.find(m => m.id === messageId);
        if (!conv || !message) {
            return undefined;
        }
        Object.assign(message, patch);
        if (patch.file) {
            message.file = { ...(message.file ?? patch.file), ...patch.file };
        }
        if (persist) {
            this._markDirty(conv.id);
        }
        this.emit('change', conv.id);
        return message;
    }

    markRead(conversationId: string): void {
        const conv = this._conversations.get(conversationId);
        if (conv && conv.unread > 0) {
            conv.unread = 0;
            this._markDirty(conv.id);
            this.emit('change', conv.id);
        }
    }

    remove(conversationId: string): void {
        if (this._conversations.delete(conversationId)) {
            this._dirty.delete(conversationId);
            this._removed.add(conversationId);
            this._schedule();
            this.emit('removed', conversationId);
        }
    }

    // ==================== 持久化 ====================

    /** 读取全部会话；若存在旧版 chatSessions.json，先迁移再读 */
    async load(): Promise<void> {
        await fs.promises.mkdir(this._dir, { recursive: true });
        const files = (await fs.promises.readdir(this._dir)).filter(n => n.endsWith('.json'));
        for (const name of files) {
            const full = path.join(this._dir, name);
            try {
                const conv = JSON.parse(await fs.promises.readFile(full, 'utf-8')) as Conversation;
                if (typeof conv.id === 'string' && Array.isArray(conv.messages)) {
                    // 磁盘上的数据来自旧版本或被手工改过：缺失的字段补默认值
                    this._conversations.set(conv.id, {
                        ...conv,
                        peerId: conv.peerId ?? '',
                        title: conv.title ?? '',
                        lastUpdated: conv.lastUpdated ?? 0,
                        unread: conv.unread ?? 0
                    });
                    continue;
                }
                throw new Error('不是会话文件');
            } catch (err) {
                // 损坏的文件挪到一边保留，不删除、不影响其他会话
                const aside = `${full}.corrupt-${Date.now()}`;
                logError(`[聊天记录] ${name} 无法读取（${(err as Error).message}），已另存为 ${path.basename(aside)}`);
                await fs.promises.rename(full, aside).catch(() => undefined);
            }
        }
        if (this._options.legacyPath) {
            await this._migrateLegacy(this._options.legacyPath);
        }
    }

    /** 立即写入所有待写的变化（插件停用、测试时使用） */
    flush(): Promise<void> {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._flushing = this._flushing.then(() => this._writeDirty());
        return this._flushing;
    }

    // ==================== 内部 ====================

    private _canonical(id: string): string {
        return this._options.resolvePeerId ? this._options.resolvePeerId(id) : id;
    }

    private _require(id: string): Conversation {
        const conv = this._conversations.get(id);
        if (!conv) {
            throw new Error(`会话 ${id} 不存在`);
        }
        return conv;
    }

    private _markDirty(id: string): void {
        this._dirty.add(id);
        this._schedule();
    }

    private _schedule(): void {
        if (this._timer) {
            return;
        }
        this._timer = setTimeout(() => {
            this._timer = null;
            this._flushing = this._flushing.then(() => this._writeDirty());
        }, this._options.saveDelayMs ?? DEFAULT_SAVE_DELAY);
        this._timer.unref();
    }

    private async _writeDirty(): Promise<void> {
        const dirty = Array.from(this._dirty);
        const removed = Array.from(this._removed);
        this._dirty.clear();
        this._removed.clear();
        try {
            await fs.promises.mkdir(this._dir, { recursive: true });
            for (const id of dirty) {
                const conv = this._conversations.get(id);
                if (conv) {
                    await writeFileAtomic(path.join(this._dir, `${id}.json`), JSON.stringify(conv));
                }
            }
            for (const id of removed) {
                await fs.promises.unlink(path.join(this._dir, `${id}.json`)).catch(() => undefined);
            }
        } catch (err) {
            logError('[聊天记录] 写盘失败:', (err as Error).message);
            // 失败的会话放回待写集合，下次再试
            dirty.forEach(id => this._dirty.add(id));
        }
    }

    /**
     * 迁移旧版 chatSessions.json：按联系人合并（同一个人的多个旧会话合成一个），
     * 消息按时间排序并按 id 去重，去掉旧版加在收到消息前面的"📨 来自 X:"前缀。
     * 迁移后把原文件改名为 .migrated-时间戳 保留作为备份，不会重复迁移。
     */
    private async _migrateLegacy(legacyPath: string): Promise<void> {
        let sessions: LegacySession[];
        try {
            sessions = JSON.parse(await fs.promises.readFile(legacyPath, 'utf-8')) as LegacySession[];
            if (!Array.isArray(sessions)) {
                throw new Error('内容不是数组');
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            logError(`[聊天记录] 旧文件 ${legacyPath} 无法解析（${(err as Error).message}），跳过迁移并保留原文件`);
            return;
        }

        let migrated = 0;
        for (const session of sessions) {
            const messages = this._convertLegacyMessages(session.messages ?? []);
            const meaningful = messages.some(m => m.direction !== 'system');
            if (session.peerId) {
                const conv = this.getOrCreate(session.peerId, session.peerName || session.title || session.peerId);
                this._mergeMessages(conv, messages);
                if (session.peerName && !session.peerName.includes(':')) {
                    conv.title = session.peerName;
                }
                migrated++;
            } else if (meaningful) {
                // 没有关联联系人但有真实内容的残留会话：集中放进一个"未关联"会话
                const orphan = this._findOrphan() ?? this._createOrphan();
                this._mergeMessages(orphan, messages);
                migrated++;
            }
        }

        const backup = `${legacyPath}.migrated-${Date.now()}`;
        await fs.promises.rename(legacyPath, backup);
        log(`[聊天记录] 已迁移 ${sessions.length} 个旧会话（有内容的 ${migrated} 个）到 ${this._conversations.size} 个按联系人合并的会话，旧文件备份为 ${path.basename(backup)}`);
        await this.flush();
    }

    private _findOrphan(): Conversation | undefined {
        return Array.from(this._conversations.values()).find(c => c.peerId === '');
    }

    private _createOrphan(): Conversation {
        const conv: Conversation = { id: newId(), peerId: '', title: '（未关联联系人）', messages: [], lastUpdated: 0, unread: 0 };
        this._conversations.set(conv.id, conv);
        return conv;
    }

    private _convertLegacyMessages(legacy: LegacyMessage[]): StoredMessage[] {
        return legacy.map(m => {
            const direction: MessageDirection = m.type === 'user' ? 'out' : m.type === 'assistant' ? 'in' : 'system';
            const text = (m.content ?? '').replace(INCOMING_PREFIX, '');
            const stored: StoredMessage = {
                id: m.id ?? newId(),
                direction,
                text,
                timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0
            };
            if (direction === 'out') {
                stored.status = 'delivered';
            }
            if (m.attachment?.name) {
                stored.file = { name: m.attachment.name, size: 0, path: m.attachment.path, status: 'completed', progress: 100 };
            }
            return stored;
        });
    }

    private _mergeMessages(conv: Conversation, incoming: StoredMessage[]): void {
        const seen = new Set(conv.messages.map(m => m.id));
        for (const message of incoming) {
            if (!seen.has(message.id)) {
                conv.messages.push(message);
                seen.add(message.id);
            }
        }
        conv.messages.sort((a, b) => a.timestamp - b.timestamp);
        const max = this._options.maxMessages ?? DEFAULT_MAX_MESSAGES;
        if (conv.messages.length > max) {
            conv.messages.splice(0, conv.messages.length - max);
        }
        const last = conv.messages[conv.messages.length - 1];
        conv.lastUpdated = Math.max(conv.lastUpdated, last?.timestamp ?? 0);
        this._markDirty(conv.id);
    }
}
