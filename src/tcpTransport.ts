import * as net from 'net';
import * as events from 'events';

/**
 * TCP 传输层 - 承载所有业务消息（聊天、文件）
 *
 * 使用独立的 TCP 端口（主 UDP 端口 + 1000）。
 * 主 UDP 通道继续用于：广播发现、心跳、在线状态。
 *
 * 帧格式：4 字节大端长度前缀 + JSON 负载。
 * 身份协议：连接建立后第一帧必须是 `{"__id": "<本端 peerId>"}`，
 * 接收方据此把 socket 注册到对应 peerId，之后的帧才作为业务数据上报。
 *
 * 事件：
 * - 'data' (peerId, Buffer)      收到一条完整业务消息
 * - 'sessionConnected' (peerId)  入站连接完成身份识别
 * - 'sessionClosed' (peerId)     连接断开
 * - 'sessionError' (peerId, err) 连接错误
 */
export class TcpTransport extends events.EventEmitter {
    private _server: net.Server | null = null;
    private _port: number;
    /** 本端 peerId（`ip:主端口`），用于身份帧和双向建连仲裁 */
    private _localId: string = '';
    /** key: peerId -> socket */
    private _sessions: Map<string, net.Socket> = new Map();
    private _isRunning: boolean = false;

    /** 单帧最大长度（防止异常数据导致内存暴涨） */
    private static readonly MAX_FRAME_SIZE = 64 * 1024 * 1024;

    constructor(basePort: number) {
        super();
        // 传输端口 = 主端口 + 1000，避免端口冲突
        this._port = basePort + 1000;
    }

    get port(): number {
        return this._port;
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    setLocalId(id: string): void {
        this._localId = id;
    }

    /**
     * 启动 TCP 监听
     */
    start(): Promise<void> {
        if (this._isRunning) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const server = net.createServer(socket => this._handleIncoming(socket));
            server.once('error', err => {
                if (!this._isRunning) {
                    reject(err);
                } else {
                    this.emit('error', err);
                }
            });
            server.listen(this._port, () => {
                this._isRunning = true;
                console.log(`TCP Transport listening on port ${this._port}`);
                resolve();
            });
            this._server = server;
        });
    }

    /**
     * 停止 TCP 传输层
     */
    stop(): void {
        this._isRunning = false;

        this._sessions.forEach(socket => {
            socket.destroy();
        });
        this._sessions.clear();

        if (this._server) {
            try {
                this._server.close();
            } catch (_) { /* ignore */ }
            this._server = null;
        }

        console.log('TCP Transport stopped');
    }

    hasSession(peerId: string): boolean {
        return this._sessions.has(peerId);
    }

    get connectionCount(): number {
        return this._sessions.size;
    }

    /**
     * 主动连接到远程 peer 的传输端口，并发送身份帧
     */
    connect(peerId: string, host: string, port: number, timeoutMs: number = 5000): Promise<void> {
        if (this._sessions.has(peerId)) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const socket = net.connect({ host, port });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`连接 ${peerId} 超时`));
            }, timeoutMs);

            socket.once('connect', () => {
                clearTimeout(timer);
                // 第一帧：身份帧
                socket.write(TcpTransport.encodeFrame(Buffer.from(JSON.stringify({ __id: this._localId }))));
                this._adoptSession(peerId, socket, true);
                this._attachFraming(socket, frame => {
                    this.emit('data', peerId, frame);
                });
                console.log(`TCP connected to ${peerId}`);
                resolve();
            });

            socket.once('error', err => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * 发送一条业务消息（自动加帧，处理背压）
     */
    async send(peerId: string, data: Buffer): Promise<void> {
        const socket = this._sessions.get(peerId);
        if (!socket) {
            throw new Error(`没有到 ${peerId} 的连接`);
        }
        const frame = TcpTransport.encodeFrame(data);
        if (!socket.write(frame)) {
            await new Promise<void>(resolve => socket.once('drain', resolve));
        }
    }

    /**
     * 断开与某个 peer 的连接
     */
    disconnect(peerId: string): void {
        const socket = this._sessions.get(peerId);
        if (socket) {
            socket.destroy();
            this._sessions.delete(peerId);
        }
    }

    private static encodeFrame(payload: Buffer): Buffer {
        const frame = Buffer.allocUnsafe(4 + payload.length);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        return frame;
    }

    /**
     * 处理入站连接：等待身份帧识别对端后再上报数据
     */
    private _handleIncoming(socket: net.Socket): void {
        let peerId: string | null = null;

        // 身份识别前的临时错误处理，避免未处理的 error 事件导致进程崩溃
        socket.on('error', err => {
            if (peerId === null) {
                console.error('TCP incoming socket error before identify:', err.message);
            }
        });

        this._attachFraming(socket, frame => {
            if (peerId === null) {
                // 第一帧必须是身份帧
                try {
                    const id = (JSON.parse(frame.toString()) as { __id?: string }).__id;
                    if (!id) {
                        throw new Error('missing __id');
                    }
                    peerId = id;
                } catch (err) {
                    console.error('TCP incoming session sent invalid identify frame, closing');
                    socket.destroy();
                    return;
                }
                if (this._adoptSession(peerId, socket, false)) {
                    this.emit('sessionConnected', peerId);
                }
                return;
            }
            this.emit('data', peerId, frame);
        });
    }

    /**
     * 注册会话。双向同时建连时按约定仲裁：
     * peerId 字典序较小的一方作为发起方，保留其出站连接。
     * @returns 该 socket 是否被采用
     */
    private _adoptSession(peerId: string, socket: net.Socket, outbound: boolean): boolean {
        const existing = this._sessions.get(peerId);
        if (existing && existing !== socket) {
            const keepOutbound = this._localId < peerId;
            if (outbound === keepOutbound) {
                existing.destroy();
            } else {
                socket.destroy();
                return false;
            }
        }

        this._sessions.set(peerId, socket);

        socket.on('close', () => {
            if (this._sessions.get(peerId) === socket) {
                this._sessions.delete(peerId);
                this.emit('sessionClosed', peerId);
            }
        });
        socket.on('error', err => {
            this.emit('sessionError', peerId, err);
        });
        return true;
    }

    /**
     * 为 socket 安装拆帧逻辑：按 4 字节长度前缀切出完整帧后回调
     */
    private _attachFraming(socket: net.Socket, onFrame: (frame: Buffer) => void): void {
        let buffer = Buffer.alloc(0);

        socket.on('data', chunk => {
            buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

            while (buffer.length >= 4) {
                const frameLength = buffer.readUInt32BE(0);
                if (frameLength > TcpTransport.MAX_FRAME_SIZE) {
                    console.error(`TCP frame too large (${frameLength} bytes), closing connection`);
                    socket.destroy();
                    return;
                }
                if (buffer.length < 4 + frameLength) {
                    break;
                }
                const frame = buffer.subarray(4, 4 + frameLength);
                buffer = buffer.subarray(4 + frameLength);
                onFrame(frame);
            }
        });
    }
}
