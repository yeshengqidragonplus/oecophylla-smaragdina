import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from './logger';
import { FILE_CHUNK_SIZE, FileChunkMessage } from './protocol';
import { sanitizeFileName, uniqueSavePath } from './safeFileName';
import { TypedEmitter } from './typedEmitter';

/**
 * 文件接收器（不依赖 vscode）：把到达的文件分块**流式写盘**。
 *
 * 旧实现把全部分块以 base64 字符串留在内存里，收齐后一次性拼接写盘，
 * 大文件会占用与文件等大（再加 33%）的内存；并且每收一块还要同步重写整份会话文件。
 *
 * 现在：
 * - 每块解码后按偏移直接写入 `.part` 临时文件，内存里只有当前块；
 * - 收齐后校验长度，再重命名为最终文件名（同名加序号，不覆盖）；
 * - 以 transferId 区分传输：同名文件并发、失败后重发互不混淆（旧版发送方没有 transferId，
 *   退化为 对端 + 文件名 + 大小 + 块数）；
 * - 分块可乱序、可重复；0 字节文件正常落盘；
 * - 失败（写盘错误、块长度不符）或长时间没有数据时清理 `.part`，不留垃圾。
 */

export interface IncomingFileInfo {
    transferId: string;
    peerId: string;
    fileName: string;
    size: number;
}

export interface FileReceiverEvents {
    started: [info: IncomingFileInfo];
    progress: [info: IncomingFileInfo & { receivedBytes: number; progress: number }];
    completed: [info: IncomingFileInfo & { savedPath: string }];
    failed: [info: IncomingFileInfo & { reason: string }];
}

export interface FileReceiverOptions {
    /** 每次新传输开始时调用，返回保存目录（设置可能随时变化） */
    resolveDir: () => string;
    /** 超过该时长没有收到该传输的任何数据则判定中断并清理，默认 2 分钟 */
    idleTimeoutMs?: number;
    /** 检查中断的周期，默认 30 秒 */
    sweepIntervalMs?: number;
    /** 进度事件的最小间隔，默认 200ms */
    progressIntervalMs?: number;
}

const DEFAULT_IDLE_TIMEOUT = 120_000;
const DEFAULT_SWEEP_INTERVAL = 30_000;
const DEFAULT_PROGRESS_INTERVAL = 200;
/** 同时进行的接收上限（每个占一个文件句柄） */
const MAX_ACTIVE_TRANSFERS = 16;
const STALE_PART_PATTERN = /\.[0-9a-f]{8}\.part$/;

interface Transfer {
    key: string;
    info: IncomingFileInfo;
    totalChunks: number;
    chunkSize: number;
    received: Set<number>;
    writtenCount: number;
    receivedBytes: number;
    partPath: string;
    dir: string;
    handle: fs.promises.FileHandle | null;
    /** 写盘串行化：同一传输的写入按到达顺序依次进行 */
    queue: Promise<void>;
    lastActivity: number;
    lastProgressAt: number;
    lastProgressPercent: number;
    finished: boolean;
}

function describeFsError(err: unknown): string {
    const code = (err as NodeJS.ErrnoException).code;
    switch (code) {
        case 'ENOSPC':
            return '磁盘空间不足';
        case 'EACCES':
        case 'EPERM':
            return '没有写入权限';
        case 'ENOENT':
            return '保存目录不存在或已被移除';
        case 'EROFS':
            return '保存位置是只读的';
        default:
            return (err as Error).message;
    }
}

export class FileReceiver extends TypedEmitter<FileReceiverEvents> {
    private _transfers: Map<string, Transfer> = new Map();
    private _pending: Set<Promise<void>> = new Set();
    private _sweepTimer: NodeJS.Timeout | null = null;

    constructor(private readonly _options: FileReceiverOptions) {
        super();
        const interval = _options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL;
        this._sweepTimer = setInterval(() => this._sweepIdle(), interval);
        this._sweepTimer.unref();
    }

    /** 当前进行中的接收 */
    listActive(): IncomingFileInfo[] {
        return Array.from(this._transfers.values()).map(t => t.info);
    }

    /** 等待所有已提交的写入完成（测试与停止服务时使用） */
    async whenIdle(): Promise<void> {
        while (this._pending.size > 0) {
            await Promise.all(Array.from(this._pending));
        }
    }

    /** 处理一个文件分块（来自已通过 protocol 校验的 KCP 业务帧） */
    handleChunk(peerId: string, msg: FileChunkMessage): void {
        const f = msg.file;
        const chunkSize = f.chunkSize ?? FILE_CHUNK_SIZE;
        const key = `${peerId}|${f.transferId ?? `${f.name}|${f.size}|${f.totalChunks}`}`;

        let transfer = this._transfers.get(key);
        if (transfer && (transfer.info.size !== f.size || transfer.totalChunks !== f.totalChunks || transfer.chunkSize !== chunkSize)) {
            // 同一个标识却换了文件头：旧的作废，按新的重新开始
            this._fail(transfer, '被新的传输取代');
            transfer = undefined;
        }
        if (!transfer) {
            if (this._transfers.size >= MAX_ACTIVE_TRANSFERS) {
                logError(`[接收] 同时进行的接收已达上限（${MAX_ACTIVE_TRANSFERS}），忽略来自 ${peerId} 的 ${f.name}`);
                return;
            }
            transfer = this._start(key, peerId, f.name, f.size, f.totalChunks, chunkSize, f.transferId);
        }

        transfer.lastActivity = Date.now();
        if (transfer.received.has(f.chunkIndex)) {
            return; // 重复分块（会话重建后的重发）
        }
        transfer.received.add(f.chunkIndex);

        const target = transfer;
        const work = target.queue.then(() => this._writeChunk(target, f.chunkIndex, f.data));
        target.queue = work;
        this._track(work);
    }

    /** 停止：中止所有进行中的接收并清理临时文件 */
    dispose(): void {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
        for (const transfer of Array.from(this._transfers.values())) {
            this._fail(transfer, '接收已停止');
        }
    }

    // ==================== 内部 ====================

    private _track(work: Promise<void>): void {
        this._pending.add(work);
        void work.finally(() => this._pending.delete(work));
    }

    private _start(
        key: string, peerId: string, fileName: string, size: number,
        totalChunks: number, chunkSize: number, transferId?: string
    ): Transfer {
        const id = transferId ?? `legacy-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}`;
        const dir = this._options.resolveDir();
        const shortId = crypto.randomBytes(4).toString('hex');
        // 临时文件名 = 清理后的文件名（截短，给后缀留余量）+ 随机后缀 + .part
        const safe = sanitizeFileName(fileName, 120);
        const transfer: Transfer = {
            key,
            info: { transferId: id, peerId, fileName, size },
            totalChunks,
            chunkSize,
            received: new Set(),
            writtenCount: 0,
            receivedBytes: 0,
            partPath: path.join(dir, `${safe}.${shortId}.part`),
            dir,
            handle: null,
            queue: Promise.resolve(),
            lastActivity: Date.now(),
            lastProgressAt: 0,
            lastProgressPercent: -1,
            finished: false
        };
        this._transfers.set(key, transfer);
        log(`[接收] 开始接收 ${fileName}（${size} 字节，${totalChunks} 块）来自 ${peerId}`);
        this.emit('started', transfer.info);

        const opening = fs.promises.mkdir(dir, { recursive: true })
            .then(() => fs.promises.open(transfer.partPath, 'w'))
            .then(handle => {
                if (transfer.finished) {
                    void handle.close().then(() => fs.promises.unlink(transfer.partPath)).catch(() => undefined);
                } else {
                    transfer.handle = handle;
                }
            })
            .catch(err => this._fail(transfer, describeFsError(err)));
        transfer.queue = opening;
        this._track(opening);
        return transfer;
    }

    private async _writeChunk(transfer: Transfer, chunkIndex: number, base64: string): Promise<void> {
        if (transfer.finished || !transfer.handle) {
            return;
        }
        const data = Buffer.from(base64, 'base64');
        const isLast = chunkIndex === transfer.totalChunks - 1;
        const expected = isLast
            ? transfer.info.size - (transfer.totalChunks - 1) * transfer.chunkSize
            : transfer.chunkSize;
        if (data.length !== expected) {
            this._fail(transfer, `第 ${chunkIndex + 1} 块长度不符（收到 ${data.length} 字节，应为 ${expected} 字节），数据可能已损坏`);
            return;
        }
        try {
            if (data.length > 0) {
                await transfer.handle.write(data, 0, data.length, chunkIndex * transfer.chunkSize);
            }
        } catch (err) {
            this._fail(transfer, describeFsError(err));
            return;
        }
        if (transfer.finished) {
            return;
        }
        transfer.writtenCount++;
        transfer.receivedBytes += data.length;
        this._emitProgress(transfer);
        if (transfer.writtenCount === transfer.totalChunks) {
            await this._finalize(transfer);
        }
    }

    private _emitProgress(transfer: Transfer): void {
        const percent = transfer.info.size > 0
            ? Math.floor((transfer.receivedBytes / transfer.info.size) * 100)
            : Math.floor((transfer.writtenCount / transfer.totalChunks) * 100);
        const now = Date.now();
        const interval = this._options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL;
        const done = transfer.writtenCount === transfer.totalChunks;
        if (percent === transfer.lastProgressPercent || (!done && now - transfer.lastProgressAt < interval)) {
            return;
        }
        transfer.lastProgressPercent = percent;
        transfer.lastProgressAt = now;
        this.emit('progress', { ...transfer.info, receivedBytes: transfer.receivedBytes, progress: percent });
    }

    private async _finalize(transfer: Transfer): Promise<void> {
        transfer.finished = true;
        this._transfers.delete(transfer.key);
        try {
            await transfer.handle?.close();
            transfer.handle = null;
            const stat = await fs.promises.stat(transfer.partPath);
            if (stat.size !== transfer.info.size) {
                throw new Error(`文件长度不符（实际 ${stat.size} 字节，应为 ${transfer.info.size} 字节）`);
            }
            const savedPath = await this._moveIntoPlace(transfer);
            log(`[接收] 已保存 ${savedPath}`);
            this.emit('completed', { ...transfer.info, savedPath });
        } catch (err) {
            logError(`[接收] ${transfer.info.fileName} 收尾失败:`, (err as Error).message);
            await fs.promises.unlink(transfer.partPath).catch(() => undefined);
            this.emit('failed', { ...transfer.info, reason: describeFsError(err) });
        }
    }

    /**
     * 把临时文件放到最终位置，同名不覆盖。
     * 优先用硬链接（目标已存在时原子地失败，换下一个序号重试），不支持硬链接的文件系统
     * （如 FAT/exFAT 外接盘）退回 rename。
     */
    private async _moveIntoPlace(transfer: Transfer): Promise<string> {
        for (let attempt = 0; attempt < 50; attempt++) {
            const target = uniqueSavePath(transfer.dir, transfer.info.fileName);
            try {
                await fs.promises.link(transfer.partPath, target);
                await fs.promises.unlink(transfer.partPath);
                return target;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
                    continue;
                }
                await fs.promises.rename(transfer.partPath, target);
                return target;
            }
        }
        throw new Error('无法为文件找到不重名的保存位置');
    }

    private _fail(transfer: Transfer, reason: string): void {
        if (transfer.finished) {
            return;
        }
        transfer.finished = true;
        this._transfers.delete(transfer.key);
        logError(`[接收] ${transfer.info.fileName} 失败：${reason}`);
        const cleanup = (async () => {
            try {
                await transfer.handle?.close();
            } catch { /* 句柄可能已关闭 */ }
            transfer.handle = null;
            await fs.promises.unlink(transfer.partPath).catch(() => undefined);
        })();
        this._track(cleanup);
        this.emit('failed', { ...transfer.info, reason });
    }

    private _sweepIdle(): void {
        const now = Date.now();
        const timeout = this._options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
        for (const transfer of Array.from(this._transfers.values())) {
            if (now - transfer.lastActivity > timeout) {
                this._fail(transfer, `传输中断：超过 ${Math.round(timeout / 1000)} 秒没有收到数据`);
            }
        }
    }
}

/**
 * 清理上次崩溃遗留的临时文件：删除保存目录里超过指定时长未修改的 `.part` 文件
 * （只匹配本接收器生成的命名，不会误删用户的其他文件）。
 * @returns 删除的文件数
 */
export function cleanupStaleParts(dir: string, olderThanMs: number = 24 * 3600 * 1000): number {
    let removed = 0;
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return 0;
    }
    const now = Date.now();
    for (const name of entries) {
        if (!STALE_PART_PATTERN.test(name)) {
            continue;
        }
        const full = path.join(dir, name);
        try {
            if (now - fs.statSync(full).mtimeMs > olderThanMs) {
                fs.unlinkSync(full);
                removed++;
            }
        } catch { /* 文件可能正被使用或已被删除 */ }
    }
    return removed;
}
