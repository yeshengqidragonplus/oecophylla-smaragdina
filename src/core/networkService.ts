import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as os from 'os';
import * as fs from 'fs';
import { KcpTransport, SessionPeerInfo, isRetryableKcpError } from './kcpTransport';
import { log, logError } from './logger';
import { classifyNetError, ErrorThrottle, NetErrorInfo } from './netErrors';
import {
    LanInterface,
    RawInterfaces,
    broadcastTargets,
    enumerateHosts,
    interfaceFingerprint,
    listLanInterfaces,
    listLocalAddresses,
    pickPrimary
} from './netInterfaces';
import { ProbeState, isClockJump, isProbeDue, nextProbeState } from './probeSchedule';
import { PeerMeta, PeerRecord, PeerRegistry, Presence } from './peerRegistry';
import {
    BusinessMessage,
    FILE_ACK_MIN_PROTO,
    FILE_CHUNK_SIZE,
    FileAckMessage,
    FileChunkMessage,
    FileEndMessage,
    PROTOCOL_VERSION,
    PresenceMessage,
    PresenceType,
    TextMessage,
    parseBusinessFrame,
    parsePresenceMessage
} from './protocol';
import { TypedEmitter } from './typedEmitter';

// 协议类型集中定义在 protocol.ts，这里重新导出，保持原有的 import 路径可用
export type { BusinessMessage, FileAckMessage, FileChunkMessage, FileEndMessage, NetworkMessage, PresenceMessage, TextMessage } from './protocol';
export { PROTOCOL_VERSION } from './protocol';

export interface PeerInfo {
    id: string;
    hostname: string;
    nickname?: string;
    ip: string;
    port: number;
    /** 对端业务消息（KCP）端口 */
    transferPort: number;
    lastSeen: number;
    /** 在线三态：online / oneway（能收到对方的包但无往返确认）/ offline */
    status: Presence;
    /** 新版对端的稳定实例 ID（旧版对端没有） */
    iid?: string;
    meta?: PeerMeta;
    manual?: boolean;
}

/** 网络服务的运行状态，供界面显示与诊断 */
export interface NetworkStatus {
    state: 'stopped' | 'starting' | 'running' | 'error';
    /** 主 UDP 端口 */
    port: number;
    /** 主网卡地址（仅展示） */
    ip: string;
    instanceId: string;
    boot: string;
    /** state 为 error 时的失败原因 */
    error?: string;
    interfaces: Array<{ name: string; address: string; prefix: number; broadcast: string; virtual: boolean }>;
}

export interface StartOptions {
    /** 本机标识（同一台机器稳定不变）；实例 ID = `${machineId}:${端口}`。缺省时每个 NetworkService 随机生成 */
    machineId?: string;
    /** 随握手与发现携带的版本信息（os/arch/node 由内部填充） */
    meta?: Partial<PeerMeta>;
}

/** 网络错误事件：分类后的 socket 错误，附带出错的位置与目标 */
export type NetworkErrorEvent = NetErrorInfo & { scope: string; target?: string; at: number };

/** NetworkService 的事件表：事件名与监听器参数在编译期检查 */
export interface NetworkServiceEvents {
    peersUpdate: [PeerInfo[]];
    /** 收到一条通过校验的业务消息（文本 / 文件分块），`from` 为会话键（联系人 id） */
    message: [BusinessMessage];
    statusChange: [NetworkStatus];
    transferTaskCreated: [TransferTask];
    transferTaskUpdated: [TransferTask];
    transferTaskCompleted: [TransferTask];
    transferTaskFailed: [TransferTask];
    networkError: [NetworkErrorEvent];
    networkResume: [string];
}

export interface TransferTask {
    id: string;
    peerId: string;
    peerIp: string;
    peerPort: number;
    messages: string[];
    files: { name: string; path: string; size: number }[];
    status: 'pending' | 'connecting' | 'transferring' | 'completed' | 'failed' | 'timeout' | 'cancelled';
    progress: number;
    totalBytes: number;
    transferredBytes: number;
    createdAt: number;
    completedAt?: number;
    errorMessage?: string;
}

/** 对端维护节拍（毫秒）：每个节拍检查离线超时，并探测到期的对端（探测节奏见 probeSchedule） */
const PEER_TICK_INTERVAL = 5_000;
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
/** KCP 握手建连超时（毫秒） */
const CONNECT_TIMEOUT = 5_000;
/** 文件发送：同时在途的分块数（流水线深度）。逐块等 ACK 时吞吐 ≈ 64KB/RTT，Wi-Fi 上明显偏慢 */
const FILE_SEND_WINDOW = 8;
/** 文件发送完毕后等待接收端落盘确认（file_ack）的最长时间 */
const FILE_ACK_TIMEOUT = 30_000;
/** 已结束的传输任务保留多久后清理（避免任务表无限增长） */
const FINISHED_TASK_TTL = 10 * 60 * 1000;
/** 手动扫描网段：单个网段最多探测的主机数（/22 为 1022；更大的网段不扫） */
const SCAN_HOST_LIMIT = 1022;
/** 手动扫描网段：每批探测的主机数与批间间隔，避免瞬间发出上千个包 */
const SCAN_BATCH_SIZE = 64;
const SCAN_BATCH_DELAY = 20;

/** 读取待发送文件失败时的可读提示（Windows 下被其他程序独占的文件很常见） */
function describeOpenError(fileName: string, err: unknown): string {
    switch ((err as NodeJS.ErrnoException).code) {
        case 'EBUSY':
        case 'EPERM':
        case 'EACCES':
            return `无法读取文件「${fileName}」：文件被其他程序占用，或没有读取权限（请先关闭占用它的程序，如已打开的 Excel）`;
        case 'ENOENT':
            return `文件「${fileName}」已被移动或删除`;
        default:
            return `无法读取文件「${fileName}」：${(err as Error).message}`;
    }
}

export class NetworkService extends TypedEmitter<NetworkServiceEvents> {
    private _udpServer: dgram.Socket | null = null;
    /** 共享发现端口的监听 socket（仅接收 discovery_request） */
    private _discoverySocket: dgram.Socket | null = null;
    private _port: number = 8080;
    private _hostname: string;
    private _nickname?: string;
    /** 对端唯一数据源（身份、地址、在线三态、持久化快照） */
    public readonly registry = new PeerRegistry();
    private _machineId: string = crypto.randomUUID();
    private _instanceId: string = '';
    private _meta: PeerMeta = { os: process.platform, arch: process.arch, node: process.versions.node };
    /** 最近收到的业务消息 ID，用于去重 */
    private _seenMessageIds: Set<string> = new Set();
    /** 上一次维护节拍的时间，用于检测睡眠唤醒 */
    private _lastTickAt: number = 0;
    private _state: NetworkStatus['state'] = 'stopped';
    private _stateError: string | undefined;
    private _scanning: boolean = false;
    /** 已请求取消的任务 id */
    private _cancelled: Set<string> = new Set();
    /** 等待接收端落盘确认的发送：key 为 transferId */
    private _ackWaiters: Map<string, { result?: FileAckMessage; resolve?: (ack: FileAckMessage) => void }> = new Map();
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

    private _peerTickTimer: NodeJS.Timeout | null = null;
    /** 每个对端的探测状态：key 为 peerId */
    private _probeState: Map<string, ProbeState> = new Map();
    private _discoveryIntervalTimer: NodeJS.Timeout | null = null;

    /** 网络错误日志限流（断网时每个 UDP 包都会失败，不能每条都写日志） */
    private _errorThrottle = new ErrorThrottle();
    private _netErrorCounts: Map<string, number> = new Map();
    private _lastNetError: NetworkErrorEvent | null = null;

    constructor() {
        super();
        this._hostname = os.hostname();
        this.registry.on('change', () => this.emit('peersUpdate', this.getPeers()));
        this.registry.on('restarted', (rec: PeerRecord) => this._onPeerRestarted(rec));
    }

    get transport(): KcpTransport | null {
        return this._transport;
    }

    /**
     * 启动网络服务；状态变化通过 'statusChange' 事件推送（starting → running / error）。
     * 失败时抛出原因，同时状态置为 error。
     */
    public async start(port: number, nickname?: string, options: StartOptions = {}): Promise<void> {
        if (this._isRunning) {
            this.stop();
        }
        this._setState('starting');
        try {
            await this._startInternal(port, nickname, options);
        } catch (err) {
            this._setState('error', (err as Error).message);
            throw err;
        }
        this._setState('running');
    }

    private async _startInternal(port: number, nickname: string | undefined, options: StartOptions): Promise<void> {
        this._port = port;
        this._nickname = nickname;
        if (options.machineId) {
            this._machineId = options.machineId;
        }
        this._instanceId = `${this._machineId}:${port}`;
        this._meta = {
            os: process.platform,
            arch: process.arch,
            node: process.versions.node,
            ...options.meta
        };
        this._refreshNetwork();

        // 启动 KCP 传输层（业务消息通道）
        this._transport = new KcpTransport(this._port);
        this._transport.setLocalId(this._localPeerId());
        this._transport.setLocalInstanceId(this._instanceId);
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

        this._startPeerTick();
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
                const parsed = parsePresenceMessage(msg);
                if (!parsed.ok) {
                    this._logBadDatagram('discovery', rinfo.address, parsed.reason);
                    return;
                }
                const data = parsed.msg;
                if (data.type === 'discovery_request' && !this._isSelfMessage(data, rinfo.address, rinfo.port)) {
                    // rinfo.port 是请求方的主端口（从主 socket 发出）
                    this._handleDiscoveryRequest(data, rinfo.address, rinfo.port);
                }
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

        const buffer = Buffer.from(JSON.stringify(this._baseMessage('discovery_request')));

        // 从主 socket 发出（源端口 = 主端口，对方据此回复），目标为共享发现端口
        for (const target of broadcastTargets(this._lanInterfaces)) {
            this._udpSend(buffer, DISCOVERY_PORT, target, 'discovery');
        }
    }

    /** 本机发出的所有 UDP 消息共用的头部：旧字段保持不变（兼容旧版），新增协议版本、实例 ID、boot 与 meta */
    private _baseMessage(type: PresenceType, to?: string): PresenceMessage {
        return {
            type,
            from: this.getLocalIp(),
            fromHostname: this._hostname,
            fromNickname: this._nickname,
            to,
            timestamp: Date.now(),
            transferPort: this._transport?.port || (this._port + 1000),
            proto: PROTOCOL_VERSION,
            iid: this._instanceId,
            boot: this._transport?.boot,
            meta: this._meta
        };
    }

    /**
     * 处理发现请求 - 回复自己的信息
     */
    private _handleDiscoveryRequest(msg: PresenceMessage, ip: string, port: number): void {
        this._sendTo(ip, port, this._baseMessage('discovery_response', `${ip}:${port}`));
        this._observeFromUdp(msg, ip, port, 'inbound', 'Discovery');
    }

    /**
     * 处理发现响应：往返确认
     */
    private _handleDiscoveryResponse(msg: PresenceMessage, ip: string, port: number): void {
        this._observeFromUdp(msg, ip, port, 'ack', 'Discovery');
    }

    /**
     * 把收到的 UDP 消息登记到注册表。
     * 地址取自 rinfo（观察值）而不是对端自称的 from；身份优先用对端的实例 ID。
     */
    private _observeFromUdp(msg: PresenceMessage, ip: string, port: number, kind: 'inbound' | 'ack', logTag: string): void {
        const known = !!this.registry.findByAddress(ip, port) || (!!msg.iid && !!this.registry.resolve(msg.iid));
        const rec = this.registry.observe({
            kind,
            ip,
            port,
            transferPort: msg.transferPort,
            iid: msg.iid,
            boot: msg.boot,
            proto: msg.proto,
            meta: msg.meta,
            hostname: msg.fromHostname,
            nickname: msg.fromNickname
        });
        if (!known) {
            log(`[${logTag}] New peer found: ${rec.id}（${ip}:${port}）`);
        }
    }

    // ==================== 对端维护与探测 ====================

    /**
     * 启动对端维护节拍，并立即探测一轮（启动时已加载的对端无需等第一个节拍）
     */
    private _startPeerTick(): void {
        if (this._peerTickTimer) {
            clearInterval(this._peerTickTimer);
        }
        this._lastTickAt = Date.now();
        this._peerTickTimer = setInterval(() => this._peerTick(), PEER_TICK_INTERVAL);
        this._probePeers();
    }

    /**
     * 对端维护节拍：检测睡眠唤醒与网卡变化，其余时间做离线判定与探测。
     * 发生唤醒/网卡变化的这一拍不做离线判定：先让重新发出的探测有时间得到应答，
     * 避免唤醒后一瞬间把所有对端误判为离线。
     */
    private _peerTick(): void {
        const now = Date.now();
        const jumped = isClockJump(this._lastTickAt, now, PEER_TICK_INTERVAL);
        this._lastTickAt = now;
        const networkChanged = this._refreshNetwork();

        if (jumped || networkChanged) {
            this._resumeDiscovery(jumped ? '检测到进程被挂起过（睡眠唤醒或系统节流）' : '网卡发生变化');
            return;
        }
        this.registry.sweep();
        this._probePeers();
    }

    /** 唤醒或网络变化后：丢弃旧会话、清空探测状态、立即重新发现并探测全部对端 */
    private _resumeDiscovery(reason: string): void {
        log(`[网络] ${reason}：重新发现并探测所有对端`);
        this._probeState.clear();
        this._transport?.disconnectAll();
        this._sendDiscoveryBroadcast();
        this._probePeers();
        this.emit('networkResume', reason);
    }

    /**
     * 探测所有已知对端（不再看 lastSeen）：
     * 有联系的（online / oneway）发心跳；离线的发单播发现请求——对方收到会回应并登记我们，
     * 这是广播到不了（跨网段、广播被过滤）时找回手工配置对端的唯一途径。
     */
    private _probePeers(): void {
        if (!this._udpServer || !this._isRunning) {
            return;
        }
        const now = Date.now();
        for (const peer of this.registry.list()) {
            const alive = peer.presence !== 'offline';
            const state = this._probeState.get(peer.id);
            if (!isProbeDue(alive, state, now)) {
                continue;
            }
            this._probeState.set(peer.id, nextProbeState(alive, state, now));
            this._sendTo(peer.ip, peer.port, this._baseMessage(alive ? 'heartbeat' : 'discovery_request', peer.id));
        }
    }

    /**
     * 处理收到的心跳，并回复确认
     */
    private _handleHeartbeat(msg: PresenceMessage, ip: string, port: number): void {
        this._observeFromUdp(msg, ip, port, 'inbound', 'Heartbeat');
        this._sendTo(ip, port, this._baseMessage('heartbeat_ack', `${ip}:${port}`));
    }

    /**
     * 处理心跳确认：往返确认
     */
    private _handleHeartbeatAck(msg: PresenceMessage, ip: string, port: number): void {
        this._observeFromUdp(msg, ip, port, 'ack', 'Heartbeat');
    }

    /** 对端重启过（boot 标识变了）：旧的 KCP 会话已是僵尸，立即销毁，下次发送自动重建 */
    private _onPeerRestarted(rec: PeerRecord): void {
        log(`[Peer] ${rec.id} 已重启（boot 标识变化），销毁旧的 KCP 会话`);
        this._transport?.disconnect(rec.id);
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
            const parsed = parseBusinessFrame(data);
            if (!parsed.ok) {
                this._logBadDatagram('kcp', peerId, parsed.reason);
                return;
            }
            const msg = parsed.msg;
            msg.from = peerId;
            if (msg.type === 'file_ack') {
                // 落盘确认只交给等待它的发送流程，不作为聊天消息上报
                const waiter = this._ackWaiters.get(msg.transferId);
                if (waiter) {
                    waiter.result = msg;
                    waiter.resolve?.(msg);
                }
                return;
            }
            if (msg.type === 'message' && msg.id && this._isDuplicateMessage(msg.id)) {
                log(`[消息] 忽略重复消息 ${msg.id}（会话重建后的重发）`);
                return;
            }
            this.emit('message', msg);
        });

        this._transport.on('sessionConnected', (peerId: string, info?: SessionPeerInfo) => {
            log(`KCP session connected: ${peerId}`);
            if (info) {
                // 入站握手成功：双方都能收到对方的包，等同往返确认
                this.registry.observe({
                    kind: 'kcp',
                    ip: info.ip,
                    port: info.port,
                    transferPort: info.transferPort,
                    iid: info.iid,
                    boot: info.boot
                });
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

    /** 业务消息去重：只保留最近 512 个 ID */
    private _isDuplicateMessage(id: string): boolean {
        if (this._seenMessageIds.has(id)) {
            return true;
        }
        this._seenMessageIds.add(id);
        if (this._seenMessageIds.size > 512) {
            const oldest = this._seenMessageIds.values().next().value;
            if (oldest !== undefined) {
                this._seenMessageIds.delete(oldest);
            }
        }
        return false;
    }

    // ==================== 消息处理 ====================

    public stop(): void {
        this._isRunning = false;

        if (this._peerTickTimer) {
            clearInterval(this._peerTickTimer);
            this._peerTickTimer = null;
        }
        this._probeState.clear();
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

        this.registry.markAllOffline();
        this.emit('peersUpdate', this.getPeers());
        this._setState('stopped');
    }

    private _setState(state: NetworkStatus['state'], error?: string): void {
        this._state = state;
        this._stateError = error;
        this.emit('statusChange', this.getStatus());
    }

    public getStatus(): NetworkStatus {
        return {
            state: this._state,
            port: this._port,
            ip: this._localIp,
            instanceId: this._instanceId,
            boot: this._transport?.boot ?? '',
            error: this._stateError,
            interfaces: this._lanInterfaces.map(i => ({
                name: i.name, address: i.address, prefix: i.prefix, broadcast: i.broadcast, virtual: i.virtual
            }))
        };
    }

    /**
     * 是否是本实例自己发出的消息（IP 是本机任一地址且端口等于本端口）。
     * 只比较 IP 会误杀同一台机器上的其他 VS Code 实例。
     */
    private _isSelf(ip: string, port: number): boolean {
        return port === this._port && this._localIps.has(ip);
    }

    /** 自己发出的消息：地址与端口都是本机，或消息里的实例 ID 就是自己（后者不受本机 IP 变化影响） */
    private _isSelfMessage(data: { iid?: string }, ip: string, port: number): boolean {
        if (data.iid && data.iid === this._instanceId) {
            return true;
        }
        return this._isSelf(ip, port);
    }

    /**
     * UDP 通道仅处理发现/心跳消息
     */
    private _handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        const parsed = parsePresenceMessage(msg);
        if (!parsed.ok) {
            this._logBadDatagram('udp', rinfo.address, parsed.reason);
            return;
        }
        const data = parsed.msg;
        const peerIp = rinfo.address;
        const peerPort = rinfo.port;

        if (this._isSelfMessage(data, peerIp, peerPort)) {
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
        }
    }

    /** 收到无法识别或校验不通过的数据：丢弃，并按来源限流记录一条日志（局域网上的杂包不能刷屏） */
    private _logBadDatagram(channel: string, source: string, reason: string): void {
        if (this._errorThrottle.check(`bad:${channel}:${source}`) !== null) {
            logError(`[${channel}] 丢弃来自 ${source} 的无效数据：${reason}`);
        }
    }

    /**
     * 解析 peerId（实例 ID、旧版 ip:端口 或历史别名）对应的对端记录。
     * 若不在已知列表（如启动后才在联系人编辑器中新增的对象），
     * 则按 peerId 的 `ip:端口` 约定即时补建一条记录——
     * KCP 握手建连（5 秒超时）本身就是在线检测，无需等发现/心跳。
     */
    private _resolvePeer(peerId: string): PeerRecord {
        const existing = this.registry.resolve(peerId);
        if (existing) {
            return existing;
        }
        const sepIndex = peerId.lastIndexOf(':');
        const ip = sepIndex > 0 ? peerId.slice(0, sepIndex) : '';
        const port = sepIndex > 0 ? parseInt(peerId.slice(sepIndex + 1), 10) : NaN;
        if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new Error(`Peer ${peerId} not found`);
        }
        const peer = this.registry.ensureByAddress(ip, port);
        log(`[Peer] ${peerId} 不在运行时列表，按约定补建（KCP 端口 ${peer.transferPort}）`);
        return peer;
    }

    /**
     * 确保与指定 peer 建立了 KCP 会话（传输层以对端记录的规范 id 为键）
     */
    private async _ensureSession(peerId: string): Promise<void> {
        const peer = this._resolvePeer(peerId);
        if (!this._transport) {
            throw new Error('传输层未启动');
        }
        if (this._transport.hasSession(peer.id)) {
            log(`[会话] 复用已有 KCP 会话: ${peer.id}`);
            return;
        }
        log(`[会话] 向 ${peer.ip}:${peer.transferPort}（UDP/KCP）发起握手，超时 ${CONNECT_TIMEOUT}ms ...`);
        await this._transport.connect(peer.id, peer.ip, peer.transferPort, CONNECT_TIMEOUT);
        this.registry.markAck(peer.id);
        log(`[会话] 与 ${peer.id} 的 KCP 会话已建立`);
    }

    /**
     * 通过 KCP 发送消息到指定 peer。
     * 会话失效类错误（对端重启/睡眠后残留的僵尸会话、确认超时）时，销毁旧会话、重新握手并重发一次——
     * 用户不必手动点第二次。重发的是完整帧：文本消息带 id、接收端去重；文件分块按块号去重。
     */
    private async _sendViaTransport(peerId: string, message: BusinessMessage): Promise<void> {
        const peer = this._resolvePeer(peerId);
        const data = Buffer.from(JSON.stringify(message));
        for (let attempt = 0; ; attempt++) {
            await this._ensureSession(peer.id);
            try {
                await this._transport!.send(peer.id, data);
                return;
            } catch (err) {
                if (attempt === 0 && isRetryableKcpError(err)) {
                    log(`[会话] 发送失败（${(err as Error).message}），会话可能已失效，重建会话后重试一次`);
                    this._transport?.disconnect(peer.id);
                    continue;
                }
                throw err;
            }
        }
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
            peerId: peer.id,
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

        this._pruneFinishedTasks();
        this._transferTasks.set(taskId, task);
        this.emit('transferTaskCreated', task);
        return task;
    }

    /** 清理已结束超过 10 分钟的任务（_transferTasks 原先只增不删） */
    private _pruneFinishedTasks(): void {
        const now = Date.now();
        for (const [id, task] of this._transferTasks) {
            const finished = task.status === 'completed' || task.status === 'failed'
                || task.status === 'timeout' || task.status === 'cancelled';
            if (finished && now - (task.completedAt ?? task.createdAt) > FINISHED_TASK_TTL) {
                this._transferTasks.delete(id);
            }
        }
    }

    /** 取消传输任务：停止继续发送；已发出的分块无法收回，接收端会在超时后清理残留的临时文件 */
    public cancelTransferTask(taskId: string): boolean {
        const task = this._transferTasks.get(taskId);
        if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled') {
            return false;
        }
        this._cancelled.add(taskId);
        return true;
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
                const msg: TextMessage = {
                    id: crypto.randomUUID(),
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
            const cancelled = this._cancelled.has(taskId);
            logError(`[传输] 任务 ${taskId} ${cancelled ? '已取消' : '失败'}: ${(err as Error).message}`);
            task.status = cancelled ? 'cancelled' : 'failed';
            task.errorMessage = cancelled ? '已取消' : (err as Error).message;
            task.completedAt = Date.now();
            this.emit('transferTaskUpdated', task);
            this.emit('transferTaskFailed', task);
            throw err;
        } finally {
            this._cancelled.delete(taskId);
        }
    }

    /**
     * 分块流式发送文件：从磁盘按块读取，滑动窗口并发发送（最多 8 块在途），按真实已确认字节更新进度，
     * 避免整个文件驻留内存。接收端按偏移写盘，分块到达顺序不影响结果。
     *
     * 协议 v3 对端：每个文件带 transferId，全部分块被传输层确认后发 file_end，并等待接收端的 file_ack
     * （落盘成功才算成功）——传输层确认只说明"对端收到了"，不说明"对端存下来了"。
     * 旧版对端不会回 file_ack，保持原行为（传输层确认即视为成功）。
     */
    private async _sendFileChunked(task: TransferTask, file: { name: string; path: string; size: number }): Promise<void> {
        const totalChunks = Math.max(1, Math.ceil(file.size / FILE_CHUNK_SIZE));
        const transferId = crypto.randomUUID();
        const peer = this._resolvePeer(task.peerId);
        const expectAck = (peer.proto ?? 0) >= FILE_ACK_MIN_PROTO;
        // 先登记等待：接收端可能在我们发出 file_end 之前就已收齐并回了 file_ack
        const ackWaiter = expectAck ? this._expectFileAck(transferId) : undefined;

        let handle: fs.promises.FileHandle;
        try {
            handle = await fs.promises.open(file.path, 'r');
        } catch (err) {
            ackWaiter?.cancel();
            throw new Error(describeOpenError(file.name, err));
        }

        let lastProgress = -1;
        let firstError: Error | null = null;
        const inflight: Promise<void>[] = [];

        try {
            const chunkBuffer = Buffer.allocUnsafe(FILE_CHUNK_SIZE);
            for (let chunkIndex = 0; chunkIndex < totalChunks && !firstError; chunkIndex++) {
                if (this._cancelled.has(task.id)) {
                    throw new Error('已取消');
                }
                const { bytesRead } = await handle.read(chunkBuffer, 0, FILE_CHUNK_SIZE, chunkIndex * FILE_CHUNK_SIZE);

                const msg: FileChunkMessage = {
                    type: 'file',
                    from: this._localPeerId(),
                    to: task.peerId,
                    timestamp: Date.now(),
                    file: {
                        name: file.name,
                        size: file.size,
                        chunkIndex,
                        totalChunks,
                        // base64 立即生成字符串副本，之后复用同一个读缓冲区是安全的
                        data: chunkBuffer.subarray(0, bytesRead).toString('base64'),
                        chunkSize: FILE_CHUNK_SIZE,
                        transferId
                    }
                };
                const send = this._sendViaTransport(task.peerId, msg).then(() => {
                    task.transferredBytes += bytesRead;
                    const progress = task.totalBytes > 0
                        ? Math.floor((task.transferredBytes / task.totalBytes) * 100)
                        : 100;
                    if (progress !== lastProgress) {
                        lastProgress = progress;
                        task.progress = progress;
                        this.emit('transferTaskUpdated', task);
                    }
                }).catch((err: Error) => {
                    firstError = firstError ?? err;
                });
                inflight.push(send);
                if (inflight.length >= FILE_SEND_WINDOW) {
                    await inflight.shift();
                }
            }
            await Promise.all(inflight);
            if (firstError) {
                throw firstError;
            }

            if (ackWaiter) {
                const end: FileEndMessage = {
                    type: 'file_end',
                    from: this._localPeerId(),
                    to: task.peerId,
                    timestamp: Date.now(),
                    transferId,
                    name: file.name,
                    size: file.size,
                    totalChunks
                };
                await this._sendViaTransport(task.peerId, end);
                const ack = await ackWaiter.wait(FILE_ACK_TIMEOUT);
                if (!ack.ok) {
                    throw new Error(`对方没有成功保存「${file.name}」：${ack.reason ?? '未知原因'}`);
                }
            }
        } finally {
            ackWaiter?.cancel();
            await handle.close();
        }
    }

    /** 登记对一个文件的落盘确认；wait 在确认到达（含早于 wait 调用到达的）或超时时结束 */
    private _expectFileAck(transferId: string): { wait(timeoutMs: number): Promise<FileAckMessage>; cancel(): void } {
        const entry: { result?: FileAckMessage; resolve?: (ack: FileAckMessage) => void } = {};
        this._ackWaiters.set(transferId, entry);
        return {
            wait: (timeoutMs: number) => new Promise<FileAckMessage>((resolve, reject) => {
                if (entry.result) {
                    resolve(entry.result);
                    return;
                }
                const timer = setTimeout(() => {
                    entry.resolve = undefined;
                    reject(new Error('对方没有确认已保存文件（可能中途已重启或断开）'));
                }, timeoutMs);
                entry.resolve = ack => {
                    clearTimeout(timer);
                    resolve(ack);
                };
            }),
            cancel: () => {
                this._ackWaiters.delete(transferId);
            }
        };
    }

    /**
     * 通过 UDP 发送（仅用于发现/心跳消息）
     */
    private _sendTo(ip: string, port: number, message: PresenceMessage): void {
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
    public getLastNetError(): NetworkErrorEvent | null {
        return this._lastNetError;
    }

    /** 各错误码累计次数（供诊断） */
    public getNetErrorCounts(): Record<string, number> {
        return Object.fromEntries(this._netErrorCounts);
    }

    /**
     * 发送消息到指定 peer（通过 KCP 可靠传输）
     */
    public async sendToPeer(peerId: string, message: BusinessMessage): Promise<void> {
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
        return this.registry.list().map(rec => ({
            id: rec.id,
            iid: rec.iid,
            hostname: rec.hostname,
            nickname: rec.nickname,
            ip: rec.ip,
            port: rec.port,
            transferPort: rec.transferPort,
            lastSeen: rec.lastSeen,
            status: rec.presence,
            meta: rec.meta,
            manual: rec.manual
        }));
    }

    /**
     * 手动扫描网段：向本机每块真实网卡所在网段的每个主机地址单播一个发现请求（目标端口为本机主端口）。
     * 用于广播被过滤的网络——对方收到后会应答并登记我们，应答到达后会出现在联系人里。
     * 只扫主机数不超过 1022 的网段（/22 及更小）；虚拟网卡与本机地址不扫。
     */
    public async scanSubnets(): Promise<{ scanned: number; interfaces: string[]; skipped: string[] }> {
        if (!this._udpServer || !this._isRunning) {
            throw new Error('网络服务未运行');
        }
        if (this._scanning) {
            throw new Error('正在扫描中，请稍候');
        }
        this._scanning = true;
        try {
            const interfaces: string[] = [];
            const skipped: string[] = [];
            const targets = new Set<string>();
            for (const iface of this._lanInterfaces) {
                if (iface.virtual) {
                    continue;
                }
                const hosts = enumerateHosts(iface.address, iface.netmask, SCAN_HOST_LIMIT);
                const label = `${iface.name} ${iface.address}/${iface.prefix}`;
                if (hosts === null) {
                    skipped.push(`${label}（网段过大，超过 ${SCAN_HOST_LIMIT} 个主机）`);
                    continue;
                }
                interfaces.push(label);
                hosts.forEach(h => targets.add(h));
            }

            const buffer = Buffer.from(JSON.stringify(this._baseMessage('discovery_request')));
            const list = Array.from(targets);
            log(`[扫描] 向 ${list.length} 个地址发送单播探测（端口 ${this._port}，网卡：${interfaces.join('；') || '无'}）`);
            for (let i = 0; i < list.length; i += SCAN_BATCH_SIZE) {
                if (!this._isRunning) {
                    break;
                }
                list.slice(i, i + SCAN_BATCH_SIZE).forEach(ip => this._udpSend(buffer, this._port, ip, 'scan'));
                await new Promise<void>(resolve => setTimeout(resolve, SCAN_BATCH_DELAY));
            }
            return { scanned: list.length, interfaces, skipped };
        } finally {
            this._scanning = false;
        }
    }

    /** 本实例的稳定实例 ID（`${machineId}:${端口}`），服务未启动时为空 */
    public getInstanceId(): string {
        return this._instanceId;
    }

    /** 本次启动标识（传输层未启动时为空） */
    public getBoot(): string {
        return this._transport?.boot ?? '';
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
            if (this._isRunning) {
                this.emit('statusChange', this.getStatus());
            }
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
