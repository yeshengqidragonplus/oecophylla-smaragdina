import * as dgram from 'dgram';
import * as os from 'os';
import * as events from 'events';
import * as fs from 'fs';
import { KcpTransport } from './kcpTransport';
import { log, logError } from './logger';
import { classifyNetError, ErrorThrottle, NetErrorInfo } from './netErrors';
import {
    LanInterface,
    RawInterfaces,
    broadcastTargets,
    interfaceFingerprint,
    listLanInterfaces,
    listLocalAddresses,
    pickPrimary
} from './netInterfaces';

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
const DISCOVERY_INTERVAL = 30_000;
/** 启动后的快速补发时机（毫秒）：对端可能刚好还没绑定发现端口，不必干等一个完整周期 */
const DISCOVERY_QUICK_DELAYS = [1_000, 3_000];
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

    /** 本机所有 IPv4 地址（含回环和被排除的网卡），用于过滤自己发出的广播 */
    private _localIps: Set<string> = new Set();
    /** 主网卡地址（仅用于展示与旧版协议的身份兼容） */
    private _localIp: string = '127.0.0.1';
    /** 可用的局域网网卡（已排除回环/TUN/链路本地，真实网卡排前），发现广播逐块发送 */
    private _lanInterfaces: LanInterface[] = [];
    private _ifaceFingerprint: string = '';
    private _discoveryQuickTimers: NodeJS.Timeout[] = [];
    /** 测试开关：关闭广播发现，用于验证单播探测不依赖广播 */
    private _broadcastEnabled: boolean = true;

    private _heartbeatIntervalTimer: NodeJS.Timeout | null = null;
    private _discoveryIntervalTimer: NodeJS.Timeout | null = null;

    /** 网络错误日志限流（断网时每个 UDP 包都会失败，不能每条都写日志） */
    private _errorThrottle = new ErrorThrottle();
    private _netErrorCounts: Map<string, number> = new Map();
    private _lastNetError: (NetErrorInfo & { scope: string; target?: string; at: number }) | null = null;

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
        this._refreshNetwork();

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

        // 启动后立即发送一次广播发现，并在随后几秒内快速补发
        this._sendDiscoveryBroadcast();
        this._discoveryQuickTimers = DISCOVERY_QUICK_DELAYS.map(delay =>
            setTimeout(() => this._sendDiscoveryBroadcast(), delay));

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
                if (!settled) {
                    logError('UDP Server error:', err);
                    settled = true;
                    udpServer.close();
                    reject(err);
                } else {
                    // 运行期错误（网络切换、网卡禁用、权限被拒等）只记录与上报：
                    // 不能 emit('error')——EventEmitter 对没有监听者的 'error' 事件会直接抛出
                    this._reportNetError('udp', err);
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
                this._reportNetError('discovery', err);
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
     * 发送 UDP 广播发现请求：向每块可用网卡的定向广播地址各发一份，再加受限广播。
     * 每轮先刷新网卡信息——网络切换（开关 VPN/TUN、换 Wi-Fi）后本机地址集合会变化。
     */
    private _sendDiscoveryBroadcast(): void {
        if (!this._udpServer || !this._broadcastEnabled) {
            return;
        }

        this._refreshNetwork();

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
        for (const target of broadcastTargets(this._lanInterfaces)) {
            this._udpSend(buffer, DISCOVERY_PORT, target, 'discovery');
        }
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

        // socket 级错误（发送失败、权限被拒等）：分类记录，不抛出
        this._transport.on('transportError', (err: Error, target?: string) => {
            this._reportNetError('kcp', err, target);
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
        this._discoveryQuickTimers.forEach(timer => clearTimeout(timer));
        this._discoveryQuickTimers = [];

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
        log(`[Peer] ${peerId} 不在运行时列表，按约定补建（KCP 端口 ${peer.transferPort}）`);
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
            log(`[会话] 复用已有 KCP 会话: ${peerId}`);
            return;
        }
        log(`[会话] 向 ${peer.ip}:${peer.transferPort}（UDP/KCP）发起握手，超时 ${CONNECT_TIMEOUT}ms ...`);
        await this._transport.connect(peerId, peer.ip, peer.transferPort, CONNECT_TIMEOUT);
        log(`[会话] 与 ${peerId} 的 KCP 会话已建立`);
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

        log(`[传输] 任务 ${taskId} 开始：目标 ${task.peerId}，消息 ${task.messages.length} 条，文件 ${task.files.length} 个（共 ${task.totalBytes} 字节）`);
        task.status = 'connecting';
        this.emit('transferTaskUpdated', task);

        try {
            await this._ensureSession(task.peerId);
        } catch (err) {
            logError(`[传输] 任务 ${taskId} 建连失败: ${(err as Error).message}`);
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
                log(`[传输] 文本消息已送达 ${task.peerId}（${message.length} 字）`);
            }

            for (const file of task.files) {
                log(`[传输] 开始发送文件 ${file.name}（${file.size} 字节）→ ${task.peerId}`);
                await this._sendFileChunked(task, file);
                log(`[传输] 文件 ${file.name} 发送完成`);
            }

            task.status = 'completed';
            task.completedAt = Date.now();
            task.progress = 100;
            this.emit('transferTaskUpdated', task);
            this.emit('transferTaskCompleted', task);
        } catch (err) {
            logError(`[传输] 任务 ${taskId} 失败: ${(err as Error).message}`);
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
        this._udpSend(Buffer.from(JSON.stringify(message)), port, ip, 'udp');
    }

    /**
     * 统一的 UDP 发送：带回调，失败（含同步抛出的参数错误）一律分类上报而不是抛出。
     * 不带回调的 send 失败会变成 socket 的未处理 'error' 事件。
     */
    private _udpSend(buffer: Buffer, port: number, ip: string, scope: string): void {
        const socket = this._udpServer;
        if (!socket) {
            return;
        }
        const target = `${ip}:${port}`;
        try {
            socket.send(buffer, 0, buffer.length, port, ip, err => {
                if (err) {
                    this._reportNetError(scope, err, target);
                }
            });
        } catch (err) {
            this._reportNetError(scope, err as Error, target);
        }
    }

    /** 记录并上报网络错误：分类、计数、限流日志，并通过 'networkError' 事件通知外部 */
    private _reportNetError(scope: string, err: Error, target?: string): void {
        const info = classifyNetError(err);
        this._netErrorCounts.set(info.code, (this._netErrorCounts.get(info.code) ?? 0) + 1);
        this._lastNetError = { ...info, scope, target, at: Date.now() };

        const suppressed = this._errorThrottle.check(`${scope}:${info.code}`);
        if (suppressed !== null) {
            const more = suppressed > 0 ? `（期间另有 ${suppressed} 条同类错误已合并）` : '';
            logError(`[网络错误] ${scope}${target ? ` → ${target}` : ''}：${info.code} ${info.message}${more}${info.hint ? `。${info.hint}` : ''}`);
        }
        this.emit('networkError', this._lastNetError);
    }

    /** 最近一次网络错误（供诊断与状态展示） */
    public getLastNetError(): (NetErrorInfo & { scope: string; target?: string; at: number }) | null {
        return this._lastNetError;
    }

    /** 各错误码累计次数（供诊断） */
    public getNetErrorCounts(): Record<string, number> {
        return Object.fromEntries(this._netErrorCounts);
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
     * 刷新网卡信息：本机地址集合、可用局域网网卡、主网卡地址。
     * @returns 网卡集合是否发生变化
     */
    private _refreshNetwork(): boolean {
        const raw = os.networkInterfaces() as RawInterfaces;
        const lan = listLanInterfaces(raw);
        const fingerprint = interfaceFingerprint(lan);
        const changed = fingerprint !== this._ifaceFingerprint;

        this._localIps = listLocalAddresses(raw);
        this._lanInterfaces = lan;
        this._ifaceFingerprint = fingerprint;

        const primary = pickPrimary(lan)?.address ?? '127.0.0.1';
        if (primary !== this._localIp) {
            this._localIp = primary;
            // 旧版协议用 ip:端口 作身份，主网卡变了要同步给传输层
            this._transport?.setLocalId(this._localPeerId());
        }

        if (changed) {
            const desc = lan.length === 0
                ? '无可用局域网网卡'
                : lan.map(i => `${i.name} ${i.address}/${i.prefix}（广播 ${i.broadcast}${i.virtual ? '，疑似虚拟网卡' : ''}）`).join('；');
            log(`[网卡] 可用网卡：${desc}`);
        }
        return changed;
    }

    public getLocalIp(): string {
        if (this._lanInterfaces.length === 0 && this._localIp === '127.0.0.1') {
            this._refreshNetwork();
        }
        return this._localIp;
    }

    /** 当前可用的局域网网卡（供诊断展示） */
    public getLanInterfaces(): LanInterface[] {
        return this._lanInterfaces;
    }
}

export const networkService = new NetworkService();
