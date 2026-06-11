import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
    /** 写盘防抖定时器：心跳等高频更新合并为一次写入 */
    private _saveTimer: NodeJS.Timeout | null = null;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._updatePeersFilePath();
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
        try {
            if (fs.existsSync(this._peersFilePath)) {
                const data = fs.readFileSync(this._peersFilePath, 'utf-8');
                const peersArray = JSON.parse(data) as StoredPeerInfo[];
                
                // 为每个 peer 确保有 id 字段
                const processedPeers = peersArray.map(p => {
                    // 如果没有 id 字段，根据 ip:port 生成
                    if (!p.id) {
                        p.id = `${p.ip}:${p.port}`;
                    }
                    return p;
                });
                
                this._peers = new Map(processedPeers.map(p => [p.id, p]));
                console.log(`Loaded ${peersArray.length} peers from ${this._peersFilePath}`);
                
                // 如果有 peer 缺少 id，保存更新后的数据
                if (peersArray.some(p => !p.id)) {
                    this._savePeers();
                }
            } else {
                // 创建默认的 peers.json 文件
                this._createDefaultPeersFile();
            }
        } catch (err) {
            console.error('Failed to load peers:', err);
            this._peers = new Map();
        }
    }

    private _createDefaultPeersFile(): void {
        try {
            const dir = path.dirname(this._peersFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            const defaultPeers: StoredPeerInfo[] = [];
            fs.writeFileSync(this._peersFilePath, JSON.stringify(defaultPeers, null, 2));
            console.log(`Created default peers.json at ${this._peersFilePath}`);
        } catch (err) {
            console.error('Failed to create default peers file:', err);
        }
    }

    private _savePeers(): void {
        try {
            const dir = path.dirname(this._peersFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const peersArray = Array.from(this._peers.values());
            fs.writeFileSync(this._peersFilePath, JSON.stringify(peersArray, null, 2));
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
