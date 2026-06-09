import * as dgram from 'dgram';
import * as os from 'os';
import * as events from 'events';
import * as fs from 'fs';
import * as path from 'path';

export interface PeerInfo {
    id: string;
    hostname: string;
    nickname?: string;
    ip: string;
    port: number;
    lastSeen: number;
    status: 'online' | 'offline';
}

export interface NetworkMessage {
    type: 'message' | 'file' | 'handshake_request' | 'handshake_response' | 'file_chunk' | 'file_progress';
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

    constructor() {
        super();
        this._hostname = os.hostname();
    }

    public async start(port: number, nickname?: string, peersFilePath?: string): Promise<void> {
        this._port = port;
        this._nickname = nickname;
        this._isRunning = true;

        // 从配置文件加载 peers
        if (peersFilePath) {
            this._loadPeersFromFile(peersFilePath);
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
                        status: 'offline' // 初始状态为离线，握手后变为在线
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
        
        // 清除所有握手回调
        this._handshakeCallbacks.forEach((callback) => {
            clearTimeout(callback.timeout);
        });
        this._handshakeCallbacks.clear();

        if (this._udpServer) {
            this._udpServer.close();
            this._udpServer = null;
        }

        // 标记所有 peers 为离线
        this._peers.forEach(peer => {
            peer.status = 'offline';
        });
        this.emit('peersUpdate', Array.from(this._peers.values()));
    }

    private _handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        try {
            const data = JSON.parse(msg.toString());
            const peerIp = rinfo.address;
            const peerPort = rinfo.port;
            const peerId = `${peerIp}:${peerPort}`;

            // 不处理自己的消息
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
                case 'message':
                case 'file':
                case 'file_chunk':
                case 'file_progress':
                    this.emit('message', data as NetworkMessage);
                    break;
            }
        } catch (err) {
            console.error('Failed to parse message:', err);
        }
    }

    private _handleHandshakeRequest(data: NetworkMessage, ip: string, port: number): void {
        const peerId = `${ip}:${port}`;
        
        // 更新 peer 状态为在线
        const existingPeer = this._peers.get(peerId);
        if (existingPeer) {
            existingPeer.lastSeen = Date.now();
            existingPeer.status = 'online';
        } else {
            const peerInfo: PeerInfo = {
                id: peerId,
                hostname: data.from || ip,
                ip: ip,
                port: port,
                lastSeen: Date.now(),
                status: 'online'
            };
            this._peers.set(peerId, peerInfo);
        }
        
        this.emit('peersUpdate', Array.from(this._peers.values()));

        // 发送响应
        const response: NetworkMessage = {
            type: 'handshake_response',
            from: this.getLocalIp(),
            to: peerId,
            timestamp: Date.now()
        };
        this._sendTo(ip, port, response);
    }

    private _handleHandshakeResponse(data: NetworkMessage, peerId: string): void {
        const callback = this._handshakeCallbacks.get(peerId);
        if (callback) {
            clearTimeout(callback.timeout);
            this._handshakeCallbacks.delete(peerId);
            callback.resolve();
        }
    }

    /**
     * 发送握手请求，5 秒超时
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
                timestamp: Date.now()
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
     * 创建传输任务
     */
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
     * 执行传输任务
     */
    public async executeTransferTask(taskId: string): Promise<void> {
        const task = this._transferTasks.get(taskId);
        if (!task) {
            throw new Error(`Transfer task ${taskId} not found`);
        }

        task.status = 'handshaking';
        this.emit('transferTaskUpdated', task);

        // 先发送握手请求
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
            // 发送消息
            for (const message of task.messages) {
                const msg: NetworkMessage = {
                    type: 'message',
                    from: this.getLocalIp(),
                    to: task.peerId,
                    content: message,
                    timestamp: Date.now()
                };
                this._sendTo(task.peerIp, task.peerPort, msg);
            }

            // 发送文件
            for (const file of task.files) {
                await this._sendFileInChunks(task, file);
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

    private async _sendFileInChunks(task: TransferTask, file: { name: string; content: string; size: number }): Promise<void> {
        const chunkSize = 1024; // 1KB per chunk
        const totalChunks = Math.ceil(file.content.length / chunkSize);

        for (let i = 0; i < totalChunks; i++) {
            const chunk = file.content.substr(i * chunkSize, chunkSize);
            const msg: NetworkMessage = {
                type: 'file_chunk',
                from: this.getLocalIp(),
                to: task.peerId,
                timestamp: Date.now(),
                file: {
                    name: file.name,
                    size: file.size,
                    chunkIndex: i,
                    totalChunks: totalChunks,
                    data: chunk
                }
            };
            this._sendTo(task.peerIp, task.peerPort, msg);
            
            task.transferredBytes += Buffer.byteLength(chunk);
            task.progress = Math.floor((task.transferredBytes / task.totalBytes) * 100);
            this.emit('transferTaskUpdated', task);

            // 发送进度更新
            const progressMsg: NetworkMessage = {
                type: 'file_progress',
                from: this.getLocalIp(),
                to: task.peerId,
                timestamp: Date.now(),
                progress: {
                    transferred: task.transferredBytes,
                    total: task.totalBytes,
                    percentage: task.progress
                }
            };
            this._sendTo(task.peerIp, task.peerPort, progressMsg);

            // 小延迟避免发送过快
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    private _sendTo(ip: string, port: number, message: NetworkMessage): void {
        if (!this._udpServer) {
            return;
        }
        const messageBuffer = Buffer.from(JSON.stringify(message));
        this._udpServer.send(messageBuffer, 0, messageBuffer.length, port, ip);
    }

    public sendToPeer(peerId: string, message: NetworkMessage): void {
        const peer = this._peers.get(peerId);
        if (!peer) {
            console.error(`Peer ${peerId} not found`);
            return;
        }
        this._sendTo(peer.ip, peer.port, message);
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
