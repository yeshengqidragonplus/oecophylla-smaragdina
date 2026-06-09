import * as dgram from 'dgram';
import * as os from 'os';
import * as events from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { KcpTransport } from './kcpTransport';

export interface PeerInfo {
    id: string;
    hostname: string;
    nickname?: string;
    ip: string;
    port: number;
    kcpPort: number;
    kcpSessionKey?: string;
    lastSeen: number;
    status: 'online' | 'offline';
}

export interface NetworkMessage {
    type: 'message' | 'file' | 'handshake_request' | 'handshake_response' | 'file_chunk' | 'file_progress' | 'kcp_offer' | 'kcp_accept';
    from: string;
    to?: string;
    content?: string;
    timestamp: number;
    file?: {
        name: string;
        size: number;
        data?: string;
        chunkIndex?: number;
        totalChunks?: number;
    };
    progress?: {
        transferred: number;
        total: number;
        percentage: number;
    };
    conv?: number;
    kcpPort?: number;
}

export interface TransferTask {
    id: string;
    peerId: string;
    peerIp: string;
    peerPort: number;
    messages: string[];
    files: { name: string; content: string; size: number }[];
    status: 'pending' | 'handshaking' | 'transferring' | 'completed' | 'failed' | 'timeout';
    progress: number;
    totalBytes: number;
    transferredBytes: number;
    createdAt: number;
    completedAt?: number;
    errorMessage?: string;
}

export class NetworkService extends events.EventEmitter {
    private _udpServer: dgram.Socket | null = null;
    private _port: number = 8080;
    private _hostname: string;
    private _nickname?: string;
    private _peers: Map<string, PeerInfo> = new Map();
    private _isRunning: boolean = false;
    private _transferTasks: Map<string, TransferTask> = new Map();
    private _handshakeCallbacks: Map<string, { resolve: () => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }> = new Map();
    private _kcpTransport: KcpTransport;

    constructor() {
        super();
        this._hostname = os.hostname();
        this._kcpTransport = new KcpTransport(this._port);
        this._setupKcpEvents();
    }

    /**
     * 设置 KCP 传输层事件监听
     * KCP 通道处理所有业务消息（聊天、文件等）
     */
    private _setupKcpEvents(): void {
        this._kcpTransport.on('data', (key: string, data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString()) as NetworkMessage;
                msg.from = key;
                this.emit('message', msg);
            } catch (err) {
                console.error('Failed to parse KCP message:', err);
            }
        });

        this._kcpTransport.on('sessionConnected', (key: string) => {
            console.log(`KCP session connected: ${key}`);
            const peer = this._peers.get(key);
            if (peer) {
                peer.kcpSessionKey = key;
            }
        });

        this._kcpTransport.on('sessionClosed', (key: string) => {
            console.log(`KCP session closed: ${key}`);
            const peer = this._peers.get(key);
            if (peer) {
                peer.kcpSessionKey = undefined;
            }
        });
    }

    get kcpTransport(): KcpTransport {
        return this._kcpTransport;
    }

    public async start(port: number, nickname?: string, peersFilePath?: string): Promise<void> {
        this._port = port;
        this._nickname = nickname;
        this._isRunning = true;

        if (peersFilePath) {
            this._loadPeersFromFile(peersFilePath);
        }

        this._kcpTransport = new KcpTransport(this._port);
        this._setupKcpEvents();

        try {
            await this._kcpTransport.start();
        } catch (err) {
            console.error('Failed to start KCP transport:', err);
        }

        return new Promise((resolve, reject) => {
            try {
                this._udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

                this._udpServer.on('error', (err) => {
                    console.error('UDP Server error:', err);
                    this.emit('error', err);
                    reject(err);
                });

                this._udpServer.on('message', (msg, rinfo) => {
                    this._handleMessage(msg, rinfo);
                });

                this._udpServer.on('listening', () => {
                    console.log(`UDP Server listening on port ${port}`);
                    resolve();
                });

                this._udpServer.bind(port);
            } catch (err) {
                reject(err);
            }
        });
    }

    private _loadPeersFromFile(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                const peersArray = JSON.parse(data) as PeerInfo[];
                peersArray.forEach(peer => {
                    const peerId = `${peer.ip}:${peer.port}`;
                    this._peers.set(peerId, {
                        ...peer,
                        id: peerId,
                        lastSeen: Date.now(),
                        status: 'offline'
                    });
                });
                console.log(`Loaded ${peersArray.length} peers from ${filePath}`);
                this.emit('peersUpdate', Array.from(this._peers.values()));
            }
        } catch (err) {
            console.error('Failed to load peers from file:', err);
        }
    }

    public stop(): void {
        this._isRunning = false;

        this._handshakeCallbacks.forEach((callback) => {
            clearTimeout(callback.timeout);
        });
        this._handshakeCallbacks.clear();

        this._peers.forEach(peer => {
            peer.kcpSessionKey = undefined;
        });

        this._kcpTransport.stop();

        if (this._udpServer) {
            this._udpServer.close();
            this._udpServer = null;
        }

        this._peers.forEach(peer => {
            peer.status = 'offline';
        });
        this.emit('peersUpdate', Array.from(this._peers.values()));
    }

    /**
     * UDP 通道仅处理发现/握手消息
     */
    private _handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        try {
            const data = JSON.parse(msg.toString());
            const peerIp = rinfo.address;
            const peerPort = rinfo.port;
            const peerId = `${peerIp}:${peerPort}`;

            if (peerIp === this.getLocalIp()) {
                return;
            }

            switch (data.type) {
                case 'handshake_request':
                    this._handleHandshakeRequest(data, peerIp, peerPort);
                    break;
                case 'handshake_response':
                    this._handleHandshakeResponse(data, peerId);
                    break;
                default:
                    break;
            }
        } catch (err) {
            console.error('Failed to parse UDP message:', err);
        }
    }

    /**
     * 确保与指定 peer 建立了 KCP 会话
     */
    private async _ensureKcpSession(peerId: string): Promise<string> {
        const peer = this._peers.get(peerId);
        if (!peer) {
            throw new Error(`Peer ${peerId} not found`);
        }

        if (peer.kcpSessionKey && this._kcpTransport.hasSession(peer.kcpSessionKey)) {
            return peer.kcpSessionKey;
        }

        const { key } = await this._kcpTransport.connectToPeer(peer.ip, peer.kcpPort);
        peer.kcpSessionKey = key;
        return key;
    }

    private _handleHandshakeRequest(data: NetworkMessage, ip: string, port: number): void {
        const peerId = `${ip}:${port}`;
        const kcpPort = data.kcpPort || (port + 1000);

        const existingPeer = this._peers.get(peerId);
        if (existingPeer) {
            existingPeer.lastSeen = Date.now();
            existingPeer.status = 'online';
            existingPeer.kcpPort = kcpPort;
        } else {
            const peerInfo: PeerInfo = {
                id: peerId,
                hostname: data.from || ip,
                ip: ip,
                port: port,
                kcpPort: kcpPort,
                lastSeen: Date.now(),
                status: 'online'
            };
            this._peers.set(peerId, peerInfo);
        }

        this.emit('peersUpdate', Array.from(this._peers.values()));

        const response: NetworkMessage = {
            type: 'handshake_response',
            from: this.getLocalIp(),
            to: peerId,
            timestamp: Date.now(),
            kcpPort: this._kcpTransport.port
        };
        this._sendTo(ip, port, response);

        // 主动建立到对端的 KCP 连接
        this._ensureKcpSession(peerId).catch(err => {
            console.error(`Failed to establish KCP session to ${peerId}:`, err);
        });
    }

    private _handleHandshakeResponse(data: NetworkMessage, peerId: string): void {
        const callback = this._handshakeCallbacks.get(peerId);
        if (callback) {
            clearTimeout(callback.timeout);
            this._handshakeCallbacks.delete(peerId);
            callback.resolve();
        }

        if (data.kcpPort) {
            const peer = this._peers.get(peerId);
            if (peer) {
                peer.kcpPort = data.kcpPort;
            }
        }

        // 握手成功后建立 KCP 连接
        this._ensureKcpSession(peerId).catch(err => {
            console.error(`Failed to establish KCP session to ${peerId}:`, err);
        });
    }

    /**
     * 发送握手请求，5 秒超时（通过 UDP）
     */
    public async sendHandshake(peerId: string): Promise<boolean> {
        const peer = this._peers.get(peerId);
        if (!peer) {
            console.error(`Peer ${peerId} not found`);
            return false;
        }

        return new Promise((resolve, reject) => {
            const request: NetworkMessage = {
                type: 'handshake_request',
                from: this.getLocalIp(),
                to: peerId,
                timestamp: Date.now(),
                kcpPort: this._kcpTransport.port
            };

            const timeout = setTimeout(() => {
                this._handshakeCallbacks.delete(peerId);
                console.log(`Handshake timeout for peer ${peerId}`);
                resolve(false);
            }, 5000);

            this._handshakeCallbacks.set(peerId, { resolve: () => { resolve(true); }, reject, timeout });
            this._sendTo(peer.ip, peer.port, request);
        });
    }

    /**
     * 通过 KCP 发送消息到指定 peer
     */
    private async _sendViaKcp(peerId: string, message: NetworkMessage): Promise<void> {
        const sessionKey = await this._ensureKcpSession(peerId);
        const data = Buffer.from(JSON.stringify(message));
        await this._kcpTransport.send(sessionKey, data);
    }

    public createTransferTask(
        peerId: string,
        messages: string[],
        files: { name: string; content: string; size: number }[]
    ): TransferTask {
        const peer = this._peers.get(peerId);
        if (!peer) {
            throw new Error(`Peer ${peerId} not found`);
        }

        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
        const taskId = `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const task: TransferTask = {
            id: taskId,
            peerId,
            peerIp: peer.ip,
            peerPort: peer.port,
            messages,
            files,
            status: 'pending',
            progress: 0,
            totalBytes,
            transferredBytes: 0,
            createdAt: Date.now()
        };

        this._transferTasks.set(taskId, task);
        this.emit('transferTaskCreated', task);
        return task;
    }

    /**
     * 执行传输任务，所有消息通过 KCP 可靠传输
     */
    public async executeTransferTask(taskId: string): Promise<void> {
        const task = this._transferTasks.get(taskId);
        if (!task) {
            throw new Error(`Transfer task ${taskId} not found`);
        }

        task.status = 'handshaking';
        this.emit('transferTaskUpdated', task);

        const handshakeSuccess = await this.sendHandshake(task.peerId);
        if (!handshakeSuccess) {
            task.status = 'timeout';
            task.errorMessage = '握手超时，对方可能不在线';
            this.emit('transferTaskUpdated', task);
            this.emit('transferTaskFailed', task);
            throw new Error('Handshake timeout');
        }

        task.status = 'transferring';
        this.emit('transferTaskUpdated', task);

        try {
            await this._ensureKcpSession(task.peerId);

            for (const message of task.messages) {
                const msg: NetworkMessage = {
                    type: 'message',
                    from: this.getLocalIp(),
                    to: task.peerId,
                    content: message,
                    timestamp: Date.now()
                };
                await this._sendViaKcp(task.peerId, msg);
            }

            for (const file of task.files) {
                await this._sendFileViaKcp(task, file);
            }

            task.status = 'completed';
            task.completedAt = Date.now();
            task.progress = 100;
            this.emit('transferTaskUpdated', task);
            this.emit('transferTaskCompleted', task);
        } catch (err) {
            task.status = 'failed';
            task.errorMessage = (err as Error).message;
            this.emit('transferTaskUpdated', task);
            this.emit('transferTaskFailed', task);
            throw err;
        }
    }

    private async _sendFileViaKcp(task: TransferTask, file: { name: string; content: string; size: number }): Promise<void> {
        const fileMsg: NetworkMessage = {
            type: 'file',
            from: this.getLocalIp(),
            to: task.peerId,
            timestamp: Date.now(),
            file: {
                name: file.name,
                size: file.size,
                data: file.content
            }
        };

        await this._sendViaKcp(task.peerId, fileMsg);

        task.transferredBytes += file.size;
        task.progress = Math.floor((task.transferredBytes / task.totalBytes) * 100);
        this.emit('transferTaskUpdated', task);
    }

    /**
     * 通过 UDP 发送（仅用于握手消息）
     */
    private _sendTo(ip: string, port: number, message: NetworkMessage): void {
        if (!this._udpServer) {
            return;
        }
        const messageBuffer = Buffer.from(JSON.stringify(message));
        this._udpServer.send(messageBuffer, 0, messageBuffer.length, port, ip);
    }

    /**
     * 发送消息到指定 peer（通过 KCP 可靠传输）
     */
    public async sendToPeer(peerId: string, message: NetworkMessage): Promise<void> {
        const peer = this._peers.get(peerId);
        if (!peer) {
            console.error(`Peer ${peerId} not found`);
            return;
        }
        await this._sendViaKcp(peerId, message);
    }

    public getTransferTasks(): TransferTask[] {
        return Array.from(this._transferTasks.values());
    }

    public getTransferTask(taskId: string): TransferTask | undefined {
        return this._transferTasks.get(taskId);
    }

    public isRunning(): boolean {
        return this._isRunning;
    }

    public getPeers(): PeerInfo[] {
        return Array.from(this._peers.values());
    }

    public getLocalIp(): string {
        const interfaces = os.networkInterfaces();

        for (const name of Object.keys(interfaces)) {
            const iface = interfaces[name];
            if (!iface) { continue; }

            for (const addr of iface) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }

        return '127.0.0.1';
    }
}

export const networkService = new NetworkService();
