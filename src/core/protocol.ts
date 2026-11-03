import { PeerMeta } from './peerRegistry';

/**
 * 线上协议：消息类型、版本与校验（不依赖 vscode）。
 *
 * 所有消息都来自局域网上的任意主机，不能信任其结构：这里集中做类型与范围校验，
 * 校验不通过的消息直接丢弃，下游代码拿到的一定是结构合法、大小受限的消息
 * （防止畸形数据、超大 totalChunks/size 撑爆内存）。
 */

/**
 * 线上协议版本：
 * - 2：实例 ID / boot / meta；
 * - 3：文件传输带 transferId / chunkSize，发送端以 file_end 收尾，接收端以 file_ack 确认落盘结果。
 */
export const PROTOCOL_VERSION = 3;
/** 支持文件落盘确认（file_end / file_ack）的最低协议版本 */
export const FILE_ACK_MIN_PROTO = 3;

/** 文件分块大小（原始字节，发送时转 base64） */
export const FILE_CHUNK_SIZE = 64 * 1024;
/** 单个文件大小上限 */
export const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
/** 单条文本消息长度上限（字符） */
export const MAX_TEXT_LENGTH = 1_000_000;
const MAX_NAME_LENGTH = 512;
const MAX_ID_LENGTH = 128;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;

export type PresenceType = 'discovery_request' | 'discovery_response' | 'heartbeat' | 'heartbeat_ack';

interface FrameBase {
    /** 发送方：业务消息由传输层以会话键覆盖，不信任消息里自称的值 */
    from: string;
    to?: string;
    timestamp: number;
    proto?: number;
    iid?: string;
    boot?: string;
    meta?: PeerMeta;
}

/** UDP 通道：发现与心跳 */
export interface PresenceMessage extends FrameBase {
    type: PresenceType;
    fromHostname?: string;
    fromNickname?: string;
    transferPort?: number;
}

/** KCP 通道：聊天文本 */
export interface TextMessage extends FrameBase {
    type: 'message';
    /** 消息 ID：接收端据此去重（会话重建后的重发不会重复显示） */
    id?: string;
    content: string;
}

/** KCP 通道：文件分块 */
export interface FileChunkMessage extends FrameBase {
    type: 'file';
    file: {
        name: string;
        size: number;
        chunkIndex: number;
        totalChunks: number;
        /** 本块数据的 base64（0 字节文件为空串） */
        data: string;
        /** 分块大小，缺省 64KB（旧版发送方不带此字段） */
        chunkSize?: number;
        /** 传输 ID：同名文件并发、失败重发互不混淆（旧版发送方不带此字段） */
        transferId?: string;
    };
}

/** KCP 通道：文件发送完毕（所有分块都已被对端传输层确认），请接收端核对并回应 */
export interface FileEndMessage extends FrameBase {
    type: 'file_end';
    transferId: string;
    name: string;
    size: number;
    totalChunks: number;
}

/** KCP 通道：接收端对一个文件落盘结果的确认 */
export interface FileAckMessage extends FrameBase {
    type: 'file_ack';
    transferId: string;
    ok: boolean;
    reason?: string;
}

export type BusinessMessage = TextMessage | FileChunkMessage | FileEndMessage | FileAckMessage;

export type NetworkMessage = PresenceMessage | BusinessMessage;

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; reason: string };

const PRESENCE_TYPES: ReadonlySet<string> = new Set(['discovery_request', 'discovery_response', 'heartbeat', 'heartbeat_ack']);

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, maxLength: number): string | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parseJson(input: Buffer | string): Raw | null {
    try {
        const parsed: unknown = JSON.parse(typeof input === 'string' ? input : input.toString('utf-8'));
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** 公共头部字段的校验；通过时返回规范化后的头部 */
function parseBase(raw: Raw): FrameBase | string {
    const to = optionalString(raw.to, MAX_ID_LENGTH * 2);
    const iid = optionalString(raw.iid, MAX_ID_LENGTH);
    const boot = optionalString(raw.boot, MAX_ID_LENGTH);
    if (to === null || iid === null || boot === null) {
        return '头部字段类型或长度非法';
    }
    const proto = raw.proto;
    if (proto !== undefined && !isIntegerIn(proto, 0, 1000)) {
        return 'proto 非法';
    }
    let meta: PeerMeta | undefined;
    if (raw.meta !== undefined) {
        if (!isObject(raw.meta)) {
            return 'meta 非法';
        }
        meta = {};
        for (const key of ['os', 'arch', 'node', 'version', 'build', 'vscode'] as const) {
            const value = optionalString(raw.meta[key], 64);
            if (value === null) {
                return `meta.${key} 非法`;
            }
            if (value !== undefined) {
                meta[key] = value;
            }
        }
    }
    return {
        from: typeof raw.from === 'string' ? raw.from.slice(0, MAX_ID_LENGTH * 2) : '',
        to,
        timestamp: typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now(),
        proto: proto as number | undefined,
        iid,
        boot,
        meta
    };
}

/** 解析并校验 UDP 发现/心跳消息 */
export function parsePresenceMessage(input: Buffer | string): ParseResult<PresenceMessage> {
    const raw = parseJson(input);
    if (!raw) {
        return { ok: false, reason: '不是 JSON 对象' };
    }
    if (typeof raw.type !== 'string' || !PRESENCE_TYPES.has(raw.type)) {
        return { ok: false, reason: `不是发现/心跳消息（type=${String(raw.type)}）` };
    }
    const base = parseBase(raw);
    if (typeof base === 'string') {
        return { ok: false, reason: base };
    }
    const fromHostname = optionalString(raw.fromHostname, 255);
    const fromNickname = optionalString(raw.fromNickname, 100);
    if (fromHostname === null || fromNickname === null) {
        return { ok: false, reason: '主机名或昵称非法' };
    }
    if (raw.transferPort !== undefined && !isIntegerIn(raw.transferPort, 1, 65535)) {
        return { ok: false, reason: 'transferPort 非法' };
    }
    return {
        ok: true,
        msg: {
            ...base,
            type: raw.type as PresenceType,
            fromHostname,
            fromNickname,
            transferPort: raw.transferPort as number | undefined
        }
    };
}

/** 解析并校验 KCP 业务帧（文本、文件分块） */
export function parseBusinessFrame(input: Buffer | string): ParseResult<BusinessMessage> {
    const raw = parseJson(input);
    if (!raw) {
        return { ok: false, reason: '不是 JSON 对象' };
    }
    const base = parseBase(raw);
    if (typeof base === 'string') {
        return { ok: false, reason: base };
    }

    if (raw.type === 'message') {
        if (typeof raw.content !== 'string' || raw.content.length > MAX_TEXT_LENGTH) {
            return { ok: false, reason: '文本内容缺失或过长' };
        }
        const id = optionalString(raw.id, MAX_ID_LENGTH);
        if (id === null) {
            return { ok: false, reason: '消息 id 非法' };
        }
        return { ok: true, msg: { ...base, type: 'message', id, content: raw.content } };
    }

    if (raw.type === 'file') {
        if (!isObject(raw.file)) {
            return { ok: false, reason: '缺少 file 字段' };
        }
        const f = raw.file;
        if (typeof f.name !== 'string' || f.name.length === 0 || f.name.length > MAX_NAME_LENGTH) {
            return { ok: false, reason: '文件名缺失或过长' };
        }
        if (!isIntegerIn(f.size, 0, MAX_FILE_SIZE)) {
            return { ok: false, reason: `文件大小非法或超过上限（${MAX_FILE_SIZE} 字节）` };
        }
        const chunkSize = f.chunkSize === undefined ? FILE_CHUNK_SIZE : f.chunkSize;
        if (!isIntegerIn(chunkSize, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)) {
            return { ok: false, reason: 'chunkSize 非法' };
        }
        const expectedChunks = Math.max(1, Math.ceil(f.size / chunkSize));
        if (f.totalChunks !== expectedChunks) {
            return { ok: false, reason: `totalChunks（${String(f.totalChunks)}）与文件大小不符（应为 ${expectedChunks}）` };
        }
        if (!isIntegerIn(f.chunkIndex, 0, expectedChunks - 1)) {
            return { ok: false, reason: 'chunkIndex 越界' };
        }
        // base64 长度上限：4/3 倍原始分块大小，留少量余量
        if (typeof f.data !== 'string' || f.data.length > Math.ceil(chunkSize / 3) * 4 + 8) {
            return { ok: false, reason: '分块数据缺失或过长' };
        }
        const transferId = optionalString(f.transferId, MAX_ID_LENGTH);
        if (transferId === null) {
            return { ok: false, reason: 'transferId 非法' };
        }
        return {
            ok: true,
            msg: {
                ...base,
                type: 'file',
                file: {
                    name: f.name,
                    size: f.size,
                    chunkIndex: f.chunkIndex as number,
                    totalChunks: expectedChunks,
                    data: f.data,
                    chunkSize: f.chunkSize === undefined ? undefined : chunkSize,
                    transferId
                }
            }
        };
    }

    if (raw.type === 'file_end') {
        const name = optionalString(raw.name, MAX_NAME_LENGTH);
        if (typeof raw.transferId !== 'string' || raw.transferId.length === 0 || raw.transferId.length > MAX_ID_LENGTH
            || !name || !isIntegerIn(raw.size, 0, MAX_FILE_SIZE) || !isIntegerIn(raw.totalChunks, 1, MAX_FILE_SIZE / MIN_CHUNK_SIZE)) {
            return { ok: false, reason: 'file_end 字段缺失或非法' };
        }
        return {
            ok: true,
            msg: { ...base, type: 'file_end', transferId: raw.transferId, name, size: raw.size, totalChunks: raw.totalChunks }
        };
    }

    if (raw.type === 'file_ack') {
        const reason = optionalString(raw.reason, 500);
        if (typeof raw.transferId !== 'string' || raw.transferId.length === 0 || raw.transferId.length > MAX_ID_LENGTH
            || typeof raw.ok !== 'boolean' || reason === null) {
            return { ok: false, reason: 'file_ack 字段缺失或非法' };
        }
        return { ok: true, msg: { ...base, type: 'file_ack', transferId: raw.transferId, ok: raw.ok, reason } };
    }

    return { ok: false, reason: `未知的业务消息类型（type=${String(raw.type)}）` };
}
