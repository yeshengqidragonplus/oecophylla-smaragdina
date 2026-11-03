import * as events from 'events';

/**
 * 对端注册表：对端信息的**唯一数据源**（不依赖 vscode）。
 *
 * 取代之前三处各存一份的状态（networkService._peers、PeersManager._peers、webview 的 allPeers），
 * 解决"显示不一致""删除后复活""同一台机器因 DHCP 换 IP 出现多个联系人"等问题。
 *
 * 身份：
 * - 新版对端带稳定的实例 ID（iid），记录以 iid 为 id，IP 只是"最近一次观察到的地址"，换 IP 只更新地址；
 * - 旧版对端或手工添加的条目没有 iid，id 为 `ip:端口`；首次收到带 iid 的应答后自动认领并升级；
 * - 历史 id 保留在 aliases 里，便于把旧会话映射到同一个联系人。
 *
 * 在线状态（presence）三态，由"往返确认"决定，而不是"收到过任意包"：
 * - online：近期收到过往返确认（对端回应了我们的探测，或 KCP 握手成功）；
 * - oneway：近期收到过对端发来的包，但一直没有往返确认——对方能找到我们，我们到对方可能被防火墙拦；
 * - offline：近期什么都没收到。
 */

export interface PeerMeta {
    os?: string;
    arch?: string;
    node?: string;
    version?: string;
    build?: string;
    vscode?: string;
}

export type Presence = 'online' | 'oneway' | 'offline';

/** 超过该时长没有往返确认 / 没有收到任何包，状态降级 */
export const ONLINE_TIMEOUT = 90_000;
/** 刚收到对端入站包、尚无往返确认时，先按在线显示的宽限期（给我们的探测留出往返时间，避免健康链路上黄灯闪烁） */
export const PENDING_GRACE = 20_000;
/** 自动发现的对端（非手工添加）长期未见则清理 */
export const AUTO_PEER_TTL = 30 * 24 * 3600 * 1000;

export interface PeerRecord {
    /** 稳定 ID：实例 ID，或手工/旧版条目的 `ip:端口` */
    id: string;
    iid?: string;
    ip: string;
    /** 对端主 UDP 端口（发现与心跳） */
    port: number;
    /** 对端业务（KCP）端口 */
    transferPort: number;
    hostname: string;
    nickname?: string;
    /** 历史 ID（旧版 ip:端口、换 IP 前的地址等） */
    aliases: string[];
    /** 用户手工添加或编辑过：永不自动清理 */
    manual: boolean;
    firstSeen: number;
    /** 最近一次有联系的时间（持久化，用于清理与展示） */
    lastSeen: number;
    /** 运行期：最近一次收到对端任意包 */
    lastHeard: number;
    /** 运行期：最近一次往返确认 */
    lastAck: number;
    /** 运行期：首次收到入站包但尚无往返确认的时刻，0 表示无 */
    pendingSince: number;
    presence: Presence;
    /** 对端本次启动标识：变化说明对端重启过 */
    boot?: string;
    proto?: number;
    meta?: PeerMeta;
}

export interface PersistedPeer {
    id?: string;
    iid?: string;
    ip: string;
    port: number;
    transferPort?: number;
    hostname?: string;
    nickname?: string;
    aliases?: string[];
    manual?: boolean;
    lastSeen?: number;
}

export interface Observation {
    /**
     * inbound：对方主动发来的包（发现请求、心跳）；
     * ack：往返确认（发现应答、心跳应答）；
     * kcp：KCP 握手成功（任一方向）。
     */
    kind: 'inbound' | 'ack' | 'kcp';
    ip: string;
    port: number;
    transferPort?: number;
    iid?: string;
    boot?: string;
    proto?: number;
    meta?: PeerMeta;
    hostname?: string;
    nickname?: string;
    now?: number;
}

export function computePresence(
    rec: Pick<PeerRecord, 'lastHeard' | 'lastAck' | 'pendingSince'>,
    now: number
): Presence {
    if (rec.lastAck > 0 && now - rec.lastAck <= ONLINE_TIMEOUT) {
        return 'online';
    }
    if (rec.lastHeard > 0 && now - rec.lastHeard <= ONLINE_TIMEOUT) {
        if (rec.pendingSince > 0 && now - rec.pendingSince < PENDING_GRACE) {
            return 'online';
        }
        return 'oneway';
    }
    return 'offline';
}

function copy(rec: PeerRecord): PeerRecord {
    return { ...rec, aliases: [...rec.aliases], meta: rec.meta ? { ...rec.meta } : undefined };
}

/**
 * 事件：
 * - 'change'：对端集合、地址、名称或在线状态发生变化（lastSeen 等不触发）；
 * - 'restarted' (record)：对端的 boot 标识变了，说明它重启过，旧的传输会话应作废。
 */
export class PeerRegistry extends events.EventEmitter {
    private _byId: Map<string, PeerRecord> = new Map();

    list(): PeerRecord[] {
        return Array.from(this._byId.values()).map(copy);
    }

    /** 按 id 或历史别名查找 */
    resolve(idOrAlias: string): PeerRecord | undefined {
        const rec = this._find(idOrAlias);
        return rec ? copy(rec) : undefined;
    }

    findByAddress(ip: string, port: number): PeerRecord | undefined {
        for (const rec of this._byId.values()) {
            if (rec.ip === ip && rec.port === port) {
                return copy(rec);
            }
        }
        return undefined;
    }

    get size(): number {
        return this._byId.size;
    }

    // ==================== 持久化 ====================

    /** 用持久化内容替换全部记录（兼容没有 manual/iid 字段的旧文件：旧条目一律视为手工，永不自动清理） */
    load(items: PersistedPeer[]): void {
        this._byId.clear();
        for (const item of items) {
            const rec = this._fromPersisted(item);
            if (rec && !this._byId.has(rec.id)) {
                this._byId.set(rec.id, rec);
            }
        }
        this.emit('change');
    }

    /**
     * 合并持久化内容：只补充注册表里还没有的条目，已有条目（含运行期状态）保持不变。
     * 用于 peers.json 所在路径恢复可用（如外接卷重新挂载）后，把文件里的手工配置并回来。
     */
    mergePersisted(items: PersistedPeer[]): void {
        let changed = false;
        for (const item of items) {
            const rec = this._fromPersisted(item);
            if (!rec || this._find(rec.id) || this.findByAddress(rec.ip, rec.port)) {
                continue;
            }
            this._byId.set(rec.id, rec);
            changed = true;
        }
        if (changed) {
            this.emit('change');
        }
    }

    private _fromPersisted(item: PersistedPeer): PeerRecord | null {
        if (!item || typeof item.ip !== 'string' || typeof item.port !== 'number') {
            return null;
        }
        const id = item.iid ?? item.id ?? `${item.ip}:${item.port}`;
        const aliases = new Set(item.aliases ?? []);
        if (item.id && item.id !== id) {
            aliases.add(item.id);
        }
        aliases.delete(id);
        return {
            id,
            iid: item.iid,
            ip: item.ip,
            port: item.port,
            transferPort: item.transferPort ?? item.port + 1000,
            hostname: item.hostname ?? item.ip,
            nickname: item.nickname,
            aliases: Array.from(aliases),
            manual: item.manual ?? true,
            firstSeen: item.lastSeen ?? 0,
            lastSeen: item.lastSeen ?? 0,
            lastHeard: 0,
            lastAck: 0,
            pendingSince: 0,
            presence: 'offline'
        };
    }

    toPersisted(): PersistedPeer[] {
        return Array.from(this._byId.values()).map(rec => ({
            id: rec.id,
            iid: rec.iid,
            ip: rec.ip,
            port: rec.port,
            transferPort: rec.transferPort,
            hostname: rec.hostname,
            nickname: rec.nickname,
            aliases: rec.aliases.length > 0 ? [...rec.aliases] : undefined,
            manual: rec.manual,
            lastSeen: rec.lastSeen
        }));
    }

    // ==================== 观察到对端 ====================

    observe(obs: Observation): PeerRecord {
        const now = obs.now ?? Date.now();
        const legacyId = `${obs.ip}:${obs.port}`;
        let changed = false;
        let restarted = false;
        let rec: PeerRecord | undefined;

        if (obs.iid) {
            rec = this._byId.get(obs.iid);
            if (!rec) {
                // 认领没有 iid 的手工/旧版条目：按地址或历史别名匹配，升级为以 iid 为身份
                const claimed = this._findLegacy(legacyId);
                if (claimed) {
                    this._rekey(claimed, obs.iid);
                    claimed.iid = obs.iid;
                    rec = claimed;
                    changed = true;
                }
            }
            if (!rec && obs.hostname) {
                // DHCP 换 IP 后留下的同主机名离线旧版条目：合并为同一个联系人
                rec = this._mergeHostnameDuplicates(obs.iid, obs.hostname, obs.ip, now);
                changed = changed || !!rec;
            }
            if (!rec) {
                rec = this._create(obs.iid, obs, now);
                changed = true;
            }
            changed = this._dropStaleSameAddress(rec, now) || changed;
        } else {
            rec = this._find(legacyId);
            if (!rec) {
                rec = this._create(legacyId, obs, now);
                changed = true;
            }
        }

        // ---- 更新字段 ----
        if (rec.ip !== obs.ip || rec.port !== obs.port) {
            if (rec.iid) {
                this._addAlias(rec, `${rec.ip}:${rec.port}`);
            }
            rec.ip = obs.ip;
            rec.port = obs.port;
            if (!obs.transferPort) {
                rec.transferPort = obs.port + 1000;
            }
            changed = true;
        }
        if (obs.transferPort && rec.transferPort !== obs.transferPort) {
            rec.transferPort = obs.transferPort;
            changed = true;
        }
        if (obs.hostname && rec.hostname !== obs.hostname) {
            rec.hostname = obs.hostname;
            changed = true;
        }
        if (obs.nickname && rec.nickname !== obs.nickname) {
            rec.nickname = obs.nickname;
            changed = true;
        }
        if (obs.meta) {
            rec.meta = { ...obs.meta };
        }
        if (obs.proto !== undefined) {
            rec.proto = obs.proto;
        }
        if (obs.boot) {
            if (rec.boot && rec.boot !== obs.boot) {
                restarted = true;
            }
            rec.boot = obs.boot;
        }

        // ---- 联系时间与在线状态 ----
        rec.lastSeen = now;
        rec.lastHeard = now;
        if (obs.kind === 'ack' || obs.kind === 'kcp') {
            rec.lastAck = now;
            rec.pendingSince = 0;
        } else if (rec.pendingSince === 0 && now - rec.lastAck > ONLINE_TIMEOUT) {
            rec.pendingSince = now;
        }
        const presence = computePresence(rec, now);
        if (presence !== rec.presence) {
            rec.presence = presence;
            changed = true;
        }

        if (changed) {
            this.emit('change');
        }
        if (restarted) {
            this.emit('restarted', copy(rec));
        }
        return copy(rec);
    }

    /** 传输层确认连通（KCP 握手成功等）：视为往返确认 */
    markAck(id: string, now: number = Date.now()): void {
        const rec = this._find(id);
        if (!rec) {
            return;
        }
        rec.lastSeen = now;
        rec.lastHeard = now;
        rec.lastAck = now;
        rec.pendingSince = 0;
        const presence = computePresence(rec, now);
        if (presence !== rec.presence) {
            rec.presence = presence;
            this.emit('change');
        }
    }

    // ==================== 手工管理 ====================

    /** 按地址确保存在一条记录（发送时遇到未知 id 的临时补建），不标记为手工 */
    ensureByAddress(ip: string, port: number, now: number = Date.now()): PeerRecord {
        const existing = this._find(`${ip}:${port}`);
        if (existing) {
            return copy(existing);
        }
        const byAddress = this.findByAddress(ip, port);
        if (byAddress) {
            return byAddress;
        }
        const rec = this._create(`${ip}:${port}`, { ip, port }, now);
        rec.lastSeen = 0;
        this.emit('change');
        return copy(rec);
    }

    addManual(ip: string, port: number, nickname?: string, hostname?: string): PeerRecord {
        let rec = this._find(`${ip}:${port}`);
        if (!rec) {
            const byAddress = this.findByAddress(ip, port);
            rec = byAddress ? this._find(byAddress.id) : undefined;
        }
        if (!rec) {
            rec = this._create(`${ip}:${port}`, { ip, port, hostname, nickname }, Date.now());
        }
        rec.manual = true;
        if (nickname) {
            rec.nickname = nickname;
        }
        if (hostname) {
            rec.hostname = hostname;
        }
        this.emit('change');
        return copy(rec);
    }

    /** 编辑联系人（联系人编辑器）：任何编辑都视为手工，永不自动清理 */
    edit(id: string, patch: { hostname?: string; nickname?: string; ip?: string; port?: number }): PeerRecord | undefined {
        const rec = this._find(id);
        if (!rec) {
            return undefined;
        }
        if (patch.hostname !== undefined) {
            rec.hostname = patch.hostname;
        }
        if (patch.nickname !== undefined) {
            rec.nickname = patch.nickname || undefined;
        }
        const ip = patch.ip ?? rec.ip;
        const port = patch.port ?? rec.port;
        if (ip !== rec.ip || port !== rec.port) {
            if (!rec.iid) {
                // 手工条目的 id 就是地址：改地址即换 id，旧 id 留作别名
                const newId = `${ip}:${port}`;
                if (!this._byId.has(newId)) {
                    this._rekey(rec, newId);
                }
            } else {
                this._addAlias(rec, `${rec.ip}:${rec.port}`);
            }
            rec.ip = ip;
            rec.port = port;
            rec.transferPort = port + 1000;
            rec.lastHeard = 0;
            rec.lastAck = 0;
            rec.pendingSince = 0;
            rec.presence = 'offline';
        }
        rec.manual = true;
        this.emit('change');
        return copy(rec);
    }

    remove(id: string): boolean {
        const rec = this._find(id);
        if (!rec) {
            return false;
        }
        this._byId.delete(rec.id);
        this.emit('change');
        return true;
    }

    // ==================== 定时维护 ====================

    /** 重新计算在线状态，并清理长期未见的自动发现条目 */
    sweep(now: number = Date.now()): boolean {
        let changed = false;
        for (const rec of Array.from(this._byId.values())) {
            const presence = computePresence(rec, now);
            if (presence !== rec.presence) {
                rec.presence = presence;
                changed = true;
            }
            if (!rec.manual && presence === 'offline' && rec.lastSeen > 0 && now - rec.lastSeen > AUTO_PEER_TTL) {
                this._byId.delete(rec.id);
                changed = true;
            }
        }
        if (changed) {
            this.emit('change');
        }
        return changed;
    }

    /** 网络服务停止时：全部视为离线（保留 lastSeen） */
    markAllOffline(): void {
        let changed = false;
        for (const rec of this._byId.values()) {
            rec.lastHeard = 0;
            rec.lastAck = 0;
            rec.pendingSince = 0;
            if (rec.presence !== 'offline') {
                rec.presence = 'offline';
                changed = true;
            }
        }
        if (changed) {
            this.emit('change');
        }
    }

    // ==================== 内部 ====================

    private _find(idOrAlias: string): PeerRecord | undefined {
        const direct = this._byId.get(idOrAlias);
        if (direct) {
            return direct;
        }
        for (const rec of this._byId.values()) {
            if (rec.aliases.includes(idOrAlias)) {
                return rec;
            }
        }
        return undefined;
    }

    /** 没有 iid 的条目：按 id 或别名（旧版 ip:端口）匹配 */
    private _findLegacy(legacyId: string): PeerRecord | undefined {
        const rec = this._find(legacyId);
        return rec && !rec.iid ? rec : undefined;
    }

    private _create(id: string, obs: Pick<Observation, 'ip' | 'port' | 'transferPort' | 'iid' | 'hostname' | 'nickname'>, now: number): PeerRecord {
        const rec: PeerRecord = {
            id,
            iid: obs.iid,
            ip: obs.ip,
            port: obs.port,
            transferPort: obs.transferPort ?? obs.port + 1000,
            hostname: obs.hostname ?? obs.ip,
            nickname: obs.nickname,
            aliases: [],
            manual: false,
            firstSeen: now,
            lastSeen: now,
            lastHeard: 0,
            lastAck: 0,
            pendingSince: 0,
            presence: 'offline'
        };
        this._byId.set(id, rec);
        return rec;
    }

    private _rekey(rec: PeerRecord, newId: string): void {
        const oldId = rec.id;
        this._byId.delete(oldId);
        rec.id = newId;
        this._addAlias(rec, oldId);
        rec.aliases = rec.aliases.filter(a => a !== newId);
        this._byId.set(newId, rec);
    }

    private _addAlias(rec: PeerRecord, alias: string): void {
        if (alias !== rec.id && !rec.aliases.includes(alias)) {
            rec.aliases.push(alias);
        }
    }

    /**
     * 合并同主机名、离线、没有 iid、地址不同的旧版条目——典型场景是 DHCP 换 IP 后旧地址留下的幽灵条目。
     * 只在对端主机名非空且不是 IP 字符串时才合并，避免把不同机器误并。
     */
    private _mergeHostnameDuplicates(iid: string, hostname: string, ip: string, now: number): PeerRecord | undefined {
        const lower = hostname.toLowerCase();
        const dupes = Array.from(this._byId.values()).filter(r =>
            !r.iid
            && r.ip !== ip
            && r.hostname.toLowerCase() === lower
            && r.hostname !== r.ip
            && computePresence(r, now) === 'offline');
        if (dupes.length === 0) {
            return undefined;
        }
        dupes.sort((a, b) => b.lastSeen - a.lastSeen);
        const base = dupes[0];
        const manual = dupes.some(d => d.manual);
        for (const other of dupes.slice(1)) {
            this._byId.delete(other.id);
            this._addAlias(base, other.id);
            other.aliases.forEach(a => this._addAlias(base, a));
        }
        this._rekey(base, iid);
        base.iid = iid;
        base.manual = manual;
        return base;
    }

    /** 同一地址上出现了新的实例（对端重装、换了 iid）：清理占着该地址的旧自动条目 */
    private _dropStaleSameAddress(rec: PeerRecord, now: number): boolean {
        let changed = false;
        for (const other of Array.from(this._byId.values())) {
            if (other.id !== rec.id && other.iid && !other.manual
                && other.ip === rec.ip && other.port === rec.port
                && computePresence(other, now) === 'offline') {
                this._byId.delete(other.id);
                this._addAlias(rec, other.id);
                other.aliases.forEach(a => this._addAlias(rec, a));
                changed = true;
            }
        }
        return changed;
    }
}
