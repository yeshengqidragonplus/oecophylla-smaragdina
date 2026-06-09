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
    type: 'message' | 'file' | 'handshake_request' | 'handshake_response'
        | 'kcp_offer' | 'kcp_accept'
        | 'discovery_request' | 'discovery_response'
        | 'heartbeat' | 'heartbeat_ack';
    from: string;
    fromHostname?: string;
    fromNickname?: string;
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

/** 心跳超时（毫秒），超过此时间未收到心跳则标记离线 */
const HEARTBEAT_TIMEOUT = 90_000;
/** 心跳发送间隔（毫秒） */
const HEARTBEAT_INTERVAL = 30_000;
/** 广播发现间隔（毫秒） */
const DISCOVERY_INTERVAL = 60_000;

export class NetworkService extends events.EventEmitter {
    private _udpServer: dgram.Socket | null = null;
    private _port: number = 8080;
    private _hostname: string;
    private _nickname?: string;
    private _peers: Map<string, PeerInfo> = new Map();
    private _isRunning: boolean = false;
    private _transferTasks: Map<string, TransferTask> = new Map();
    private _handshakeCallbacks: Map<string, { resolve: () => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }> = new Map();
    private _kcpTransport: KcpTransport | null = null;

    // 心跳追踪
    private _heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
    private _heartbeatIntervalTimer: NodeJS.Timeout | null = null;
    private _discoveryIntervalTimer: NodeJS.Timeout | null = null;

    constructor() {
        super();
        this._hostname = os.hostname();
        // 修复：不再在构造函数中创建 KcpTransport，延迟到 start() 中创建
    }

    get kcpTransport(): KcpTransport | null {
        return this._kcpTransport;
    }

    public async start(port: number, nickname?: string, peersFilePath?: string): Promise<void> {
        this._port = port;
        this._nickname = nickname;
        this._isRunning = true;

        if (peersFilePath) {
            this._loadPeersFromFile(peersFilePath);
        }

        // 修复：如果已有旧 KcpTransport 实例，先清理事件监听再创建新的
        if (this._kcpTransport) {
            this._kcpTransport.removeAllListeners();
            this._kcpTransport.stop();
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
                    // 启用广播
                    try {
                        this._udpServer!.setBroadcast(true);
                    } catch (_) { /* ignore */ }

                    console.log(`UDP Server listening on port ${port}`);

                    // 启动后立即发送一次广播发现
                    this._sendDiscoveryBroadcast();

                    // 启动定时广播发现
                    this._discoveryIntervalTimer = setInterval(() => {
                        this._sendDiscoveryBroadcast();
                    }, DISCOVERY_INTERVAL);

                    // 启动心跳检测
                    this._startHeartbeat();

                    resolve();
                });

                this._udpServer.bind(port);
            } catch (err) {
                reject(err);
            }
        });
    }

    // ==================== 广播自动发现 ====================

    /**
     * 发送 UDP 广播发现请求
     */
    private _sendDiscoveryBroadcast(): void {
        if (!this._udpServer || !this._isRunning) {
            return;
        }

        const message: NetworkMessage = {
            type: 'discovery_request',
            from: this.getLocalIp(),
            fromHostname: this._hostname,
            fromNickname: this._nickname,
            timestamp: Date.now(),
            kcpPort: this._kcpTransport?.port || (this._port + 1000)
        };

        const buffer = Buffer.from(JSON.stringify(message));

        // 向广播地址发送
        try {
            this._udpServer.send(buffer, 0, buffer.length, this._port, '255.255.255.255');
        } catch (err) {
            console.error('Failed to send discovery broadcast:', err);
        }

        // 也向子网广播地址发送
        const subnetBroadcast = this._getSubnetBroadcast();
        if (subnetBroadcast) {
            try {
                this._udpServer.send(buffer, 0, buffer.length, this._port, subnetBroadcast);
            } catch (err) {
                console.error(`Failed to send discovery to ${subnetBroadcast}:`, err);
            }
        }
    }

    /**
     * 获取子网广播地址（如 192.168.1.255）
     */
    private _getSubnetBroadcast(): string | null {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            const iface = interfaces[name];
            if (!iface) { continue; }
            for (const addr of iface) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    const parts = addr.address.split('.');
                    const netmask = addr.netmask || '255.255.255.0';
                    const maskParts = netmask.split('.');
                    const broadcast = parts.map((part, i) => {
                        if (maskParts[i] === '255') {
                            return part;
                        }
                        return '255';
                    }).join('.');
                    return broadcast;
                }
            }
        }
        return null;
    }

    /**
     * 处理发现请求 - 回复自己的信息
     */
    private _handleDiscoveryRequest(msg: NetworkMessage, ip: string, port: number): void {
        // 不回复自己
        if (ip === this.getLocalIp() && port === this._port) {
            return;
        }

        const response: NetworkMessage = {
            type: 'discovery_response',
            from: this.getLocalIp(),
            fromHostname: this._hostname,
            fromNickname: this._nickname,
            to: `${ip}:${port}`,
            timestamp: Date.now(),
            kcpPort: this._kcpTransport?.port || (this._port + 1000)
        };

        this._sendTo(ip, port, response);

        // 同时将对方加入 peers（如果还没有）
        const peerId = `${ip}:${port}`;
        if (!this._peers.has(peerId)) {
            const peerInfo: PeerInfo = {
                id: peerId,
                hostname: msg.fromHostname || ip,
                nickname: msg.fromNickname,
                ip: ip,
                port: port,
                kcpPort: msg.kcpPort || (port + 1000),
                lastSeen: Date.now(),
                status: 'online'
            };
            this._peers.set(peerId, peerInfo);
            this.emit('peersUpdate', Array.from(this._peers.values()));
            console.log(`[Discovery] New peer found: ${peerId}`);
        }
    }

    /**
     * 处理发现响应
     */
    private _handleDiscoveryResponse(msg: NetworkMessage, ip: string, port: number): void {
        const peerId = `${ip}:${port}`;

        // 不处理自己
        if (ip === this.getLocalIp() && port === this._port) {
            return;
        }

        const existingPeer = this._peers.get(peerId);
        if (existingPeer) {
            existingPeer.lastSeen = Date.now();
            existingPeer.status = 'online';
            existingPeer.kcpPort = msg.kcpPort || (port + 1000);
            if (msg.fromNickname) {
                existingPeer.nickname = msg.fromNickname;
            }
            if (msg.fromHostname) {
                existingPeer.hostname = msg.fromHostname;
            }
        } else {
            const peerInfo: PeerInfo = {
                id: peerId,
                hostname: msg.fromHostname || ip,
                nickname: msg.fromNickname,
                ip: ip,
                port: port,
                kcpPort: msg.kcpPort || (port + 1000),
                lastSeen: Date.now(),
                status: 'online'
            };
            this._peers.set(peerId, peerInfo);
            console.log(`[Discovery] Peer discovered: ${peerId}`);
        }

        this.emit('peersUpdate', Array.from(this._peers.values()));
    }

    // ==================== 心跳检测 ====================

    /**
     * 启动心跳定时器
     */
    private _startHeartbeat(): void {
        // 清除旧定时器
        if (this._heartbeatIntervalTimer) {
            clearInterval(this._heartbeatIntervalTimer);
        }

        this._heartbeatIntervalTimer = setInterval(() => {
            this._sendHeartbeats();
            this._checkPeerLiveness();
        }, HEARTBEAT_INTERVAL);
    }

    /**
     * 向所有已知 peer 发送心跳
     */
    private _sendHeartbeats(): void {
        if (!this._udpServer || !this._isRunning) {
            return;
        }

        const now = Date.now();
        this._peers.forEach((peer, peerId) => {
            // 只向曾经在线的 peer 发送心跳
            if (peer.status === 'online' || (now - peer.lastSeen < HEARTBEAT_TIMEOUT * 2)) {
                const heartbeat: NetworkMessage = {
                    type: 'heartbeat',
                    from: this.getLocalIp(),
                    fromHostname: this._hostname,
                    fromNickname: this._nickname,
                    to: peerId,
                    timestamp: now,
                    kcpPort: this._kcpTransport?.port || (this._port + 1000)
                };
                this._sendTo(peer.ip, peer.port, heartbeat);
            }
        });
    }

    /**
     * 检查 peer 是否超时离线
     */
    private _checkPeerLiveness(): void {
        const now = Date.now();
        let changed = false;

        this._peers.forEach((peer, peerId) => {
            if (peer.status === 'online' && (now - peer.lastSeen > HEARTBEAT_TIMEOUT)) {
                peer.status = 'offline';
                peer.kcpSessionKey = undefined;
                console.log(`[Heartbeat] Peer ${peerId} timed out, marked offline`);
                changed = true;
            }
        });

        if (changed) {
            this.emit('peersUpdate', Array.from(this._peers.values()));
        }
    }

    /**
     * 处理收到的心跳
     */
    private _handleHeartbeat(msg: NetworkMessage, ip: string, port: number): void {
        const peerId = `${ip}:${port}`;

        // 不处理自己
        if (ip === this.getLocalIp() && port === this._port) {
            return;
        }

        const peer = this._peers.get(peerId);
        if (peer) {
            const wasOffline = peer.status === 'offline';
            peer.lastSeen = Date.now();
            peer.status = 'online';
            peer.kcpPort = msg.kcpPort || (port + 1000);
            if (msg.fromNickname) {
                peer.nickname = msg.fromNickname;
            }
            if (msg.fromHostname) {
                peer.hostname = msg.fromHostname;
            }

            if (wasOffline) {
                console.log(`[Heartbeat] Peer ${peerId} came back online`);
                this.emit('peersUpdate', Array.from(this._peers.values()));
            }
        } else {
            // 未知 peer 发来心跳，加入列表
            const peerInfo: PeerInfo = {
                id: peerId,
                hostname: msg.fromHostname || ip,
                nickname: msg.fromNickname,
                ip: ip,
                port: port,
                kcpPort: msg.kcpPort || (port + 1000),
                lastSeen: Date.now(),
                status: 'online'
            };
            this._peers.set(peerId, peerInfo);
            console.log(`[Heartbeat] New peer discovered via heartbeat: ${peerId}`);
            this.emit('peersUpdate', Array.from(this._peers.values()));
        }

        // 回复心跳确认
        const ack: NetworkMessage = {
            type: 'heartbeat_ack',
            from: this.getLocalIp(),
            fromHostname: this._hostname,
            fromNickname: this._nickname,
            to: peerId,
            timestamp: Date.now(),
            kcpPort: this._kcpTransport?.port || (this._port + 1000)
        };
        this._sendTo(ip, port, ack);
    }

    /**
     * 处理心跳确认
     */
    private _handleHeartbeatAck(msg: NetworkMessage, ip: string, port: number): void {
        const peerId = `${ip}:${port}`;

        if (ip === this.getLocalIp() && port === this._port) {
            return;
        }

        const peer = this._peers.get(peerId);
        if (peer) {
            const wasOffline = peer.status === 'offline';
            peer.lastSeen = Date.now();
            peer.status = 'online';
            peer.kcpPort = msg.kcpPort || (port + 1000);

            if (wasOffline) {
                console.log(`[Heartbeat] Peer ${peerId} acknowledged, back online`);
                this.emit('peersUpdate', Array.from(this._peers.values()));
            }
        }
    }

    // ==================== KCP 事件设置 ====================

    /**
     * 设置 KCP 传输层事件监听
     * KCP 通道处理所有业务消息（聊天、文件等）
     */
    private _setupKcpEvents(): void {
        if (!this._kcpTransport) {
            return;
        }

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

    // ==================== 消息处理 ====================

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

        // 停止定时器
        if (this._heartbeatIntervalTimer) {
            clearInterval(this._heartbeatIntervalTimer);
            this._heartbeatIntervalTimer = null;
        }
        if (this._discoveryIntervalTimer) {
            clearInterval(this._discoveryIntervalTimer);
            this._discoveryIntervalTimer = null;
        }
        this._heartbeatTimers.forEach(timer => clearTimeout(timer));
        this._heartbeatTimers.clear();

        this._handshakeCallbacks.forEach((callback) => {
            clearTimeout(callback.timeout);
        });
        this._handshakeCallbacks.clear();

        this._peers.forEach(peer => {
            peer.kcpSessionKey = undefined;
        });

        if (this._kcpTransport) {
            this._kcpTransport.removeAllListeners();
            this._kcpTransport.stop();
            this._kcpTransport = null;
        }

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
     * UDP 通道仅处理发现/心跳/握手消息
     */
    private _handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        try {
            const data = JSON.parse(msg.toString());
            const peerIp = rinfo.address;
            const peerPort = rinfo.port;

            if (peerIp === this.getLocalIp()) {
                return;
            }

            switch (data.type) {
                case 'discovery_request':
                    this._handleDiscoveryRequest(data, peerIp, peerPort);
                    break;
                case 'discovery_response':
                    this._handleDiscoveryResponse(data, peerIp, peerPort);
                    break;
                case 'heartbeat':
                    this._handleHeartbeat(data, peerIp, peerPort);
                    break;
                case 'heartbeat_ack':
                    this._handleHeartbeatAck(data, peerIp, peerPort);
                    break;
                case 'handshake_request':
                    this._handleHandshakeRequest(data, peerIp, peerPort);
                    break;
                case 'handshake_response':
                    this._handleHandshakeResponse(data, `${peerIp}:${peerPort}`);
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

        if (peer.kcpSessionKey && this._kcpTransport && this._kcpTransport.hasSession(peer.kcpSessionKey)) {
            return peer.kcpSessionKey;
        }

        if (!this._kcpTransport) {
            throw new Error('KCP transport not initialized');
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
            kcpPort: this._kcpTransport?.port || (this._port + 1000)
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
                kcpPort: this._kcpTransport?.port || (this._port + 1000)
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
        if (!this._kcpTransport) {
            throw new Error('KCP transport not initialized');
        }
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
     * 通过 UDP 发送（仅用于握手/发现/心跳消息）
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
