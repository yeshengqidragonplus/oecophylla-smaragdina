import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as events from 'events';
import { Kcp } from './kcp';
import { log, logError } from './logger';

/**
 * KCP 传输层 - 承载所有业务消息（聊天、文件）
 *
 * 使用独立的 UDP 端口（主 UDP 端口 + 1000），其上跑纯 TS 实现的 KCP
 * 可靠传输（见 kcp.ts）。主 UDP 通道继续用于：广播发现、心跳、在线状态。
 *
 * 数据报格式（第 1 字节区分类型）：
 * - 0x01 控制报文：JSON，用于会话握手与关闭
 *   - {"t":"syn","conv":<n>,"id":"<发起方 peerId>","boot":"<发起方启动标识>"}  建连请求（发起方选随机 conv）
 *   - {"t":"ack","conv":<n>,"id":"<应答方 peerId>","boot":"<应答方启动标识>"}  建连确认
 *   - {"t":"fin","conv":<n>}   会话关闭
 *   - {"t":"rst","conv":<n>}   "我没有这个会话"：收到未知 conv 的 KCP 报文时回复，让对端立刻销毁僵尸会话
 * - 0x02 KCP 报文：原始 KCP 段，conv 标识会话
 *
 * 业务帧格式（KCP 可靠字节流之上）：4 字节大端长度前缀 + JSON 负载，
 * 与原 TCP 实现一致。握手报文自带身份（id 字段），无需单独身份帧。
 * 长度为 0 的帧是保活探测，接收端直接丢弃。
 *
 * 在线检测：握手 SYN 每 500ms 重发，超时（默认 5 秒）未收到 ACK 即判定
 * 对端离线——与原 TCP 建连超时语义一致。
 *
 * 会话仲裁（同一对端出现第二个 SYN 时）：
 * - 同一发起方换了 conv，或对端 boot 标识变了（进程重启过）：旧会话已无意义，直接替换；
 * - 双向同时建连（我们先发起、对端也发起）：发起方 id 字典序较小的会话胜出。
 *
 * 事件（与 TcpTransport 一致）：
 * - 'data' (peerId, Buffer)      收到一条完整业务消息
 * - 'sessionConnected' (peerId)  入站会话握手完成
 * - 'sessionClosed' (peerId)     会话关闭
 * - 'sessionError' (peerId, err) 会话错误（如链路死亡）
 * - 'transportError' (err, target?) socket 级错误（发送失败、权限被拒等）。
 *   注意不使用 'error' 事件名：EventEmitter 对无人监听的 'error' 会直接抛出异常。
 */

const PACKET_CONTROL = 0x01;
const PACKET_KCP = 0x02;

/** SYN 重发间隔 */
const SYN_RETRY_INTERVAL = 500;
/** KCP 时钟驱动间隔（ms），nodelay 模式下保证低延迟 */
const UPDATE_INTERVAL = 10;
/** 发送背压上限：在途+待发段数超过该值时等待 */
const BACKPRESSURE_HIGH = 1024;
/** 背压等待时的轮询间隔 */
const BACKPRESSURE_POLL = 20;
/** 发送确认无进展超时：超过该时长对端未 ACK 任何数据则判定离线 */
const ACK_STALL_TIMEOUT = 5000;
/** 空闲会话回收时间：超过该时长无任何收发则关闭（心跳在主通道，业务通道允许静默） */
const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000;
/** 同一来源同一 conv 的 rst 回复最小间隔，避免对端持续发包时被回复风暴 */
const RST_MIN_INTERVAL = 1000;
/** 同一会话两次保活探测的最小间隔 */
const KEEPALIVE_MIN_INTERVAL = 1000;

export type KcpErrorCode = 'NO_SESSION' | 'SESSION_CLOSED' | 'ACK_TIMEOUT' | 'SEND_FAILED' | 'CONNECT_TIMEOUT';

/** 带错误码的传输层错误，上层据此决定是否重建会话重试 */
export class KcpError extends Error {
    constructor(public readonly code: KcpErrorCode, message: string) {
        super(message);
        this.name = 'KcpError';
    }
}

/** 会话失效类错误：重建会话后重发是安全的 */
export function isRetryableKcpError(err: unknown): boolean {
    return err instanceof KcpError
        && (err.code === 'NO_SESSION' || err.code === 'SESSION_CLOSED' || err.code === 'ACK_TIMEOUT');
}

interface ControlMessage {
    t: 'syn' | 'ack' | 'fin' | 'rst';
    conv?: number;
    id?: string;
    boot?: string;
}

interface KcpSession {
    peerId: string;
    ip: string;
    port: number;
    conv: number;
    /** 本会话发起方的 peerId（双向建连仲裁用） */
    initiator: string;
    /** 对端的启动标识：变化说明对端进程重启过，旧会话作废 */
    remoteBoot?: string;
    kcp: Kcp;
    /** 拆帧缓冲 */
    recvBuffer: Buffer;
    established: boolean;
    lastActive: number;
    lastKeepaliveAt: number;
}

export class KcpTransport extends events.EventEmitter {
    private _socket: dgram.Socket | null = null;
    private _port: number;
    /** 本端 peerId（`ip:主端口`），用于握手身份和双向建连仲裁 */
    private _localId: string = '';
    /** 本进程本次启动的随机标识，随握手发出；对端据此识别"我重启过" */
    private readonly _boot: string = crypto.randomBytes(4).toString('hex');
    /** key: peerId -> session */
    private _sessions: Map<string, KcpSession> = new Map();
    /** key: conv -> session（KCP 报文按 conv 路由） */
    private _convIndex: Map<number, KcpSession> = new Map();
    /** 进行中的建连：同一对端并发 connect 共用一次握手 */
    private _pendingConnects: Map<string, Promise<void>> = new Map();
    /** rst 回复限流：key 为 `ip:port:conv` */
    private _lastRstAt: Map<string, number> = new Map();
    private _updateTimer: ReturnType<typeof setInterval> | null = null;
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

    get boot(): string {
        return this._boot;
    }

    setLocalId(id: string): void {
        this._localId = id;
    }

    /**
     * 启动 KCP 传输（绑定专用 UDP 端口）
     */
    start(): Promise<void> {
        if (this._isRunning) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            // 常驻监听（而不是 once）：第一次错误后监听被移除，之后的 socket 错误会变成未处理异常
            socket.on('error', err => {
                if (!this._isRunning) {
                    socket.close();
                    reject(err);
                } else {
                    this.emit('transportError', err);
                }
            });
            socket.on('message', (msg, rinfo) => this._handlePacket(msg, rinfo));
            socket.bind(this._port, () => {
                this._isRunning = true;
                this._updateTimer = setInterval(() => this._updateAll(), UPDATE_INTERVAL);
                log(`KCP Transport listening on UDP port ${this._port}`);
                resolve();
            });
            this._socket = socket;
        });
    }

    /**
     * 停止 KCP 传输层
     */
    stop(): void {
        this._isRunning = false;

        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = null;
        }

        this._sessions.forEach(session => {
            this._sendControl(session.ip, session.port, { t: 'fin', conv: session.conv });
        });
        this._sessions.clear();
        this._convIndex.clear();
        this._lastRstAt.clear();

        if (this._socket) {
            try {
                this._socket.close();
            } catch (_) { /* ignore */ }
            this._socket = null;
        }

        log('KCP Transport stopped');
    }

    hasSession(peerId: string): boolean {
        const session = this._sessions.get(peerId);
        return !!session && session.established;
    }

    get connectionCount(): number {
        return this._sessions.size;
    }

    /**
     * 主动与远程 peer 握手建立 KCP 会话。
     * SYN 每 500ms 重发，超时未收到 ACK 视为对端离线。
     * 同一对端的并发调用共用一次握手，避免产生多个互相冲突的会话。
     */
    connect(peerId: string, host: string, port: number, timeoutMs: number = 5000): Promise<void> {
        const existing = this._sessions.get(peerId);
        if (existing && existing.established) {
            return Promise.resolve();
        }

        const pending = this._pendingConnects.get(peerId);
        if (pending) {
            return pending;
        }

        const attempt = this._doConnect(peerId, host, port, timeoutMs).finally(() => {
            this._pendingConnects.delete(peerId);
        });
        this._pendingConnects.set(peerId, attempt);
        return attempt;
    }

    private _doConnect(peerId: string, host: string, port: number, timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            // 随机 32 位 conv；同对 peer 碰撞概率可忽略
            const conv = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
            const session = this._createSession(peerId, host, port, conv, this._localId);
            this._sessions.set(peerId, session);
            this._convIndex.set(conv, session);

            log(`[KCP] 发起握手 → ${peerId}（${host}:${port}，conv=${conv}）`);
            const syn: ControlMessage = { t: 'syn', conv, id: this._localId, boot: this._boot };
            this._sendControl(host, port, syn);
            let synCount = 1;
            const retryTimer = setInterval(() => {
                synCount++;
                log(`[KCP] SYN 重发第 ${synCount} 次 → ${peerId}（未收到 ACK）`);
                this._sendControl(host, port, syn);
            }, SYN_RETRY_INTERVAL);

            const cleanup = (): void => {
                clearInterval(retryTimer);
                clearTimeout(timeoutTimer);
                this.removeListener('_established', onEstablished);
            };

            const timeoutTimer = setTimeout(() => {
                cleanup();
                // 仅清理本次未完成的会话；若已被入站会话替换则保留
                const current = this._sessions.get(peerId);
                if (current === session) {
                    this._sessions.delete(peerId);
                }
                if (this._convIndex.get(conv) === session) {
                    this._convIndex.delete(conv);
                }
                logError(`[KCP] 握手超时（${timeoutMs}ms）: ${peerId} 未应答——对方离线、未升级到 KCP 版本或 UDP 端口被防火墙拦截`);
                reject(new KcpError('CONNECT_TIMEOUT', `连接 ${peerId} 超时`));
            }, timeoutMs);

            // 同时监听双向建连仲裁后被入站会话替换的情况：
            // 无论最终生效的是哪个会话，对该 peer 建连成功即可 resolve
            const onEstablished = (estPeerId: string): void => {
                if (estPeerId === peerId) {
                    cleanup();
                    resolve();
                }
            };
            this.on('_established', onEstablished);
        });
    }

    /**
     * 发送一条业务消息（自动加帧），等待对端 KCP 确认后才完成。
     *
     * 与 TCP 不同，KCP 入队即"成功"，对端离线也无从察觉；
     * 因此这里等到发送队列被 ACK 清空才 resolve——确认超时
     * （ACK_STALL_TIMEOUT 内无任何确认进展）视为对端离线，
     * 销毁会话并抛错，对齐原 TCP 写失败的快速失败语义。
     *
     * 失败一律抛 KcpError，上层可据 isRetryableKcpError 决定是否重建会话重试。
     */
    async send(peerId: string, data: Buffer): Promise<void> {
        const session = this._sessions.get(peerId);
        if (!session || !session.established) {
            throw new KcpError('NO_SESSION', `没有到 ${peerId} 的连接`);
        }
        const frame = KcpTransport.encodeFrame(data);

        // 背压：在途段过多时等待 KCP 消化
        while (session.kcp.waitSnd() > BACKPRESSURE_HIGH) {
            if (this._sessions.get(peerId) !== session) {
                throw new KcpError('SESSION_CLOSED', `到 ${peerId} 的连接已断开`);
            }
            await new Promise<void>(r => setTimeout(r, BACKPRESSURE_POLL));
        }

        const ret = session.kcp.send(frame);
        if (ret < 0) {
            throw new KcpError('SEND_FAILED', `KCP 发送失败（code=${ret}）`);
        }
        session.lastActive = Date.now();

        // 等待全部在途数据被对端确认；只要确认有进展就持续等
        let lastWait = session.kcp.waitSnd();
        let stallSince = Date.now();
        while (session.kcp.waitSnd() > 0) {
            if (this._sessions.get(peerId) !== session || session.kcp.isDeadLink) {
                throw new KcpError('SESSION_CLOSED', `到 ${peerId} 的连接已断开`);
            }
            const wait = session.kcp.waitSnd();
            const now = Date.now();
            if (wait < lastWait) {
                lastWait = wait;
                stallSince = now;
            } else if (now - stallSince > ACK_STALL_TIMEOUT) {
                logError(`[KCP] 发送确认停滞 ${ACK_STALL_TIMEOUT}ms（剩余未确认段 ${wait}），判定 ${peerId} 离线，销毁会话`);
                // 尽力通知对端丢弃会话（对端若还活着，就不会留下一个单边的僵尸会话）
                this._sendControl(session.ip, session.port, { t: 'fin', conv: session.conv });
                this._destroySession(session, true);
                throw new KcpError('ACK_TIMEOUT', `发送至 ${peerId} 确认超时（对端可能已离线）`);
            }
            await new Promise<void>(r => setTimeout(r, BACKPRESSURE_POLL));
        }
        session.lastActive = Date.now();
    }

    /**
     * 断开与某个 peer 的会话
     */
    disconnect(peerId: string): void {
        const session = this._sessions.get(peerId);
        if (session) {
            this._sendControl(session.ip, session.port, { t: 'fin', conv: session.conv });
            this._destroySession(session, false);
        }
    }

    private static encodeFrame(payload: Buffer): Buffer {
        const frame = Buffer.allocUnsafe(4 + payload.length);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        return frame;
    }

    // ==================== 收包入口 ====================

    private _handlePacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        if (msg.length < 1) {
            return;
        }
        const type = msg.readUInt8(0);
        if (type === PACKET_CONTROL) {
            this._handleControl(msg.subarray(1), rinfo);
        } else if (type === PACKET_KCP) {
            this._handleKcpPacket(msg.subarray(1), rinfo);
        }
    }

    private _handleControl(payload: Buffer, rinfo: dgram.RemoteInfo): void {
        let ctrl: ControlMessage;
        try {
            ctrl = JSON.parse(payload.toString('utf-8')) as ControlMessage;
        } catch {
            return;
        }

        switch (ctrl.t) {
            case 'syn':
                this._handleSyn(ctrl, rinfo);
                break;
            case 'ack':
                this._handleAck(ctrl);
                break;
            case 'fin':
                this._handleFin(ctrl);
                break;
            case 'rst':
                this._handleRst(ctrl, rinfo);
                break;
        }
    }

    /** 入站建连请求 */
    private _handleSyn(ctrl: ControlMessage, rinfo: dgram.RemoteInfo): void {
        if (!ctrl.id || typeof ctrl.conv !== 'number' || ctrl.conv === 0) {
            return;
        }
        const peerId = ctrl.id;
        const conv = ctrl.conv >>> 0;
        const remoteBoot = typeof ctrl.boot === 'string' ? ctrl.boot : undefined;
        const existing = this._sessions.get(peerId);

        if (existing) {
            if (existing.conv === conv) {
                // SYN 重发：幂等地再次确认
                this._sendControl(rinfo.address, rinfo.port, { t: 'ack', conv, id: this._localId, boot: this._boot });
                return;
            }

            const peerRestarted = !!remoteBoot && !!existing.remoteBoot && remoteBoot !== existing.remoteBoot;
            if (existing.initiator === peerId || peerRestarted) {
                // 同一发起方换了 conv（它丢了旧会话），或对端进程重启过：旧会话已无意义，直接替换。
                // 旧实现在这里按"发起方 id 字典序"仲裁，同一发起方时恒判旧会话胜出，
                // 导致对端重启/睡眠唤醒后的新握手被忽略，最长 10 分钟单向不通。
                log(`[KCP] ${peerId} ${peerRestarted ? '已重启' : '重新发起了握手'}，替换旧会话（conv ${existing.conv} → ${conv}）`);
                this._destroySession(existing, false);
            } else if (existing.initiator <= peerId) {
                // 双向同时建连：我们先发起且我方 id 较小，已有会话胜出，忽略对方的 SYN
                log(`[KCP] 双向建连仲裁：保留已有会话（发起方 ${existing.initiator}），忽略 ${peerId} 的 SYN`);
                if (existing.established) {
                    // 已有会话若已建立，对端又来了新 SYN，说明对端可能单边丢了会话：
                    // 发一个保活探测——对端没有该会话会回 rst，我们销毁后，对端下一次 SYN 重发即可建连
                    this._sendKeepalive(existing);
                }
                return;
            } else {
                log(`[KCP] 双向建连仲裁：${peerId} 发起的会话胜出，替换已有会话（发起方 ${existing.initiator}）`);
                this._destroySession(existing, false);
            }
        }

        const session = this._createSession(peerId, rinfo.address, rinfo.port, conv, peerId);
        session.remoteBoot = remoteBoot;
        session.established = true;
        this._sessions.set(peerId, session);
        this._convIndex.set(conv, session);
        this._sendControl(rinfo.address, rinfo.port, { t: 'ack', conv, id: this._localId, boot: this._boot });
        log(`KCP inbound session established: ${peerId}`);
        this.emit('sessionConnected', peerId);
        this.emit('_established', peerId);
    }

    /** 建连确认（本端是发起方） */
    private _handleAck(ctrl: ControlMessage): void {
        if (typeof ctrl.conv !== 'number') {
            return;
        }
        const session = this._convIndex.get(ctrl.conv >>> 0);
        if (!session || session.established) {
            return;
        }
        session.established = true;
        session.remoteBoot = typeof ctrl.boot === 'string' ? ctrl.boot : undefined;
        session.lastActive = Date.now();
        log(`KCP connected to ${session.peerId}`);
        this.emit('_established', session.peerId);
    }

    private _handleFin(ctrl: ControlMessage): void {
        if (typeof ctrl.conv !== 'number') {
            return;
        }
        const session = this._convIndex.get(ctrl.conv >>> 0);
        if (session) {
            log(`[KCP] 收到 ${session.peerId} 的 FIN，关闭会话`);
            this._destroySession(session, true);
        }
    }

    /** 对端声明没有这个会话（它重启过或已丢弃）：立即销毁本端的僵尸会话 */
    private _handleRst(ctrl: ControlMessage, rinfo: dgram.RemoteInfo): void {
        if (typeof ctrl.conv !== 'number') {
            return;
        }
        const session = this._convIndex.get(ctrl.conv >>> 0);
        // 只处理已建立的会话（握手进行中的由 SYN 重发与超时处理），且来源必须是该会话的对端
        if (!session || !session.established || session.ip !== rinfo.address) {
            return;
        }
        log(`[KCP] 收到 ${session.peerId} 的 RST：对端已没有该会话（可能重启过），销毁僵尸会话`);
        this._destroySession(session, true);
    }

    /** KCP 数据报：按 conv 路由到会话 */
    private _handleKcpPacket(packet: Buffer, rinfo: dgram.RemoteInfo): void {
        if (packet.length < 24) {
            return;
        }
        const conv = packet.readUInt32LE(0);
        const session = this._convIndex.get(conv);
        if (!session) {
            // 本端没有这个会话（重启过或已销毁）：告诉对端，让它别再往僵尸会话里发
            this._sendRst(rinfo, conv);
            return;
        }
        if (!session.established) {
            return;
        }
        if (session.kcp.input(packet) < 0) {
            return;
        }
        session.lastActive = Date.now();

        // 取出所有完整 KCP 消息，进入拆帧
        let data = session.kcp.recv();
        while (data !== null) {
            this._feedFraming(session, data);
            data = session.kcp.recv();
        }
    }

    private _sendRst(rinfo: dgram.RemoteInfo, conv: number): void {
        const key = `${rinfo.address}:${rinfo.port}:${conv}`;
        const now = Date.now();
        const last = this._lastRstAt.get(key);
        if (last !== undefined && now - last < RST_MIN_INTERVAL) {
            return;
        }
        if (this._lastRstAt.size > 1000) {
            this._lastRstAt.clear();
        }
        this._lastRstAt.set(key, now);
        this._sendControl(rinfo.address, rinfo.port, { t: 'rst', conv });
    }

    /** 保活探测：发一个长度为 0 的空帧，对端没有该会话时会回 rst */
    private _sendKeepalive(session: KcpSession): void {
        const now = Date.now();
        if (now - session.lastKeepaliveAt < KEEPALIVE_MIN_INTERVAL) {
            return;
        }
        session.lastKeepaliveAt = now;
        session.kcp.send(KcpTransport.encodeFrame(Buffer.alloc(0)));
    }

    /**
     * 拆帧：按 4 字节长度前缀切出完整业务帧后上报
     */
    private _feedFraming(session: KcpSession, chunk: Buffer): void {
        session.recvBuffer = session.recvBuffer.length === 0
            ? chunk
            : Buffer.concat([session.recvBuffer, chunk]);

        while (session.recvBuffer.length >= 4) {
            const frameLength = session.recvBuffer.readUInt32BE(0);
            if (frameLength > KcpTransport.MAX_FRAME_SIZE) {
                logError(`KCP frame too large (${frameLength} bytes), closing session`);
                this.disconnect(session.peerId);
                return;
            }
            if (session.recvBuffer.length < 4 + frameLength) {
                break;
            }
            const frame = session.recvBuffer.subarray(4, 4 + frameLength);
            session.recvBuffer = session.recvBuffer.subarray(4 + frameLength);
            if (frameLength === 0) {
                continue; // 保活探测，不是业务帧
            }
            this.emit('data', session.peerId, frame);
        }
    }

    // ==================== 会话管理 ====================

    private _createSession(peerId: string, ip: string, port: number, conv: number, initiator: string): KcpSession {
        const kcp = new Kcp(conv);
        // 极速模式：nodelay、10ms 时钟、快速重传阈值 2、关闭拥塞控制（内网场景）
        kcp.setNodelay(1, UPDATE_INTERVAL, 2, 1);
        kcp.setWndSize(256, 256);
        const session: KcpSession = {
            peerId, ip, port, conv, initiator, kcp,
            recvBuffer: Buffer.alloc(0),
            established: false,
            lastActive: Date.now(),
            lastKeepaliveAt: 0
        };
        kcp.setOutput(data => {
            if (!this._socket) {
                return;
            }
            const packet = Buffer.allocUnsafe(1 + data.length);
            packet.writeUInt8(PACKET_KCP, 0);
            data.copy(packet, 1);
            this._rawSend(packet, session.port, session.ip);
        });
        return session;
    }

    private _destroySession(session: KcpSession, emitClosed: boolean): void {
        if (this._sessions.get(session.peerId) === session) {
            this._sessions.delete(session.peerId);
        }
        if (this._convIndex.get(session.conv) === session) {
            this._convIndex.delete(session.conv);
        }
        if (emitClosed) {
            this.emit('sessionClosed', session.peerId);
        }
    }

    /** KCP 时钟驱动 + 死链/空闲检测 */
    private _updateAll(): void {
        const now = Date.now();
        for (const session of Array.from(this._sessions.values())) {
            session.kcp.update(now & 0xffffffff);

            if (session.kcp.isDeadLink) {
                logError(`KCP dead link: ${session.peerId}`);
                this.emit('sessionError', session.peerId, new Error('KCP 链路死亡（重传超限）'));
                this._destroySession(session, true);
                continue;
            }
            if (session.established &&
                session.kcp.waitSnd() === 0 &&
                now - session.lastActive > SESSION_IDLE_TIMEOUT) {
                log(`[KCP] 会话 ${session.peerId} 空闲超过 ${SESSION_IDLE_TIMEOUT / 60000} 分钟，回收`);
                this._sendControl(session.ip, session.port, { t: 'fin', conv: session.conv });
                this._destroySession(session, true);
            }
        }
    }

    private _sendControl(ip: string, port: number, ctrl: ControlMessage): void {
        if (!this._socket) {
            return;
        }
        const payload = Buffer.from(JSON.stringify(ctrl), 'utf-8');
        const packet = Buffer.allocUnsafe(1 + payload.length);
        packet.writeUInt8(PACKET_CONTROL, 0);
        payload.copy(packet, 1);
        this._rawSend(packet, port, ip);
    }

    /** 统一的 UDP 发送：带回调，失败只上报 'transportError'，不抛出 */
    private _rawSend(packet: Buffer, port: number, ip: string): void {
        const socket = this._socket;
        if (!socket) {
            return;
        }
        const target = `${ip}:${port}`;
        try {
            socket.send(packet, 0, packet.length, port, ip, err => {
                if (err) {
                    this.emit('transportError', err, target);
                }
            });
        } catch (err) {
            this.emit('transportError', err as Error, target);
        }
    }
}
