/**
 * KCP 协议核心 —— 纯 TypeScript 实现，无任何原生依赖。
 *
 * 移植自 skywind3000/kcp 的 ikcp.c（ARQ 部分，不含 FEC）：
 * 选择重传、快速重传（fastack）、RTO 计算、滑动窗口、
 * 拥塞控制（慢启动/拥塞避免）、远端窗口探测。
 *
 * 本类只实现协议状态机，不持有任何 socket：
 * 下层收到的 UDP 数据喂给 input()，需要发包时通过 setOutput()
 * 注册的回调把封装好的 KCP 报文交给调用方发送。
 *
 * 所有 32 位字段用 `>>> 0` 保持无符号语义，
 * 时间差用 32 位有符号比较（_itimediff），与 C 实现一致。
 */

const IKCP_RTO_NDL = 30;        // nodelay 模式最小 RTO
const IKCP_RTO_MIN = 100;       // 普通模式最小 RTO
const IKCP_RTO_DEF = 200;
const IKCP_RTO_MAX = 60000;
const IKCP_CMD_PUSH = 81;       // 数据
const IKCP_CMD_ACK = 82;        // 确认
const IKCP_CMD_WASK = 83;       // 窗口探测请求
const IKCP_CMD_WINS = 84;       // 窗口大小通告
const IKCP_ASK_SEND = 1;
const IKCP_ASK_TELL = 2;
const IKCP_WND_SND = 32;
const IKCP_WND_RCV = 128;
const IKCP_MTU_DEF = 1400;
const IKCP_INTERVAL = 100;
const IKCP_OVERHEAD = 24;       // 段头长度
const IKCP_DEADLINK = 20;       // 单段重传次数上限，超过判定链路死亡
const IKCP_THRESH_INIT = 2;
const IKCP_THRESH_MIN = 2;
const IKCP_PROBE_INIT = 7000;   // 窗口探测初始间隔
const IKCP_PROBE_LIMIT = 120000;

/** 32 位回绕安全的时间/序号差值（有符号） */
function _itimediff(later: number, earlier: number): number {
    return ((later >>> 0) - (earlier >>> 0)) | 0;
}

function _ibound(lower: number, middle: number, upper: number): number {
    return Math.min(Math.max(lower, middle), upper);
}

class Segment {
    conv = 0;
    cmd = 0;
    frg = 0;
    wnd = 0;
    ts = 0;
    sn = 0;
    una = 0;
    resendts = 0;
    rto = 0;
    fastack = 0;
    xmit = 0;
    data: Buffer;

    constructor(data: Buffer = Buffer.alloc(0)) {
        this.data = data;
    }

    /** 把段头 + 数据编码进 buf 的 offset 处，返回新 offset */
    encode(buf: Buffer, offset: number): number {
        buf.writeUInt32LE(this.conv >>> 0, offset);
        buf.writeUInt8(this.cmd & 0xff, offset + 4);
        buf.writeUInt8(this.frg & 0xff, offset + 5);
        buf.writeUInt16LE(this.wnd & 0xffff, offset + 6);
        buf.writeUInt32LE(this.ts >>> 0, offset + 8);
        buf.writeUInt32LE(this.sn >>> 0, offset + 12);
        buf.writeUInt32LE(this.una >>> 0, offset + 16);
        buf.writeUInt32LE(this.data.length >>> 0, offset + 20);
        this.data.copy(buf, offset + IKCP_OVERHEAD);
        return offset + IKCP_OVERHEAD + this.data.length;
    }
}

export type KcpOutput = (data: Buffer) => void;

export class Kcp {
    private conv: number;
    private mtu = IKCP_MTU_DEF;
    private mss = IKCP_MTU_DEF - IKCP_OVERHEAD;
    private state = 0;                 // 0 正常，-1 链路死亡

    private snd_una = 0;
    private snd_nxt = 0;
    private rcv_nxt = 0;

    private ssthresh = IKCP_THRESH_INIT;
    private rx_rttval = 0;
    private rx_srtt = 0;
    private rx_rto = IKCP_RTO_DEF;
    private rx_minrto = IKCP_RTO_MIN;

    private snd_wnd = IKCP_WND_SND;
    private rcv_wnd = IKCP_WND_RCV;
    private rmt_wnd = IKCP_WND_RCV;
    private cwnd = 0;
    private probe = 0;

    private current = 0;
    private interval = IKCP_INTERVAL;
    private ts_flush = IKCP_INTERVAL;
    private nrcv_buf = 0;

    private nodelayMode = 0;
    private updated = false;

    private ts_probe = 0;
    private probe_wait = 0;

    private dead_link = IKCP_DEADLINK;
    private incr = 0;

    private snd_queue: Segment[] = [];
    private rcv_queue: Segment[] = [];
    private snd_buf: Segment[] = [];
    private rcv_buf: Segment[] = [];

    /** 待发送的 ack 列表 [sn, ts] */
    private acklist: Array<[number, number]> = [];

    private fastresend = 0;
    private fastlimit = 5;
    private nocwnd = 0;
    private stream = 0;

    private output: KcpOutput = () => { /* 未设置时丢弃 */ };

    constructor(conv: number) {
        this.conv = conv >>> 0;
    }

    setOutput(output: KcpOutput): void {
        this.output = output;
    }

    /** 链路是否已判定死亡（重传超限） */
    get isDeadLink(): boolean {
        return this.state === -1;
    }

    get convId(): number {
        return this.conv;
    }

    /**
     * 上层收包：取出一条完整消息，无完整消息返回 null
     */
    recv(): Buffer | null {
        if (this.rcv_queue.length === 0) {
            return null;
        }
        const peeksize = this.peekSize();
        if (peeksize < 0) {
            return null;
        }

        const recover = this.rcv_queue.length >= this.rcv_wnd;

        // 合并分片
        const parts: Buffer[] = [];
        let count = 0;
        for (const seg of this.rcv_queue) {
            parts.push(seg.data);
            count++;
            if (seg.frg === 0) {
                break;
            }
        }
        this.rcv_queue.splice(0, count);
        const data = Buffer.concat(parts);

        // 把 rcv_buf 中连续可用的段移入 rcv_queue
        this._moveRcvBufToQueue();

        // 接收窗口恢复，通知远端
        if (this.rcv_queue.length < this.rcv_wnd && recover) {
            this.probe |= IKCP_ASK_TELL;
        }
        return data;
    }

    /** 下一条完整消息的长度，没有则 -1 */
    peekSize(): number {
        if (this.rcv_queue.length === 0) {
            return -1;
        }
        const seg = this.rcv_queue[0];
        if (seg.frg === 0) {
            return seg.data.length;
        }
        if (this.rcv_queue.length < seg.frg + 1) {
            return -1;
        }
        let length = 0;
        for (const s of this.rcv_queue) {
            length += s.data.length;
            if (s.frg === 0) {
                break;
            }
        }
        return length;
    }

    /**
     * 上层发送：自动按 mss 分片入队，flush 时真正发出。
     * 返回 0 成功，<0 失败（消息过大）
     */
    send(buffer: Buffer): number {
        if (buffer.length === 0) {
            return -1;
        }
        let offset = 0;

        // 流模式：尝试并入上一段尾部
        if (this.stream !== 0 && this.snd_queue.length > 0) {
            const last = this.snd_queue[this.snd_queue.length - 1];
            if (last.data.length < this.mss) {
                const capacity = this.mss - last.data.length;
                const extend = Math.min(buffer.length, capacity);
                last.data = Buffer.concat([last.data, buffer.subarray(0, extend)]);
                last.frg = 0;
                offset = extend;
            }
            if (offset >= buffer.length) {
                return 0;
            }
        }

        const remaining = buffer.length - offset;
        const count = remaining <= this.mss ? 1 : Math.ceil(remaining / this.mss);
        if (count >= IKCP_WND_RCV) {
            return -2; // 消息过大，超过接收窗口能承载的分片数
        }

        for (let i = 0; i < count; i++) {
            const size = Math.min(this.mss, buffer.length - offset);
            const seg = new Segment(buffer.subarray(offset, offset + size));
            seg.frg = this.stream === 0 ? (count - i - 1) : 0;
            this.snd_queue.push(seg);
            offset += size;
        }
        return 0;
    }

    /** 更新 RTT 估计与 RTO */
    private _updateAck(rtt: number): void {
        if (this.rx_srtt === 0) {
            this.rx_srtt = rtt;
            this.rx_rttval = rtt / 2;
        } else {
            let delta = rtt - this.rx_srtt;
            if (delta < 0) {
                delta = -delta;
            }
            this.rx_rttval = (3 * this.rx_rttval + delta) / 4;
            this.rx_srtt = (7 * this.rx_srtt + rtt) / 8;
            if (this.rx_srtt < 1) {
                this.rx_srtt = 1;
            }
        }
        const rto = this.rx_srtt + Math.max(this.interval, 4 * this.rx_rttval);
        this.rx_rto = _ibound(this.rx_minrto, rto, IKCP_RTO_MAX);
    }

    private _shrinkBuf(): void {
        if (this.snd_buf.length > 0) {
            this.snd_una = this.snd_buf[0].sn;
        } else {
            this.snd_una = this.snd_nxt;
        }
    }

    private _parseAck(sn: number): void {
        if (_itimediff(sn, this.snd_una) < 0 || _itimediff(sn, this.snd_nxt) >= 0) {
            return;
        }
        for (let i = 0; i < this.snd_buf.length; i++) {
            const seg = this.snd_buf[i];
            if (sn === seg.sn) {
                this.snd_buf.splice(i, 1);
                break;
            }
            if (_itimediff(sn, seg.sn) < 0) {
                break;
            }
        }
    }

    private _parseUna(una: number): void {
        let count = 0;
        for (const seg of this.snd_buf) {
            if (_itimediff(una, seg.sn) > 0) {
                count++;
            } else {
                break;
            }
        }
        if (count > 0) {
            this.snd_buf.splice(0, count);
        }
    }

    private _parseFastack(sn: number, ts: number): void {
        if (_itimediff(sn, this.snd_una) < 0 || _itimediff(sn, this.snd_nxt) >= 0) {
            return;
        }
        for (const seg of this.snd_buf) {
            if (_itimediff(sn, seg.sn) < 0) {
                break;
            } else if (sn !== seg.sn && _itimediff(seg.ts, ts) <= 0) {
                seg.fastack++;
            }
        }
    }

    /** 收到的数据段插入 rcv_buf（按 sn 有序、去重），并搬运连续段 */
    private _parseData(newseg: Segment): void {
        const sn = newseg.sn;
        if (_itimediff(sn, (this.rcv_nxt + this.rcv_wnd) >>> 0) >= 0 ||
            _itimediff(sn, this.rcv_nxt) < 0) {
            return;
        }

        // 从尾部向前找插入位置
        let insertIdx = this.rcv_buf.length;
        let repeat = false;
        for (let i = this.rcv_buf.length - 1; i >= 0; i--) {
            const seg = this.rcv_buf[i];
            if (seg.sn === sn) {
                repeat = true;
                break;
            }
            if (_itimediff(sn, seg.sn) > 0) {
                insertIdx = i + 1;
                break;
            }
            insertIdx = i;
        }
        if (!repeat) {
            this.rcv_buf.splice(insertIdx, 0, newseg);
            this.nrcv_buf++;
        }

        this._moveRcvBufToQueue();
    }

    private _moveRcvBufToQueue(): void {
        let count = 0;
        for (const seg of this.rcv_buf) {
            if (seg.sn === this.rcv_nxt && this.rcv_queue.length + count < this.rcv_wnd) {
                this.rcv_nxt = (this.rcv_nxt + 1) >>> 0;
                count++;
            } else {
                break;
            }
        }
        if (count > 0) {
            const moved = this.rcv_buf.splice(0, count);
            this.rcv_queue.push(...moved);
            this.nrcv_buf -= count;
        }
    }

    /**
     * 下层收包：把收到的 UDP 负载（一个或多个 KCP 段）喂给协议栈。
     * 返回 0 正常，<0 数据非法
     */
    input(data: Buffer): number {
        const prev_una = this.snd_una;
        let maxack = 0;
        let latest_ts = 0;
        let flag = false;

        if (data.length < IKCP_OVERHEAD) {
            return -1;
        }

        let offset = 0;
        while (offset + IKCP_OVERHEAD <= data.length) {
            const conv = data.readUInt32LE(offset);
            if (conv !== this.conv) {
                return -1;
            }
            const cmd = data.readUInt8(offset + 4);
            const frg = data.readUInt8(offset + 5);
            const wnd = data.readUInt16LE(offset + 6);
            const ts = data.readUInt32LE(offset + 8);
            const sn = data.readUInt32LE(offset + 12);
            const una = data.readUInt32LE(offset + 16);
            const len = data.readUInt32LE(offset + 20);
            offset += IKCP_OVERHEAD;

            if (data.length - offset < len) {
                return -2;
            }
            if (cmd !== IKCP_CMD_PUSH && cmd !== IKCP_CMD_ACK &&
                cmd !== IKCP_CMD_WASK && cmd !== IKCP_CMD_WINS) {
                return -3;
            }

            this.rmt_wnd = wnd;
            this._parseUna(una);
            this._shrinkBuf();

            if (cmd === IKCP_CMD_ACK) {
                if (_itimediff(this.current, ts) >= 0) {
                    this._updateAck(_itimediff(this.current, ts));
                }
                this._parseAck(sn);
                this._shrinkBuf();
                if (!flag) {
                    flag = true;
                    maxack = sn;
                    latest_ts = ts;
                } else if (_itimediff(sn, maxack) > 0) {
                    maxack = sn;
                    latest_ts = ts;
                }
            } else if (cmd === IKCP_CMD_PUSH) {
                if (_itimediff(sn, (this.rcv_nxt + this.rcv_wnd) >>> 0) < 0) {
                    this.acklist.push([sn, ts]);
                    if (_itimediff(sn, this.rcv_nxt) >= 0) {
                        const seg = new Segment(Buffer.from(data.subarray(offset, offset + len)));
                        seg.conv = conv;
                        seg.cmd = cmd;
                        seg.frg = frg;
                        seg.wnd = wnd;
                        seg.ts = ts;
                        seg.sn = sn;
                        seg.una = una;
                        this._parseData(seg);
                    }
                }
            } else if (cmd === IKCP_CMD_WASK) {
                this.probe |= IKCP_ASK_TELL;
            }
            // IKCP_CMD_WINS：仅更新 rmt_wnd（上面已做），无需其他处理

            offset += len;
        }

        if (flag) {
            this._parseFastack(maxack, latest_ts);
        }

        // 确认了新数据 → 拥塞窗口增长
        if (_itimediff(this.snd_una, prev_una) > 0) {
            if (this.cwnd < this.rmt_wnd) {
                const mss = this.mss;
                if (this.cwnd < this.ssthresh) {
                    this.cwnd++;
                    this.incr += mss;
                } else {
                    if (this.incr < mss) {
                        this.incr = mss;
                    }
                    this.incr += (mss * mss) / this.incr + (mss / 16);
                    if ((this.cwnd + 1) * mss <= this.incr) {
                        this.cwnd = Math.floor((this.incr + mss - 1) / (mss > 0 ? mss : 1));
                    }
                }
                if (this.cwnd > this.rmt_wnd) {
                    this.cwnd = this.rmt_wnd;
                    this.incr = this.rmt_wnd * mss;
                }
            }
        }
        return 0;
    }

    private _wndUnused(): number {
        if (this.rcv_queue.length < this.rcv_wnd) {
            return this.rcv_wnd - this.rcv_queue.length;
        }
        return 0;
    }

    /**
     * 把待发数据/ack/探测真正打包经 output 发出
     */
    flush(): void {
        if (!this.updated) {
            return;
        }
        const current = this.current;
        // 复用一个 mtu 大小的发送缓冲，攒满即发
        const buffer = Buffer.allocUnsafe((this.mtu + IKCP_OVERHEAD) * 3);
        let ptr = 0;

        const flushBuffer = (need: number): void => {
            if (ptr + need > this.mtu) {
                this.output(Buffer.from(buffer.subarray(0, ptr)));
                ptr = 0;
            }
        };

        const seg = new Segment();
        seg.conv = this.conv;
        seg.cmd = IKCP_CMD_ACK;
        seg.wnd = this._wndUnused();
        seg.una = this.rcv_nxt;

        // 发 ack
        for (const [sn, ts] of this.acklist) {
            flushBuffer(IKCP_OVERHEAD);
            seg.sn = sn;
            seg.ts = ts;
            ptr = seg.encode(buffer, ptr);
        }
        this.acklist = [];

        // 远端窗口为 0 时探测
        if (this.rmt_wnd === 0) {
            if (this.probe_wait === 0) {
                this.probe_wait = IKCP_PROBE_INIT;
                this.ts_probe = (current + this.probe_wait) >>> 0;
            } else if (_itimediff(current, this.ts_probe) >= 0) {
                if (this.probe_wait < IKCP_PROBE_INIT) {
                    this.probe_wait = IKCP_PROBE_INIT;
                }
                this.probe_wait += this.probe_wait / 2;
                if (this.probe_wait > IKCP_PROBE_LIMIT) {
                    this.probe_wait = IKCP_PROBE_LIMIT;
                }
                this.ts_probe = (current + this.probe_wait) >>> 0;
                this.probe |= IKCP_ASK_SEND;
            }
        } else {
            this.ts_probe = 0;
            this.probe_wait = 0;
        }

        if (this.probe & IKCP_ASK_SEND) {
            seg.cmd = IKCP_CMD_WASK;
            flushBuffer(IKCP_OVERHEAD);
            ptr = seg.encode(buffer, ptr);
        }
        if (this.probe & IKCP_ASK_TELL) {
            seg.cmd = IKCP_CMD_WINS;
            flushBuffer(IKCP_OVERHEAD);
            ptr = seg.encode(buffer, ptr);
        }
        this.probe = 0;

        // 计算本轮可发窗口
        let cwnd = Math.min(this.snd_wnd, this.rmt_wnd);
        if (this.nocwnd === 0) {
            cwnd = Math.min(this.cwnd, cwnd);
        }

        // snd_queue → snd_buf
        while (_itimediff(this.snd_nxt, (this.snd_una + cwnd) >>> 0) < 0) {
            const newseg = this.snd_queue.shift();
            if (!newseg) {
                break;
            }
            newseg.conv = this.conv;
            newseg.cmd = IKCP_CMD_PUSH;
            newseg.wnd = seg.wnd;
            newseg.ts = current;
            newseg.sn = this.snd_nxt;
            this.snd_nxt = (this.snd_nxt + 1) >>> 0;
            newseg.una = this.rcv_nxt;
            newseg.resendts = current;
            newseg.rto = this.rx_rto;
            newseg.fastack = 0;
            newseg.xmit = 0;
            this.snd_buf.push(newseg);
        }

        const resent = this.fastresend > 0 ? this.fastresend : 0xffffffff;
        const rtomin = this.nodelayMode === 0 ? (this.rx_rto >> 3) : 0;
        let lost = false;
        let change = false;

        // 发送/重传 snd_buf 中的段
        for (const segment of this.snd_buf) {
            let needsend = false;
            if (segment.xmit === 0) {
                // 首发
                needsend = true;
                segment.xmit++;
                segment.rto = this.rx_rto;
                segment.resendts = (current + segment.rto + rtomin) >>> 0;
            } else if (_itimediff(current, segment.resendts) >= 0) {
                // 超时重传
                needsend = true;
                segment.xmit++;
                if (this.nodelayMode === 0) {
                    segment.rto += Math.max(segment.rto, this.rx_rto);
                } else {
                    const step = this.nodelayMode < 2 ? segment.rto : this.rx_rto;
                    segment.rto += step / 2;
                }
                segment.resendts = (current + segment.rto) >>> 0;
                lost = true;
            } else if (segment.fastack >= resent &&
                       (segment.xmit <= this.fastlimit || this.fastlimit <= 0)) {
                // 快速重传
                needsend = true;
                segment.xmit++;
                segment.fastack = 0;
                segment.resendts = (current + segment.rto) >>> 0;
                change = true;
            }

            if (needsend) {
                segment.ts = current;
                segment.wnd = seg.wnd;
                segment.una = this.rcv_nxt;
                flushBuffer(IKCP_OVERHEAD + segment.data.length);
                ptr = segment.encode(buffer, ptr);
                if (segment.xmit >= this.dead_link) {
                    this.state = -1;
                }
            }
        }

        if (ptr > 0) {
            this.output(Buffer.from(buffer.subarray(0, ptr)));
        }

        // 快速重传触发 → 调整 ssthresh（拥塞避免）
        if (change) {
            const inflight = _itimediff(this.snd_nxt, this.snd_una);
            this.ssthresh = Math.max(Math.floor(inflight / 2), IKCP_THRESH_MIN);
            this.cwnd = this.ssthresh + resent;
            this.incr = this.cwnd * this.mss;
        }
        // 丢包 → 慢启动
        if (lost) {
            this.ssthresh = Math.max(Math.floor(cwnd / 2), IKCP_THRESH_MIN);
            this.cwnd = 1;
            this.incr = this.mss;
        }
        if (this.cwnd < 1) {
            this.cwnd = 1;
            this.incr = this.mss;
        }
    }

    /**
     * 协议时钟驱动，定期调用（毫秒时间戳）
     */
    update(current: number): void {
        this.current = current >>> 0;
        if (!this.updated) {
            this.updated = true;
            this.ts_flush = this.current;
        }
        let slap = _itimediff(this.current, this.ts_flush);
        if (slap >= 10000 || slap < -10000) {
            this.ts_flush = this.current;
            slap = 0;
        }
        if (slap >= 0) {
            this.ts_flush = (this.ts_flush + this.interval) >>> 0;
            if (_itimediff(this.current, this.ts_flush) >= 0) {
                this.ts_flush = (this.current + this.interval) >>> 0;
            }
            this.flush();
        }
    }

    /** 待发送/在途的段数（背压判断用） */
    waitSnd(): number {
        return this.snd_buf.length + this.snd_queue.length;
    }

    /**
     * 工作模式调优。
     * nodelay: 0 普通 / 1 极速 / 2 极速且 RTO 不翻倍
     * interval: 内部时钟（ms）
     * resend: 快速重传阈值（0 关闭）
     * nc: 1 关闭拥塞控制
     */
    setNodelay(nodelay: number, interval: number, resend: number, nc: number): void {
        if (nodelay >= 0) {
            this.nodelayMode = nodelay;
            this.rx_minrto = nodelay > 0 ? IKCP_RTO_NDL : IKCP_RTO_MIN;
        }
        if (interval >= 0) {
            this.interval = _ibound(10, interval, 5000);
        }
        if (resend >= 0) {
            this.fastresend = resend;
        }
        if (nc >= 0) {
            this.nocwnd = nc;
        }
    }

    setWndSize(sndwnd: number, rcvwnd: number): void {
        if (sndwnd > 0) {
            this.snd_wnd = sndwnd;
        }
        if (rcvwnd > 0) {
            this.rcv_wnd = Math.max(rcvwnd, IKCP_WND_RCV);
        }
    }

    setMtu(mtu: number): number {
        if (mtu < 50 || mtu < IKCP_OVERHEAD) {
            return -1;
        }
        this.mtu = mtu;
        this.mss = this.mtu - IKCP_OVERHEAD;
        return 0;
    }
}
