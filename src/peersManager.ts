import * as vscode from 'vscode';
import * as path from 'path';
import { PeerFileStore } from './core/peerFileStore';
import { PeerRecord, PeerRegistry, PersistedPeer, Presence } from './core/peerRegistry';
import { networkService } from './core/networkService';

/**
 * 联系人视图：供侧边栏与联系人编辑器使用。
 * 数据来自 PeerRegistry（对端唯一数据源），这里只是它的只读投影。
 */
export interface StoredPeerInfo {
    id: string;
    hostname: string;
    nickname?: string;
    ip: string;
    port: number;
    lastSeen: number;
    /** 在线三态：online / oneway（能收到对方的包但无往返确认）/ offline */
    status: Presence;
    /** 用户手工添加或编辑过 */
    manual: boolean;
    /** 对端系统与版本，如 "darwin · v0.1.0"（旧版对端为空） */
    platform?: string;
}

/**
 * 联系人管理：负责 peers.json 的持久化与 VS Code 配置，状态本身由 PeerRegistry 持有。
 * - 在线状态不落盘：每次启动都从"全部离线"开始，由发现与探测重新确认；
 * - 读不出可信内容时绝不写盘（路径不可用 / 文件损坏），见 PeerFileStore。
 */
export class PeersManager {
    private _peersFilePath: string = '';
    private _context: vscode.ExtensionContext;
    private _registry: PeerRegistry;
    private _store: PeerFileStore<PersistedPeer>;
    /** 是否已成功从文件读取过（路径不可用时为 false，期间不写盘，路径恢复后合并再写） */
    private _loaded: boolean = false;
    /** 文件损坏时的保护原因：非空表示拒绝写盘，直到用户修复后重新加载 */
    private _protectedReason: string | undefined;
    private _warned: Set<string> = new Set();
    /** 写盘防抖定时器：心跳等高频更新合并为一次写入 */
    private _saveTimer: NodeJS.Timeout | null = null;
    /** 上次落盘内容的指纹（不含 lastSeen）：没有实质变化就不写盘 */
    private _lastSavedFingerprint: string = '';
    private _suppressChange: boolean = false;

    constructor(context: vscode.ExtensionContext, registry: PeerRegistry = networkService.registry) {
        this._context = context;
        this._registry = registry;
        this._updatePeersFilePath();
        this._store = new PeerFileStore<PersistedPeer>(this._peersFilePath);
        this._loadPeers();
        this._registry.on('change', () => {
            if (!this._suppressChange) {
                this._scheduleSave();
            }
        });
    }

    private _updatePeersFilePath(): void {
        const config = vscode.workspace.getConfiguration('oschat');
        const customPath = config.get<string>('peersFilePath', '');

        if (customPath) {
            this._peersFilePath = path.join(customPath, 'peers.json');
        } else {
            // 默认使用扩展存储目录
            this._peersFilePath = path.join(this._context.globalStorageUri.fsPath, 'peers.json');
        }
    }

    private _loadPeers(): void {
        this._store.setPath(this._peersFilePath);
        this._protectedReason = undefined;

        const result = this._store.load();
        if (result.ok) {
            this._withoutSaving(() => this._registry.load(result.items));
            this._loaded = true;
            this._lastSavedFingerprint = this._fingerprint();
            console.log(`Loaded ${result.items.length} peers from ${this._peersFilePath}`);
            return;
        }

        this._withoutSaving(() => this._registry.load([]));
        this._loaded = false;
        if (result.reason === 'corrupt') {
            this._protectedReason = result.message;
        }
        console.error('Failed to load peers:', result.message);
        this._warnOnce(result.message);
    }

    private _withoutSaving(action: () => void): void {
        this._suppressChange = true;
        try {
            action();
        } finally {
            this._suppressChange = false;
        }
    }

    private _warnOnce(message: string): void {
        if (this._warned.has(message)) {
            return;
        }
        this._warned.add(message);
        void vscode.window.showWarningMessage(`OS Chat：${message}`);
    }

    /**
     * 路径不可用期间积累的内存状态，在路径恢复后与文件内容合并，
     * 避免用"只含新发现对端"的列表覆盖原文件里的手工配置。
     */
    private _lateLoad(): boolean {
        const result = this._store.load();
        if (!result.ok) {
            if (result.reason === 'corrupt') {
                this._protectedReason = result.message;
                this._warnOnce(result.message);
            }
            return false;
        }
        this._withoutSaving(() => this._registry.mergePersisted(result.items));
        this._loaded = true;
        return true;
    }

    private _fingerprint(): string {
        return JSON.stringify(this._registry.toPersisted().map(p => ({ ...p, lastSeen: 0 })));
    }

    private _savePeers(): void {
        if (this._protectedReason) {
            return;
        }
        if (!this._loaded && !this._lateLoad()) {
            return;
        }
        try {
            this._store.save(this._registry.toPersisted());
            this._lastSavedFingerprint = this._fingerprint();
        } catch (err) {
            console.error('Failed to save peers:', err);
        }
    }

    /**
     * 防抖写盘：2 秒内的多次变化合并为一次；没有实质变化（只有在线状态、lastSeen 在变）时不写盘
     */
    private _scheduleSave(): void {
        if (this._saveTimer || this._fingerprint() === this._lastSavedFingerprint) {
            return;
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._savePeers();
        }, 2000);
    }

    /**
     * 立即落盘（插件停用时调用）；lastSeen 只在这里与实质变化时写入
     */
    public flush(): void {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this._savePeers();
    }

    private _toView(rec: PeerRecord): StoredPeerInfo {
        const meta = rec.meta;
        const platform = meta?.os
            ? [meta.os, meta.version ? `v${meta.version}` : ''].filter(Boolean).join(' · ')
            : undefined;
        return {
            id: rec.id,
            hostname: rec.hostname,
            nickname: rec.nickname,
            ip: rec.ip,
            port: rec.port,
            lastSeen: rec.lastSeen,
            status: rec.presence,
            manual: rec.manual,
            platform
        };
    }

    /**
     * 手动添加 peer（通过 IP 和端口）
     */
    public addPeer(ip: string, port: number, nickname?: string, hostname?: string): StoredPeerInfo {
        const rec = this._registry.addManual(ip, port, nickname, hostname);
        this._savePeers();
        return this._toView(rec);
    }

    /**
     * 编辑 peer：改地址会换 id，旧 id 保留为别名，已有会话仍能对应到该联系人
     */
    public editPeer(id: string, patch: { hostname?: string; nickname?: string; ip?: string; port?: number }): StoredPeerInfo | undefined {
        const rec = this._registry.edit(id, patch);
        if (!rec) {
            return undefined;
        }
        this._savePeers();
        return this._toView(rec);
    }

    /**
     * 删除 peer：同时从运行时注册表移除，不会在下个心跳时"复活"
     * （对方若仍在线并持续发现，会作为新发现的联系人重新出现）
     */
    public removePeer(id: string): void {
        this._registry.remove(id);
        this._savePeers();
    }

    /**
     * 获取所有 peers
     */
    public getPeers(): StoredPeerInfo[] {
        return this._registry.list().map(rec => this._toView(rec));
    }

    /**
     * 获取在线 peers
     */
    public getOnlinePeers(): StoredPeerInfo[] {
        return this.getPeers().filter(p => p.status === 'online');
    }

    /**
     * 根据 ID（或历史别名）获取 peer
     */
    public getPeerById(id: string): StoredPeerInfo | undefined {
        const rec = this._registry.resolve(id);
        return rec ? this._toView(rec) : undefined;
    }

    /**
     * 规范 ID：别名（旧版 ip:端口、换 IP 前的地址）映射到当前 id；未知 id 原样返回
     */
    public canonicalId(id: string): string {
        return this._registry.resolve(id)?.id ?? id;
    }

    /**
     * 获取 peer 显示名称
     */
    public getPeerDisplayName(peer: StoredPeerInfo): string {
        return peer.nickname || peer.hostname.replace(/\.local$/i, '') || peer.ip;
    }

    /**
     * 格式化 peer 列表
     */
    public formatPeerList(): string {
        const peers = this.getPeers();
        if (peers.length === 0) {
            return '暂无已知的通信对象\n请在 peers.json 文件中配置通信对象的 IP 和端口';
        }

        const icons: Record<Presence, string> = { online: '🟢', oneway: '🟡', offline: '⚪' };
        return peers.map(peer => {
            const name = this.getPeerDisplayName(peer);
            return `${icons[peer.status]} ${name} - ${peer.ip}:${peer.port}`;
        }).join('\n');
    }

    /**
     * 刷新文件路径
     */
    public refreshFilePath(): void {
        this._updatePeersFilePath();
        this._loadPeers();
    }

    /**
     * 重新加载 peers
     */
    public reloadPeers(): void {
        this._loadPeers();
    }

    /**
     * 获取 peers 文件路径
     */
    public getPeersFilePath(): string {
        return this._peersFilePath;
    }
}
