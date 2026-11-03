import * as vscode from 'vscode';
import * as path from 'path';
import { PeerFileStore, mergePeers } from './peerFileStore';

export interface StoredPeerInfo {
    id: string;
    hostname: string;
    nickname?: string;
    ip: string;
    port: number;
    lastSeen: number;
    status: 'online' | 'offline';
}

export class PeersManager {
    private _peersFilePath: string = '';
    private _peers: Map<string, StoredPeerInfo> = new Map();
    private _context: vscode.ExtensionContext;
    private _store: PeerFileStore<StoredPeerInfo>;
    /** 是否已成功从文件读取过（路径不可用时为 false，期间不写盘，路径恢复后合并再写） */
    private _loaded: boolean = false;
    /** 文件损坏时的保护原因：非空表示拒绝写盘，直到用户修复后重新加载 */
    private _protectedReason: string | undefined;
    private _warned: Set<string> = new Set();
    /** 写盘防抖定时器：心跳等高频更新合并为一次写入 */
    private _saveTimer: NodeJS.Timeout | null = null;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._updatePeersFilePath();
        this._store = new PeerFileStore<StoredPeerInfo>(this._peersFilePath);
        this._loadPeers();
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
            this._peers = this._normalize(result.items);
            this._loaded = true;
            console.log(`Loaded ${result.items.length} peers from ${this._peersFilePath}`);
            return;
        }

        this._peers = new Map();
        this._loaded = false;
        if (result.reason === 'corrupt') {
            this._protectedReason = result.message;
        }
        console.error('Failed to load peers:', result.message);
        this._warnOnce(result.message);
    }

    /** 补全缺失的 id（旧文件没有 id 字段时按 ip:port 生成） */
    private _normalize(items: StoredPeerInfo[]): Map<string, StoredPeerInfo> {
        return new Map(items.map(p => {
            if (!p.id) {
                p.id = `${p.ip}:${p.port}`;
            }
            return [p.id, p];
        }));
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
        this._peers = mergePeers(Array.from(this._normalize(result.items).values()), this._peers);
        this._loaded = true;
        return true;
    }

    private _savePeers(): void {
        if (this._protectedReason) {
            return;
        }
        if (!this._loaded && !this._lateLoad()) {
            return;
        }
        try {
            this._store.save(Array.from(this._peers.values()));
        } catch (err) {
            console.error('Failed to save peers:', err);
        }
    }

    /**
     * 添加或更新 peer。
     * lastSeen 只在内存中更新；仅当有意义的字段（状态/地址/名称）变化时才写盘。
     */
    public updatePeer(peerInfo: StoredPeerInfo): void {
        const existingPeer = this._peers.get(peerInfo.id);

        if (existingPeer) {
            existingPeer.lastSeen = peerInfo.lastSeen;

            let changed = false;
            if (existingPeer.status !== peerInfo.status) {
                existingPeer.status = peerInfo.status;
                changed = true;
            }
            if (existingPeer.ip !== peerInfo.ip || existingPeer.port !== peerInfo.port) {
                existingPeer.ip = peerInfo.ip;
                existingPeer.port = peerInfo.port;
                changed = true;
            }
            if (peerInfo.nickname && existingPeer.nickname !== peerInfo.nickname) {
                existingPeer.nickname = peerInfo.nickname;
                changed = true;
            }
            if (peerInfo.hostname && existingPeer.hostname !== peerInfo.hostname) {
                existingPeer.hostname = peerInfo.hostname;
                changed = true;
            }

            if (changed) {
                this._scheduleSave();
            }
        } else {
            this._peers.set(peerInfo.id, { ...peerInfo });
            this._scheduleSave();
        }
    }

    /**
     * 防抖写盘：2 秒内的多次更新合并为一次
     */
    private _scheduleSave(): void {
        if (this._saveTimer) {
            return;
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._savePeers();
        }, 2000);
    }

    /**
     * 立即落盘待保存的更改（插件停用时调用）
     */
    public flush(): void {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
            this._savePeers();
        }
    }

    /**
     * 手动添加 peer（通过 IP 和端口）
     */
    public addPeer(ip: string, port: number, nickname?: string, hostname?: string): StoredPeerInfo {
        const peerId = `${ip}:${port}`;
        
        const peerInfo: StoredPeerInfo = {
            id: peerId,
            hostname: hostname || ip,
            nickname: nickname,
            ip: ip,
            port: port,
            lastSeen: Date.now(),
            status: 'offline'
        };

        this._peers.set(peerId, peerInfo);
        this._savePeers();
        
        return peerInfo;
    }

    /**
     * 删除 peer
     */
    public removePeer(id: string): void {
        this._peers.delete(id);
        this._savePeers();
    }

    /**
     * 获取所有 peers
     */
    public getPeers(): StoredPeerInfo[] {
        return Array.from(this._peers.values());
    }

    /**
     * 获取在线 peers
     */
    public getOnlinePeers(): StoredPeerInfo[] {
        return this.getPeers().filter(p => p.status === 'online');
    }

    /**
     * 根据 ID 获取 peer
     */
    public getPeerById(id: string): StoredPeerInfo | undefined {
        return this._peers.get(id);
    }

    /**
     * 更新 peer 状态
     */
    public updatePeerStatus(id: string, status: 'online' | 'offline'): void {
        const peer = this._peers.get(id);
        if (peer) {
            peer.status = status;
            peer.lastSeen = Date.now();
            this._savePeers();
        }
    }

    /**
     * 获取 peer 显示名称
     */
    public getPeerDisplayName(peer: StoredPeerInfo): string {
        return peer.nickname || peer.hostname || peer.ip;
    }

    /**
     * 格式化 peer 列表
     */
    public formatPeerList(): string {
        const peers = this.getPeers();
        if (peers.length === 0) {
            return '暂无已知的通信对象\n请在 peers.json 文件中配置通信对象的 IP 和端口';
        }

        return peers.map(peer => {
            const status = peer.status === 'online' ? '🟢' : '⚪';
            const name = this.getPeerDisplayName(peer);
            return `${status} ${name} - ${peer.ip}:${peer.port}`;
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
