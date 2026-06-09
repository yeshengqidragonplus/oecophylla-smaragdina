import * as vscode from 'vscode';
import { PeersManager, StoredPeerInfo } from './peersManager';

export class PeersEditor {
    public static currentPanel: PeersEditor | undefined;
    public static readonly viewType = 'OSChatPeersEditor';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _peersManager: PeersManager;

    public static createOrShow(extensionUri: vscode.Uri, peersManager: PeersManager): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 如果面板已存在，则显示它
        if (PeersEditor.currentPanel) {
            PeersEditor.currentPanel._panel.reveal(column);
            PeersEditor.currentPanel._update();
            return;
        }

        // 创建新面板
        const panel = vscode.window.createWebviewPanel(
            PeersEditor.viewType,
            '编辑聊天对象',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        PeersEditor.currentPanel = new PeersEditor(panel, extensionUri, peersManager);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, peersManager: PeersManager) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._peersManager = peersManager;

        // 设置 HTML 内容
        this._update();

        // 监听面板关闭
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 监听配置变化
        this._panel.onDidChangeViewState(
            e => {
                if (this._panel.visible) {
                    this._update();
                }
            },
            null,
            this._disposables
        );

        // 处理来自 Webview 的消息
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.type) {
                    case 'addPeer':
                        await this._addPeer(message.peer);
                        break;
                    case 'updatePeer':
                        await this._updatePeer(message.peer);
                        break;
                    case 'deletePeer':
                        await this._deletePeer(message.id);
                        break;
                    case 'refresh':
                        this._update();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private async _addPeer(peer: { hostname: string; nickname?: string; ip: string; port: number }): Promise<void> {
        const id = `${peer.ip}:${peer.port}`;
        
        const peerInfo: StoredPeerInfo = {
            id,
            hostname: peer.hostname,
            nickname: peer.nickname,
            ip: peer.ip,
            port: peer.port,
            lastSeen: Date.now(),
            status: 'offline'
        };

        this._peersManager.updatePeer(peerInfo);
        vscode.window.showInformationMessage(`已添加聊天对象：${peer.hostname}`);
        this._update();
    }

    private async _updatePeer(peer: { id: string; hostname: string; nickname?: string; ip: string; port: number }): Promise<void> {
        const existingPeer = this._peersManager.getPeerById(peer.id);
        
        if (!existingPeer) {
            vscode.window.showErrorMessage('未找到该聊天对象');
            return;
        }

        const newId = `${peer.ip}:${peer.port}`;
        
        // 如果 ID 改变了，先删除旧的
        if (peer.id !== newId) {
            this._peersManager.removePeer(peer.id);
        }

        const peerInfo: StoredPeerInfo = {
            id: newId,
            hostname: peer.hostname,
            nickname: peer.nickname,
            ip: peer.ip,
            port: peer.port,
            lastSeen: existingPeer.lastSeen,
            status: existingPeer.status
        };

        this._peersManager.updatePeer(peerInfo);
        vscode.window.showInformationMessage(`已更新聊天对象：${peer.hostname}`);
        this._update();
    }

    private async _deletePeer(id: string): Promise<void> {
        this._peersManager.removePeer(id);
        vscode.window.showInformationMessage('已删除聊天对象');
        this._update();
    }

    public dispose(): void {
        PeersEditor.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _update(): void {
        const peers = this._peersManager.getPeers();
        this._panel.webview.html = this._getHtmlForWebview(peers);
    }

    private _renderTable(peers: StoredPeerInfo[]): string {
        if (peers.length === 0) {
            return `
                <div class="empty-state">
                    <p>暂无聊天对象</p>
                    <p>点击"添加聊天对象"按钮添加新的通信目标</p>
                </div>
            `;
        }
        
        return `
            <table class="peers-table">
                <thead>
                    <tr>
                        <th>状态</th>
                        <th>主机名</th>
                        <th>昵称</th>
                        <th>IP 地址</th>
                        <th>端口</th>
                        <th>最后在线</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${peers.map(peer => `
                        <tr>
                            <td>
                                <span class="status-indicator ${peer.status === 'online' ? 'status-online' : 'status-offline'}"></span>
                                ${peer.status === 'online' ? '在线' : '离线'}
                            </td>
                            <td>${this._escapeHtml(peer.hostname)}</td>
                            <td>${peer.nickname ? this._escapeHtml(peer.nickname) : '-'}</td>
                            <td>${peer.ip}</td>
                            <td>${peer.port}</td>
                            <td>${this._formatTime(peer.lastSeen)}</td>
                            <td class="actions-cell">
                                <button class="btn btn-secondary btn-small" onclick="editPeer('${peer.id}')">编辑</button>
                                <button class="btn btn-danger btn-small" onclick="deletePeer('${peer.id}')">删除</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/"/g, '"')
            .replace(/'/g, '&#039;');
    }

    private _formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        const now = Date.now();
        const diff = now - timestamp;
        
        if (diff < 60000) {
            return '刚刚';
        } else if (diff < 3600000) {
            return Math.floor(diff / 60000) + '分钟前';
        } else if (diff < 86400000) {
            return Math.floor(diff / 3600000) + '小时前';
        } else {
            return date.toLocaleDateString('zh-CN');
        }
    }

    private _getHtmlForWebview(peers: StoredPeerInfo[]): string {
        const nonce = this._getNonce();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>编辑聊天对象</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }
        
        h1 {
            font-size: 20px;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        
        .toolbar {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .btn-danger {
            background-color: var(--vscode-errorForeground);
            color: white;
        }
        
        .btn-danger:hover {
            opacity: 0.8;
        }
        
        .btn-small {
            padding: 4px 8px;
            font-size: 12px;
        }
        
        .peers-table {
            width: 100%;
            border-collapse: collapse;
        }
        
        .peers-table th,
        .peers-table td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        
        .peers-table th {
            font-weight: 600;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        
        .peers-table tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .status-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 6px;
        }
        
        .status-online {
            background-color: #4caf50;
        }
        
        .status-offline {
            background-color: #9e9e9e;
        }
        
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        
        .modal-overlay.visible {
            display: flex;
        }
        
        .modal {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 20px;
            min-width: 400px;
            max-width: 500px;
        }
        
        .modal h2 {
            font-size: 16px;
            margin-bottom: 16px;
        }
        
        .form-group {
            margin-bottom: 16px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
        }
        
        .form-group input {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: inherit;
        }
        
        .form-group input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        .form-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            margin-top: 20px;
        }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .actions-cell {
            display: flex;
            gap: 6px;
        }
    </style>
</head>
<body>
    <h1>📝 编辑聊天对象</h1>
    
    <div class="toolbar">
        <button class="btn btn-primary" id="addBtn">➕ 添加聊天对象</button>
        <button class="btn btn-secondary" id="refreshBtn">🔄 刷新</button>
    </div>
    
    <div id="content">
        ${this._renderTable(peers)}
    </div>
    
    <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
            <h2 id="modalTitle">添加聊天对象</h2>
            <form id="peerForm">
                <input type="hidden" id="peerId">
                <div class="form-group">
                    <label for="hostname">主机名 *</label>
                    <input type="text" id="hostname" required placeholder="例如：Work-PC">
                </div>
                <div class="form-group">
                    <label for="nickname">昵称</label>
                    <input type="text" id="nickname" placeholder="可选，例如：张三">
                </div>
                <div class="form-group">
                    <label for="ip">IP 地址 *</label>
                    <input type="text" id="ip" required placeholder="例如：192.168.1.100">
                </div>
                <div class="form-group">
                    <label for="port">端口 *</label>
                    <input type="number" id="port" required min="1" max="65535" placeholder="例如：8080">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="cancelBtn">取消</button>
                    <button type="submit" class="btn btn-primary">保存</button>
                </div>
            </form>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let peers = ${JSON.stringify(peers)};
        
        // 添加按钮
        document.getElementById('addBtn').addEventListener('click', () => {
            openModal();
        });
        
        // 刷新按钮
        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });
        
        // 取消按钮
        document.getElementById('cancelBtn').addEventListener('click', () => {
            closeModal();
        });
        
        // 表单提交
        document.getElementById('peerForm').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const peerId = document.getElementById('peerId').value;
            const hostname = document.getElementById('hostname').value;
            const nickname = document.getElementById('nickname').value;
            const ip = document.getElementById('ip').value;
            const port = parseInt(document.getElementById('port').value);
            
            if (peerId) {
                // 更新
                vscode.postMessage({
                    type: 'updatePeer',
                    peer: {
                        id: peerId,
                        hostname,
                        nickname: nickname || undefined,
                        ip,
                        port
                    }
                });
            } else {
                // 添加
                vscode.postMessage({
                    type: 'addPeer',
                    peer: {
                        hostname,
                        nickname: nickname || undefined,
                        ip,
                        port
                    }
                });
            }
            
            closeModal();
        });
        
        // 处理来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                peers = message.peers;
                document.getElementById('content').innerHTML = renderTable(peers);
            }
        });
        
        function openModal(peer = null) {
            const modalOverlay = document.getElementById('modalOverlay');
            const modalTitle = document.getElementById('modalTitle');
            
            if (peer) {
                modalTitle.textContent = '编辑聊天对象';
                document.getElementById('peerId').value = peer.id;
                document.getElementById('hostname').value = peer.hostname;
                document.getElementById('nickname').value = peer.nickname || '';
                document.getElementById('ip').value = peer.ip;
                document.getElementById('port').value = peer.port;
            } else {
                modalTitle.textContent = '添加聊天对象';
                document.getElementById('peerId').value = '';
                document.getElementById('hostname').value = '';
                document.getElementById('nickname').value = '';
                document.getElementById('ip').value = '';
                document.getElementById('port').value = '';
            }
            
            modalOverlay.classList.add('visible');
        }
        
        function closeModal() {
            document.getElementById('modalOverlay').classList.remove('visible');
        }
        
        function renderTable(peers) {
            if (peers.length === 0) {
                return \`
                    <div class="empty-state">
                        <p>暂无聊天对象</p>
                        <p>点击"添加聊天对象"按钮添加新的通信目标</p>
                    </div>
                \`;
            }
            
            return \`
                <table class="peers-table">
                    <thead>
                        <tr>
                            <th>状态</th>
                            <th>主机名</th>
                            <th>昵称</th>
                            <th>IP 地址</th>
                            <th>端口</th>
                            <th>最后在线</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${peers.map(peer => \`
                            <tr>
                                <td>
                                    <span class="status-indicator \${peer.status === 'online' ? 'status-online' : 'status-offline'}"></span>
                                    \${peer.status === 'online' ? '在线' : '离线'}
                                </td>
                                <td>\${escapeHtml(peer.hostname)}</td>
                                <td>\${peer.nickname ? escapeHtml(peer.nickname) : '-'}</td>
                                <td>\${peer.ip}</td>
                                <td>\${peer.port}</td>
                                <td>\${formatTime(peer.lastSeen)}</td>
                                <td class="actions-cell">
                                    <button class="btn btn-secondary btn-small" onclick="editPeer('\${peer.id}')">编辑</button>
                                    <button class="btn btn-danger btn-small" onclick="deletePeer('\${peer.id}')">删除</button>
                                </td>
                            </tr>
                        \`).join('')}
                    </tbody>
                </table>
            \`;
        }
        
        function editPeer(id) {
            const peer = peers.find(p => p.id === id);
            if (peer) {
                openModal(peer);
            }
        }
        
        function deletePeer(id) {
            if (confirm('确定要删除这个聊天对象吗？')) {
                vscode.postMessage({
                    type: 'deletePeer',
                    id: id
                });
            }
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function formatTime(timestamp) {
            const date = new Date(timestamp);
            const now = Date.now();
            const diff = now - timestamp;
            
            if (diff < 60000) {
                return '刚刚';
            } else if (diff < 3600000) {
                return Math.floor(diff / 60000) + '分钟前';
            } else if (diff < 86400000) {
                return Math.floor(diff / 3600000) + '小时前';
            } else {
                return date.toLocaleDateString('zh-CN');
            }
        }
    </script>
</body>
</html>`;
    }

    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public refresh(): void {
        this._update();
    }
}