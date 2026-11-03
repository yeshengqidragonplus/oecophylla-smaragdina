import * as vscode from 'vscode';
import { PeersManager } from './peersManager';
import { buildPeersEditorHtml } from './peersEditorHtml';

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
            _e => {
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
        this._peersManager.addPeer(peer.ip, peer.port, peer.nickname, peer.hostname);
        vscode.window.showInformationMessage(`已添加聊天对象：${peer.hostname}`);
        this._update();
    }

    private async _updatePeer(peer: { id: string; hostname: string; nickname?: string; ip: string; port: number }): Promise<void> {
        const edited = this._peersManager.editPeer(peer.id, {
            hostname: peer.hostname,
            nickname: peer.nickname,
            ip: peer.ip,
            port: peer.port
        });

        if (!edited) {
            vscode.window.showErrorMessage('未找到该聊天对象');
            return;
        }

        vscode.window.showInformationMessage(`已更新聊天对象：${peer.hostname}`);
        this._update();
    }

    /** 删除要先确认：webview 里的 confirm() 会被忽略，所以由扩展弹出模态确认框 */
    private async _deletePeer(id: string): Promise<void> {
        const peer = this._peersManager.getPeerById(id);
        if (!peer) {
            this._update();
            return;
        }
        const label = peer.nickname || peer.hostname || `${peer.ip}:${peer.port}`;
        const confirm = '删除';
        const pick = await vscode.window.showWarningMessage(
            `删除聊天对象“${label}”（${peer.ip}:${peer.port}）？`,
            { modal: true, detail: '聊天记录不会被删除；对方如果仍在线，之后会被重新发现。' },
            confirm
        );
        if (pick !== confirm) {
            return;
        }
        this._peersManager.removePeer(id);
        this._update();
        void vscode.window.showInformationMessage(`已删除聊天对象：${label}`);
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
        this._panel.webview.html = buildPeersEditorHtml({
            cspSource: this._panel.webview.cspSource,
            nonce: this._getNonce(),
            peers: this._peersManager.getPeers().map(p => ({
                id: p.id,
                hostname: p.hostname,
                nickname: p.nickname,
                ip: p.ip,
                port: p.port,
                lastSeen: p.lastSeen,
                status: p.status
            }))
        });
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
