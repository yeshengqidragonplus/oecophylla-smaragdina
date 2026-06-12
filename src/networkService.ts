import * as dgram from 'dgram';
import * as os from 'os';
import * as events from 'events';
import * as fs from 'fs';
import { KcpTransport } from './kcpTransport';
import { log, logError } from './logger';

export interface PeerInfo {
    id: string;
    hostname: string;
    nickname?: string;
    ip: string;
    port: number;
    /** 对端业务消息（KCP）端口 */
    transferPort: number;
    lastSeen: number;
    status: 'online' | 'offline';
}

export interface NetworkMessage {
    type: 'message' | 'file'
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
    transferPort?: number;
}

export interface TransferTask {
    id: string;
    peerId: string;
    peerIp: string;
    peerPort: number;
    messages: string[];
    files: { name: string; path: string; size: number }[];
    status: 'pending' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'timeout';
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
/**
 * 固定发现端口：所有实例额外用 reuseAddr 共享绑定此端口接收广播，
 * 这样同一台机器上主端口不同的多个实例也能互相发现。
 * 应答通过单播回到请求方的主端口。
 */
const DISCOVERY_PORT = 41320;
/** 文件分块大小（原始字节，发送时转 base64） */
const FILE_CHUNK_SIZE = 64 * 1024;
/** KCP 握手建连超时（毫秒） */
const CONNECT_TIMEOUT = 5_000;

export class NetworkService extends events.EventEmitter {
    private _udpServer: dgram.Socket | null = null;
    /** 共享发现端口的监听 socket（仅接收 discovery_request） */
    private _discoverySocket: dgram.Socket | null = null;
    private _port: number = 8080;
    private _hostname: string;
    private _nickname?: string;
    private _peers: Map<string, PeerInfo> = new Map();
    private _isRunning: boolean = false;
    private _transferTasks: Map<string, TransferTask> = new Map();
    private _transport: KcpTransport | null = null;

    /** 本机所有 IPv4 地址（含回环），用于过滤自己发出的广播 */
    private _localIps: Set<string> = new Set();
    private _localIp: string = '127.0.0.1';

    private _heartbeatIntervalTimer: NodeJS.Timeout | null = null;
    private _discoveryIntervalTimer: NodeJS.Timeout | null = null;

    constructor() {
        super();
        this._hostname = os.hostname();
    }

    get transport(): KcpTransport | null {
        return this._transport;
    }

    public async start(port: number, nickname?: string, peersFilePath?: string): Promise<void> {
        if (this._isRunning) {
            this.stop();
        }

        this._port = port;
        this._nickname = nickname;
        this._refreshLocalIps();

        if (peersFilePath) {
            this._loadPeersFromFile(peersFilePath);
        }

        // 启动 KCP 传输层（业务消息通道）
        this._transport = new KcpTransport(this._port);
        this._transport.setLocalId(this._localPeerId());
        this._setupTransportEvents();

        try {
            await this._transport.start();
        } catch (err) {
            this._transport.removeAllListeners();
            this._transport.stop();
            this._transport = null;
            throw new Error(`KCP 传输层启动失败（端口 ${this._port + 1000}）: ${(err as Error).message}`);
        }

        // 启动主 UDP 通道（发现/心跳）
        try {
            await this._startUdpServer(port);
        } catch (err) {
            this._transport.removeAllListeners();
            this._transport.stop();
            this._transport = null;
            throw err;
        }

        // 绑定共享发现端口（失败不致命，只是无法被广播发现）
        this._startDiscoverySocket();

        this._isRunning = true;

        // 启动后立即发送一次广播发现
        this._sendDiscoveryBroadcast();

        this._discoveryIntervalTimer = setInterval(() => {
            this._sendDiscoveryBroadcast();
        }, DISCOVERY_INTERVAL);

        this._startHeartbeat();
    }

    private _startUdpServer(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            udpServer.on('error', (err) => {
                logError('UDP Server error:', err);
                if (!settled) {
                    settled = true;
                    udpServer.close();
                    reject(err);
                } else {
                    this.emit('error', err);
                }
            });

            udpServer.on('message', (msg, rinfo) => {
                this._handleMessage(msg, rinfo);
            });

            udpServer.on('listening', () => {
                try {
                    udpServer.setBroadcast(true);
                } catch (_) { /* ignore */ }
                log(`UDP Server listening on port ${port}`);
                settled = true;
                this._udpServer = udpServer;
                resolve();
            });

            udpServer.bind(port);
        });
    }

    /**
     * 监听共享发现端口。多个实例通过 reuseAddr 共享绑定，
     * 广播包会投递给所有绑定者，从而支持同机多实例发现。
     */
    private _startDiscoverySocket(): void {
        try {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            socket.on('error', err => {
                logError('Discovery socket error:', err.message);
            });
            socket.on('message', (msg, rinfo) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.type === 'discovery_request' && !this._isSelf(rinfo.address, rinfo.port)) {
                        // rinfo.port 是请求方的主端口（从主 socket 发出）
                        this._handleDiscoveryRequest(data, rinfo.address, rinfo.port);
                    }
                } catch (_) { /* ignore */ }
            });
            socket.bind(DISCOVERY_PORT, () => {
                log(`Discovery socket listening on shared port ${DISCOVERY_PORT}`);
            });
            this._discoverySocket = socket;
        } catch (err) {
            logError('Failed to bind discovery socket:', err);
        }
    }

    // ==================== 广播自动发现 ====================

    /**
     * 发送 UDP 广播发现请求
     */
    private _sendDiscoveryBroadcast(): void {
        if (!this._udpServer) {
            return;
        }

        const message: NetworkMessage = {
            type: 'discovery_request',
            from: this.getLocalIp(),
            fromHostname: this._hostname,
            fromNickname: this._nickname,
            timestamp: Date.now(),
            transferPort: this._transport?.port || (this._port + 1000)
        };

        const buffer = Buffer.from(JSON.stringify(message));

        // 从主 socket 发出（源端口 = 主端口，对方据此回复），目标为共享发现端口
        try {
            this._udpServer.send(buffer, 0, buffer.length, DISCOVERY_PORT, '255.255.255.255');
        } catch (err) {
            logError('Failed to send discovery broadcast:', err);
        }

        // 也向子网广播地址发送
        const subnetBroadcast = this._getSubnetBroadcast();
        if (subnetBroadcast) {
            try {
                this._udpServer.send(buffer, 0, buffer.length, DISCOVERY_PORT, subnetBroadcast);
            } catch (err) {
                logError(`Failed to send discovery to ${subnetBroadcast}:`, err);
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
        const response: NetworkMessage = {
            type: 'discovery_response',
            from: this.getLocalIp(),
            fromHostname: this._hostname,
            fromNickname: this._nickname,
            to: `${ip}:${port}`,
            timestamp: Date.now(),
            transferPort: this._transport?.port || (this._port + 1000)
        };

        this._sendTo(ip, port, response);
        this._upsertPeerFromUdp(msg, ip, port, 'Discovery');
    }

    /**
     * 处理发现响应
     */
    private _handleDiscoveryResponse(msg: NetworkMessage, ip: string, port: number): void {
        this._upsertPeerFromUdp(msg, ip, port, 'Discovery');
    }

    /**
     * 根据 UDP 消息新建或刷新 peer 信息
     */
    private _upsertPeerFromUdp(msg: NetworkMessage, ip: string, port: number, logTag: string): void {
        const peerId = `${ip}:${port}`;
        const existingPeer = this._peers.get(peerId);

        if (existingPeer) {
            const wasOffline = existingPeer.status === 'offline';
            existingPeer.lastSeen = Date.now();
            existingPeer.status = 'online';
            existingPeer.transferPort = msg.transferPort || (port + 1000);
            if (msg.fromNickname) {
                existingPeer.nickname = msg.fromNickname;
            }
            if (msg.fromHostname) {
                existingPeer.hostname = msg.fromHostname;
            }
            if (wasOffline) {
                log(`[${logTag}] Peer ${peerId} came back online`);
            }
        } else {
            const peerInfo: PeerInfo = {
                id: peerId,
                hostname: msg.fromHostname || ip,
                nickname: msg.fromNickname,
                ip: ip,
                port: port,
                transferPort: msg.transferPort || (port + 1000),
                lastSeen: Date.now(),
                status: 'online'
            };
            this._peers.set(peerId, peerInfo);
            log(`[${logTag}] New peer found: ${peerId}`);
        }

        this.emit('peersUpdate', Array.from(this._peers.values()));
    }

    // ==================== 心跳检测 ====================

    /**
     * 启动心跳定时器
     */
    private _startHeartbeat(): void {
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
        this._peers.forEach((peer) => {
            // 只向在线或刚离线不久的 peer 发送心跳
            if (peer.status === 'online' || (now - peer.lastSeen < HEARTBEAT_TIMEOUT * 2)) {
                const heartbeat: NetworkMessage = {
                    type: 'heartbeat',
                    from: this.getLocalIp(),
                    fromHostname: this._hostname,
                    fromNickname: this._nickname,
                    to: peer.id,
                    timestamp: now,
                    transferPort: this._transport?.port || (this._port + 1000)
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
                log(`[Heartbeat] Peer ${peerId} timed out, marked offline`);
                changed = true;
            }
        });

        if (changed) {
            this.emit('peersUpdate', Array.from(this._peers.values()));
        }
    }

    /**
     * 处理收到的心跳，并回复确认
     */
    private _handleHeartbeat(msg: NetworkMessage, ip: string, port: number): void {
        this._upsertPeerFromUdp(msg, ip, port, 'Heartbeat');

        const ack: NetworkMessage = {
            type: 'heartbeat_ack',
            from: this.getLocalIp(),
            fromHostname: this._hostname,
            fromNickname: this._nickname,
            to: `${ip}:${port}`,
            timestamp: Date.now(),
            transferPort: this._transport?.port || (this._port + 1000)
        };
        this._sendTo(ip, port, ack);
    }

    /**
     * 处理心跳确认
     */
    private _handleHeartbeatAck(msg: NetworkMessage, ip: string, port: number): void {
        this._upsertPeerFromUdp(msg, ip, port, 'Heartbeat');
    }

    // ==================== KCP 传输层事件 ====================

    /**
     * KCP 通道处理所有业务消息（聊天、文件）
     */
    private _setupTransportEvents(): void {
        if (!this._transport) {
            return;
        }

        this._transport.on('data', (peerId: string, data: Buffer) => {
            try {
                const msg = JSON.parse(data.toString()) as NetworkMessage;
                msg.from = peerId;
                this.emit('message', msg);
            } catch (err) {
                logError('Failed to parse KCP message:', err);
            }
        });

        this._transport.on('sessionConnected', (peerId: string) => {
            log(`KCP session connected: ${peerId}`);
            const peer = this._peers.get(peerId);
            if (peer) {
                peer.lastSeen = Date.now();
                if (peer.status === 'offline') {
                    peer.status = 'online';
                    this.emit('peersUpdate', Array.from(this._peers.values()));
                }
            }
        });

        this._transport.on('sessionClosed', (peerId: string) => {
            log(`KCP session closed: ${peerId}`);
        });

        this._transport.on('sessionError', (peerId: string, err: Error) => {
            logError(`KCP session error (${peerId}):`, err.message);
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
                        transferPort: peer.transferPort || (peer.port + 1000),
                        lastSeen: Date.now(),
                        status: 'offline'
                    });
                });
                log(`Loaded ${peersArray.length} peers from ${filePath}`);
                this.emit('peersUpdate', Array.from(this._peers.values()));
            }
        } catch (err) {
            logError('Failed to load peers from file:', err);
        }
    }

    public stop(): void {
        this._isRunning = false;

        if (this._heartbeatIntervalTimer) {
            clearInterval(this._heartbeatIntervalTimer);
            this._heartbeatIntervalTimer = null;
        }
        if (this._discoveryIntervalTimer) {
            clearInterval(this._discoveryIntervalTimer);
            this._discoveryIntervalTimer = null;
        }

        if (this._transport) {
            this._transport.removeAllListeners();
            this._transport.stop();
            this._transport = null;
        }

        if (this._udpServer) {
            this._udpServer.close();
            this._udpServer = null;
        }

        if (this._discoverySocket) {
            try {
                this._discoverySocket.close();
            } catch (_) { /* ignore */ }
            this._discoverySocket = null;
        }

        this._peers.forEach(peer => {
            peer.status = 'offline';
        });
        this.emit('peersUpdate', Array.from(this._peers.values()));
    }

    /**
     * 是否是本实例自己发出的消息（IP 是本机任一地址且端口等于本端口）。
     * 只比较 IP 会误杀同一台机器上的其他 VS Code 实例。
     */
    private _isSelf(ip: string, port: number): boolean {
        return port === this._port && this._localIps.has(ip);
    }

    /**
     * UDP 通道仅处理发现/心跳消息
     */
    private _handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        try {
            const data = JSON.parse(msg.toString());
            const peerIp = rinfo.address;
            const peerPort = rinfo.port;

            if (this._isSelf(peerIp, peerPort)) {
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
                default:
                    break;
            }
        } catch (err) {
            logError('Failed to parse UDP message:', err);
        }
    }

    /**
     * 解析 peerId 对应的 PeerInfo。
     * 若不在已知列表（如启动后才在 peers 编辑器中新增的对象），
     * 则按 peerId 的 `ip:端口` 约定即时补建一条记录——
     * KCP 握手建连（5 秒超时）本身就是在线检测，无需等发现/心跳。
     */
    private _resolvePeer(peerId: string): PeerInfo {
        const existing = this._peers.get(peerId);
        if (existing) {
            return existing;
        }
        const sepIndex = peerId.lastIndexOf(':');
        const ip = sepIndex > 0 ? peerId.slice(0, sepIndex) : '';
        const port = sepIndex > 0 ? parseInt(peerId.slice(sepIndex + 1), 10) : NaN;
        if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new Error(`Peer ${peerId} not found`);
        }
        const peer: PeerInfo = {
            id: peerId,
            hostname: '',
            ip,
            port,
            transferPort: port + 1000,
            lastSeen: Date.now(),
            status: 'offline'
        };
        this._peers.set(peerId, peer);
        this.emit('peersUpdate', Array.from(this._peers.values()));
        return peer;
    }

    /**
     * 确保与指定 peer 建立了 KCP 会话
     */
    private async _ensureSession(peerId: string): Promise<void> {
        const peer = this._resolvePeer(peerId);
        if (!this._transport) {
            throw new Error('传输层未启动');
        }
        if (this._transport.hasSession(peerId)) {
            return;
        }
        await this._transport.connect(peerId, peer.ip, peer.transferPort, CONNECT_TIMEOUT);
    }

    /**
     * 通过 KCP 发送消息到指定 peer
     */
    private async _sendViaTransport(peerId: string, message: NetworkMessage): Promise<void> {
        await this._ensureSession(peerId);
        const data = Buffer.from(JSON.stringify(message));
        await this._transport!.send(peerId, data);
    }

    public createTransferTask(
        peerId: string,
        messages: string[],
        files: { name: string; path: string; size: number }[]
    ): TransferTask {
        const peer = this._resolvePeer(peerId);

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
     * 执行传输任务，所有消息通过 KCP 可靠传输。
     * 连接建立本身就是在线检测（5 秒超时），不再额外握手。
     */
    public async executeTransferTask(taskId: string): Promise<void> {
        const task = this._transferTasks.get(taskId);
        if (!task) {
            throw new Error(`Transfer task ${taskId} not found`);
        }

        task.status = 'connecting';
        this.emit('transferTaskUpdated', task);

        try {
            await this._ensureSession(task.peerId);
        } catch (err) {
            task.status = 'timeout';
            task.errorMessage = '连接失败，对方可能不在线';
            this.emit('transferTaskUpdated', task);
            this.emit('transferTaskFailed', task);
            throw new Error('Connect timeout');
        }

        task.status = 'transferring';
        this.emit('transferTaskUpdated', task);

        try {
            for (const message of task.messages) {
                const msg: NetworkMessage = {
                    type: 'message',
                    from: this._localPeerId(),
                    to: task.peerId,
                    content: message,
                    timestamp: Date.now()
                };
                await this._sendViaTransport(task.peerId, msg);
            }

            for (const file of task.files) {
                await this._sendFileChunked(task, file);
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

    /**
     * 分块流式发送文件：从磁盘按块读取，逐块发送并更新真实进度，
     * 避免整个文件驻留内存。
     */
    private async _sendFileChunked(task: TransferTask, file: { name: string; path: string; size: number }): Promise<void> {
        const totalChunks = Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE));
        const handle = await fs.promises.open(file.path, 'r');
        let lastProgress = -1;

        try {
            const chunkBuffer = Buffer.allocUnsafe(FILE_CHUNK_SIZE);
            for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                const { bytesRead } = await handle.read(chunkBuffer, 0, FILE_CHUNK_SIZE, chunkIndex * FILE_CHUNK_SIZE);

                const msg: NetworkMessage = {
                    type: 'file',
                    from: this._localPeerId(),
                    to: task.peerId,
                    timestamp: Date.now(),
                    file: {
                        name: file.name,
                        size: file.size,
                        chunkIndex,
                        totalChunks,
                        data: chunkBuffer.subarray(0, bytesRead).toString('base64')
                    }
                };
                await this._sendViaTransport(task.peerId, msg);

                task.transferredBytes += bytesRead;
                const progress = task.totalBytes > 0
                    ? Math.floor((task.transferredBytes / task.totalBytes) * 100)
                    : 100;
                if (progress !== lastProgress) {
                    lastProgress = progress;
                    task.progress = progress;
                    this.emit('transferTaskUpdated', task);
                }
            }
        } finally {
            await handle.close();
        }
    }

    /**
     * 通过 UDP 发送（仅用于发现/心跳消息）
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
        await this._sendViaTransport(peerId, message);
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

    /** 本端 peerId：`本机IP:主端口` */
    private _localPeerId(): string {
        return `${this.getLocalIp()}:${this._port}`;
    }

    /**
     * 刷新本机 IP 缓存
     */
    private _refreshLocalIps(): void {
        this._localIps = new Set(['127.0.0.1']);
        this._localIp = '127.0.0.1';

        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            const iface = interfaces[name];
            if (!iface) { continue; }
            for (const addr of iface) {
                if (addr.family === 'IPv4') {
                    this._localIps.add(addr.address);
                    if (!addr.internal && this._localIp === '127.0.0.1') {
                        this._localIp = addr.address;
                    }
                }
            }
        }
    }

    public getLocalIp(): string {
        if (this._localIp === '127.0.0.1' && this._localIps.size <= 1) {
            this._refreshLocalIps();
        }
        return this._localIp;
    }
}

export const networkService = new NetworkService();
