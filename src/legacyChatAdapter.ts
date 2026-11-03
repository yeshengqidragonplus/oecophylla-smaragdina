import { Conversation, StoredMessage } from './core/chatStore';

/**
 * 把 ChatStore 的会话投影成旧版侧边栏界面认识的结构（user / assistant / system 消息、transferStatus）。
 * 不依赖 vscode，便于单测。M3 用新界面替换旧界面后删除本文件。
 */

export interface LegacyMessage {
    id: string;
    type: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    attachment?: { name: string; path: string; type: 'file' | 'image' };
}

export interface LegacySession {
    id: string;
    title: string;
    peerId: string;
    peerName: string;
    messages: LegacyMessage[];
    lastUpdated: number;
    transferStatus: 'completed' | 'transferring' | 'pending' | 'failed';
    transferProgress: number;
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 一条消息在旧界面里显示的文字：文件带大小与状态行，发送失败带原因 */
export function describeMessage(message: StoredMessage): string {
    const file = message.file;
    if (file) {
        const head = `${message.direction === 'in' ? '📥' : '📎'} ${file.name}（${formatFileSize(file.size)}）`;
        switch (file.status) {
            case 'transferring':
                return `${head}\n⏳ ${message.direction === 'in' ? '接收中' : '发送中'} ${file.progress}%`;
            case 'completed':
                return message.direction === 'in'
                    ? `${head}\n✅ 已保存：${file.path ?? ''}`
                    : `${head}\n✅ 已发送`;
            case 'cancelled':
                return `${head}\n已取消`;
            default:
                return `${head}\n❌ ${message.direction === 'in' ? '接收失败' : '发送失败'}：${file.error ?? message.error ?? '未知原因'}`;
        }
    }
    if (message.direction === 'out' && message.status === 'failed') {
        return `${message.text}\n❌ 发送失败：${message.error ?? '未知原因'}`;
    }
    if (message.direction === 'out' && message.status === 'sending') {
        return `${message.text}\n⏳ 发送中…`;
    }
    return message.text;
}

function toLegacyMessage(message: StoredMessage): LegacyMessage {
    return {
        id: message.id,
        type: message.direction === 'out' ? 'user' : message.direction === 'in' ? 'assistant' : 'system',
        content: describeMessage(message),
        timestamp: message.timestamp,
        attachment: message.file ? { name: message.file.name, path: message.file.path ?? '', type: 'file' } : undefined
    };
}

/** 会话列表里状态点的含义：有文件在传 → 传输中；最近一条发出的消息失败 → 失败；发送中 → 等待；否则正常 */
export function sessionStatus(conv: Conversation): Pick<LegacySession, 'transferStatus' | 'transferProgress'> {
    const transferring = conv.messages.find(m => m.file?.status === 'transferring');
    if (transferring?.file) {
        return { transferStatus: 'transferring', transferProgress: transferring.file.progress };
    }
    const lastOut = [...conv.messages].reverse().find(m => m.direction === 'out');
    if (lastOut?.status === 'failed') {
        return { transferStatus: 'failed', transferProgress: 0 };
    }
    if (lastOut?.status === 'sending') {
        return { transferStatus: 'pending', transferProgress: 0 };
    }
    return { transferStatus: 'completed', transferProgress: 100 };
}

export function toLegacySession(conv: Conversation): LegacySession {
    return {
        id: conv.id,
        title: conv.title,
        peerId: conv.peerId,
        peerName: conv.title,
        messages: conv.messages.map(toLegacyMessage),
        lastUpdated: conv.lastUpdated,
        ...sessionStatus(conv)
    };
}
