import { Listen, Dial, UDPSession, Listener } from 'kcpjs';
import * as events from 'events';

/**
 * KCP 传输层 - 在 UDP 之上提供可靠传输
 * 
 * 使用独立的 UDP 端口（主端口 + 1000），与主 UDP 通道互不干扰。
 * 主 UDP 通道继续用于：发现、握手、在线状态、小消息
 * KCP 通道用于：文件传输（可靠、断点续传）
 */
export class KcpTransport extends events.EventEmitter {
    private _listener: Listener | null = null;
    /** key: `ip:port` -> UDPSession */
    private _sessions: Map<string, UDPSession> = new Map();
    private _port: number;
    private _isRunning: boolean = false;
    /** 下一个可用的会话 ID */
    private _nextConv: number = 1;

    constructor(basePort: number) {
        super();
        // KCP 端口 = 主端口 + 1000，避免端口冲突
        this._port = basePort + 1000;
    }

    get port(): number {
        return this._port;
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * 启动 KCP 监听
     */
    async start(): Promise<void> {
        if (this._isRunning) {
            return;
        }

        return new Promise((resolve, reject) => {
            try {
                this._listener = Listen(this._port, (session: UDPSession) => {
                    this._handleIncomingSession(session);
                });
                this._isRunning = true;
                console.log(`KCP Transport listening on port ${this._port}`);
                resolve();
            } catch (err) {
                console.error('Failed to start KCP Transport:', err);
                reject(err);
            }
        });
    }

    /**
     * 停止 KCP 传输层
     */
    stop(): void {
        this._isRunning = false;

        // 关闭所有会话
        this._sessions.forEach(session => {
            try { session.close(); } catch (_) { /* ignore */ }
        });
        this._sessions.clear();

        // 关闭监听器
        if (this._listener) {
            try {
                this._listener.close();
            } catch (_) { /* ignore */ }
            this._listener = null;
        }

        console.log('KCP Transport stopped');
    }

    /**
     * 连接到远程 peer 的 KCP 端口
     * @param conv 会话 ID（由发起方分配）
     * @param host 目标 IP
     * @param port 目标 KCP 端口
     * @returns 会话 key `ip:port`
     */
    async connect(conv: number, host: string, port: number): Promise<string> {
        const session = Dial(conv, port, host) as UDPSession;
        const key = `${host}:${port}`;

        // 如果已有会话，先关闭
        const existing = this._sessions.get(key);
        if (existing) {
            try { existing.close(); } catch (_) { /* ignore */ }
        }

        this._sessions.set(key, session);
        this._setupSessionEvents(key, session);

        console.log(`KCP connected to ${key} (conv=${conv})`);
        return key;
    }

    /**
     * 分配一个新的会话 ID 并连接到远程 peer
     */
    async connectToPeer(host: string, port: number): Promise<{ conv: number; key: string }> {
        const conv = this._nextConv++;
        const key = await this.connect(conv, host, port);
        return { conv, key };
    }

    /**
     * 通过 KCP 发送数据
     * @param peerKey `ip:port`
     * @param data 要发送的二进制数据
     */
    async send(peerKey: string, data: Buffer): Promise<void> {
        const session = this._sessions.get(peerKey);
        if (!session) {
            throw new Error(`No KCP session to ${peerKey}`);
        }
        session.write(data);
    }

    /**
     * 断开与某个 peer 的 KCP 连接
     */
    disconnect(peerKey: string): void {
        const session = this._sessions.get(peerKey);
        if (session) {
            try { session.close(); } catch (_) { /* ignore */ }
            this._sessions.delete(peerKey);
        }
    }

    /**
     * 断开所有连接
     */
    disconnectAll(): void {
        this._sessions.forEach((session, key) => {
            try { session.close(); } catch (_) { /* ignore */ }
        });
        this._sessions.clear();
    }

    /**
     * 检查是否存在指定 key 的 KCP 会话
     */
    hasSession(key: string): boolean {
        return this._sessions.has(key);
    }

    /**
     * 获取当前连接数
     */
    get connectionCount(): number {
        return this._sessions.size;
    }

    /**
     * 处理入站 KCP 会话
     */
    private _handleIncomingSession(session: UDPSession): void {
        const key = `${session.host}:${session.port}`;
        console.log(`KCP incoming session from ${key}`);

        // 如果已有该 key 的会话，关闭旧的
        const existing = this._sessions.get(key);
        if (existing) {
            try { existing.close(); } catch (_) { /* ignore */ }
        }

        this._sessions.set(key, session);
        this._setupSessionEvents(key, session);

        this.emit('sessionConnected', key, session);
    }

    /**
     * 设置会话事件监听
     */
    private _setupSessionEvents(key: string, session: UDPSession): void {
        session.on('data', (data: Buffer) => {
            this.emit('data', key, data);
        });

        session.on('close', () => {
            console.log(`KCP session closed: ${key}`);
            this._sessions.delete(key);
            this.emit('sessionClosed', key);
        });

        session.on('error', (err: Error) => {
            console.error(`KCP session error (${key}):`, err);
            this.emit('sessionError', key, err);
        });
    }
}
