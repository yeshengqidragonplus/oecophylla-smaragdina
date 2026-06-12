import * as dgram from 'dgram';
import * as events from 'events';
import { Kcp } from './kcp';

/**
 * KCP 传输层 - 承载所有业务消息（聊天、文件）
 *
 * 使用独立的 UDP 端口（主 UDP 端口 + 1000），其上跑纯 TS 实现的 KCP
 * 可靠传输（见 kcp.ts）。主 UDP 通道继续用于：广播发现、心跳、在线状态。
 *
 * 数据报格式（第 1 字节区分类型）：
 * - 0x01 控制报文：JSON，用于会话握手与关闭
 *   - {"t":"syn","conv":<n>,"id":"<发起方 peerId>"}  建连请求（发起方选随机 conv）
 *   - {"t":"ack","conv":<n>,"id":"<应答方 peerId>"}  建连确认
 *   - {"t":"fin","conv":<n>}                          会话关闭
 * - 0x02 KCP 报文：原始 KCP 段，conv 标识会话
 *
 * 业务帧格式（KCP 可靠字节流之上）：4 字节大端长度前缀 + JSON 负载，
 * 与原 TCP 实现一致。握手报文自带身份（id 字段），无需单独身份帧。
 *
 * 在线检测：握手 SYN 每 500ms 重发，超时（默认 5 秒）未收到 ACK 即判定
 * 对端离线——与原 TCP 建连超时语义一致。
 *
 * 双向同时建连仲裁：发起方 peerId 字典序较小的一方的会话胜出。
 *
 * 事件（与 TcpTransport 一致）：
 * - 'data' (peerId, Buffer)      收到一条完整业务消息
 * - 'sessionConnected' (peerId)  入站会话握手完成
 * - 'sessionClosed' (peerId)     会话关闭
 * - 'sessionError' (peerId, err) 会话错误（如链路死亡）
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

interface ControlMessage {
    t: 'syn' | 'ack' | 'fin';
    conv?: number;
    id?: string;
}

interface KcpSession {
    peerId: string;
    ip: string;
    port: number;
    conv: number;
    /** 本会话发起方的 peerId（双向建连仲裁用） */
    initiator: string;
    kcp: Kcp;
    /** 拆帧缓冲 */
    recvBuffer: Buffer;
    established: boolean;
    lastActive: number;
}

export class KcpTransport extends events.EventEmitter {
    private _socket: dgram.Socket | null = null;
    private _port: number;
    /** 本端 peerId（`ip:主端口`），用于握手身份和双向建连仲裁 */
    private _localId: string = '';
    /** key: peerId -> session */
    private _sessions: Map<string, KcpSession> = new Map();
    /** key: conv -> session（KCP 报文按 conv 路由） */
    private _convIndex: Map<number, KcpSession> = new Map();
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
            socket.once('error', err => {
                if (!this._isRunning) {
                    socket.close();
                    reject(err);
                } else {
                    this.emit('error', err);
                }
            });
            socket.on('message', (msg, rinfo) => this._handlePacket(msg, rinfo));
            socket.bind(this._port, () => {
                this._isRunning = true;
                this._updateTimer = setInterval(() => this._updateAll(), UPDATE_INTERVAL);
                console.log(`KCP Transport listening on UDP port ${this._port}`);
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

        if (this._socket) {
            try {
                this._socket.close();
            } catch (_) { /* ignore */ }
            this._socket = null;
        }

        console.log('KCP Transport stopped');
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
     */
    connect(peerId: string, host: string, port: number, timeoutMs: number = 5000): Promise<void> {
        const existing = this._sessions.get(peerId);
        if (existing && existing.established) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            // 随机 32 位 conv；同对 peer 碰撞概率可忽略
            const conv = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
            const session = this._createSession(peerId, host, port, conv, this._localId);
            this._sessions.set(peerId, session);
            this._convIndex.set(conv, session);

            const syn: ControlMessage = { t: 'syn', conv, id: this._localId };
            this._sendControl(host, port, syn);
            const retryTimer = setInterval(() => {
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
                this._convIndex.delete(conv);
                reject(new Error(`连接 ${peerId} 超时`));
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
     */
    async send(peerId: string, data: Buffer): Promise<void> {
        const session = this._sessions.get(peerId);
        if (!session || !session.established) {
            throw new Error(`没有到 ${peerId} 的连接`);
        }
        const frame = KcpTransport.encodeFrame(data);

        // 背压：在途段过多时等待 KCP 消化
        while (session.kcp.waitSnd() > BACKPRESSURE_HIGH) {
            if (this._sessions.get(peerId) !== session) {
                throw new Error(`到 ${peerId} 的连接已断开`);
            }
            await new Promise<void>(r => setTimeout(r, BACKPRESSURE_POLL));
        }

        const ret = session.kcp.send(frame);
        if (ret < 0) {
            throw new Error(`KCP 发送失败（code=${ret}）`);
        }
        session.lastActive = Date.now();

        // 等待全部在途数据被对端确认；只要确认有进展就持续等
        let lastWait = session.kcp.waitSnd();
        let stallSince = Date.now();
        while (session.kcp.waitSnd() > 0) {
            if (this._sessions.get(peerId) !== session || session.kcp.isDeadLink) {
                throw new Error(`到 ${peerId} 的连接已断开`);
            }
            const wait = session.kcp.waitSnd();
            const now = Date.now();
            if (wait < lastWait) {
                lastWait = wait;
                stallSince = now;
            } else if (now - stallSince > ACK_STALL_TIMEOUT) {
                this._destroySession(session, true);
                throw new Error(`发送至 ${peerId} 确认超时（对端可能已离线）`);
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
            this._handleKcpPacket(msg.subarray(1));
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
        }
    }

    /** 入站建连请求 */
    private _handleSyn(ctrl: ControlMessage, rinfo: dgram.RemoteInfo): void {
        if (!ctrl.id || typeof ctrl.conv !== 'number' || ctrl.conv === 0) {
            return;
        }
        const peerId = ctrl.id;
        const conv = ctrl.conv >>> 0;
        const existing = this._sessions.get(peerId);

        if (existing) {
            if (existing.conv === conv) {
                // SYN 重发：幂等地再次确认
                this._sendControl(rinfo.address, rinfo.port, { t: 'ack', conv, id: this._localId });
                return;
            }
            // 双向同时建连：发起方 peerId 字典序较小者胜出
            if (existing.initiator <= peerId) {
                // 已有会话胜出（含本端先发起且本端 id 较小的情况），忽略对方的 SYN
                return;
            }
            this._destroySession(existing, false);
        }

        const session = this._createSession(peerId, rinfo.address, rinfo.port, conv, peerId);
        session.established = true;
        this._sessions.set(peerId, session);
        this._convIndex.set(conv, session);
        this._sendControl(rinfo.address, rinfo.port, { t: 'ack', conv, id: this._localId });
        console.log(`KCP inbound session established: ${peerId}`);
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
        session.lastActive = Date.now();
        console.log(`KCP connected to ${session.peerId}`);
        this.emit('_established', session.peerId);
    }

    private _handleFin(ctrl: ControlMessage): void {
        if (typeof ctrl.conv !== 'number') {
            return;
        }
        const session = this._convIndex.get(ctrl.conv >>> 0);
        if (session) {
            this._destroySession(session, true);
        }
    }

    /** KCP 数据报：按 conv 路由到会话 */
    private _handleKcpPacket(packet: Buffer): void {
        if (packet.length < 24) {
            return;
        }
        const conv = packet.readUInt32LE(0);
        const session = this._convIndex.get(conv);
        if (!session || !session.established) {
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
                console.error(`KCP frame too large (${frameLength} bytes), closing session`);
                this.disconnect(session.peerId);
                return;
            }
            if (session.recvBuffer.length < 4 + frameLength) {
                break;
            }
            const frame = session.recvBuffer.subarray(4, 4 + frameLength);
            session.recvBuffer = session.recvBuffer.subarray(4 + frameLength);
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
            lastActive: Date.now()
        };
        kcp.setOutput(data => {
            if (!this._socket) {
                return;
            }
            const packet = Buffer.allocUnsafe(1 + data.length);
            packet.writeUInt8(PACKET_KCP, 0);
            data.copy(packet, 1);
            this._socket.send(packet, 0, packet.length, session.port, session.ip);
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
                console.error(`KCP dead link: ${session.peerId}`);
                this.emit('sessionError', session.peerId, new Error('KCP 链路死亡（重传超限）'));
                this._destroySession(session, true);
                continue;
            }
            if (session.established &&
                session.kcp.waitSnd() === 0 &&
                now - session.lastActive > SESSION_IDLE_TIMEOUT) {
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
        this._socket.send(packet, 0, packet.length, port, ip);
    }
}
