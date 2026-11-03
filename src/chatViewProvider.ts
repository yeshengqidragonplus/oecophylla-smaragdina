import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PeersManager } from './peersManager';
import { log } from './core/logger';
import { ChatStore } from './core/chatStore';
import { MessagingService, IncomingNotice } from './core/messaging';
import { networkService, NetworkStatus } from './core/networkService';
import { startNetworkFromConfig, stopNetwork } from './networkLauncher';
import { getLegacyChatHtml } from './legacyChatHtml';
import { toLegacySession } from './legacyChatAdapter';

/**
 * 侧边栏聊天视图：只负责 webview 桥接、当前选中的会话与文件选择、未读提醒。
 * 所有业务状态都在别处——会话与消息在 ChatStore，收发与文件传输在 MessagingService，
 * 联系人在 PeerRegistry（经 PeersManager）。视图订阅它们的变化并显示，不再持有业务状态。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'OSChatView';
    private _view?: vscode.WebviewView;
    /** 当前打开的会话；null 表示"新会话"（尚未选择联系人） */
    private _currentConversationId: string | null = null;
    private _selectedFiles: Map<string, { name: string; path: string; size: number }> = new Map();
    private _lastToastAt: number = 0;
    private _updateTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _peersManager: PeersManager,
        private readonly _store: ChatStore,
        private readonly _messaging: MessagingService
    ) {
        // 会话变化（含文件进度）合并后刷新界面：进度每收一块就变一次，不能每次都整页重绘
        this._store.on('change', () => {
            this._scheduleUpdate();
            this._updateBadge();
        });
        this._store.on('removed', () => this._scheduleUpdate());
        this._messaging.on('incoming', notice => this._notifyIncoming(notice));

        networkService.on('peersUpdate', () => this._updatePeersList());
        // 网络服务状态变化（含命令面板启动、自动启动、启动失败）都同步给界面
        networkService.on('statusChange', (status: NetworkStatus) => {
            this._postNetworkStatus(status.state === 'running');
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        // 用户看到侧边栏就算已读：清除当前会话的未读与徽标
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._markCurrentRead();
            }
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = getLegacyChatHtml(webviewView.webview, this._getNonce());
        this._setupMessageHandlers(webviewView.webview);
        // 界面脚本加载完成后会发 getPeers，届时一并回推全部状态（不再靠定时器抢跑）
    }

    // ==================== 与界面的消息 ====================

    private _setupMessageHandlers(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'webviewLog':
                    log(`[界面] ${message.text}`);
                    break;
                case 'sendMessage':
                    await this._handleSendMessage(message.content ?? '', message.targetPeer);
                    break;
                case 'loadSession':
                    this._currentConversationId = message.sessionId;
                    this._markCurrentRead();
                    this._updateWebviewContent();
                    break;
                case 'newChat':
                    this._currentConversationId = null;
                    this._updateWebviewContent();
                    break;
                case 'deleteSession':
                    await this._handleDeleteSession(message.sessionId);
                    break;
                case 'openSettings':
                    void vscode.commands.executeCommand('myChat.openSettings');
                    break;
                case 'selectFile':
                    await this._handleFileSelect();
                    break;
                case 'removeFile':
                    this._selectedFiles.delete(message.fileId);
                    this._updateFileListInWebview();
                    break;
                case 'clearFiles':
                    this._selectedFiles.clear();
                    this._updateFileListInWebview();
                    break;
                case 'getPeers':
                    // 界面刚加载完成或需要刷新：回推联系人、网络状态与会话
                    this._updatePeersList();
                    this._postNetworkStatus(networkService.isRunning());
                    this._updateWebviewContent();
                    break;
                case 'slashCommand':
                    this._handleSlashCommand(message.command);
                    break;
                case 'openPeersFile':
                    this._openPeersFile();
                    break;
                case 'selectPeer':
                    this._handleSelectPeer(message.peerId);
                    break;
                case 'startNetwork': {
                    const running = await startNetworkFromConfig(this._peersManager);
                    this._postNetworkStatus(running);
                    break;
                }
                case 'stopNetwork':
                    stopNetwork();
                    this._postNetworkStatus(false);
                    break;
            }
        });
    }

    private _openPeersFile(): void {
        const peersFilePath = this._peersManager.getPeersFilePath();
        if (fs.existsSync(peersFilePath)) {
            void vscode.window.showTextDocument(vscode.Uri.file(peersFilePath));
        } else {
            void vscode.window.showErrorMessage(`Peers 文件不存在: ${peersFilePath}`);
        }
    }

    /** 选择发送目标：切换到该联系人已有的会话；还没有会话则进入"新会话"，发送时创建 */
    private _handleSelectPeer(peerId: string): void {
        this._currentConversationId = this._store.findByPeer(peerId)?.id ?? null;
        this._markCurrentRead();
        this._updateWebviewContent();
    }

    private async _handleDeleteSession(conversationId: string): Promise<void> {
        const conv = this._store.get(conversationId);
        if (!conv) {
            return;
        }
        const confirm = '删除';
        const pick = await vscode.window.showWarningMessage(
            `删除与"${conv.title}"的全部聊天记录？此操作无法撤销。`, { modal: true }, confirm);
        if (pick !== confirm) {
            return;
        }
        this._store.remove(conversationId);
        if (this._currentConversationId === conversationId) {
            this._currentConversationId = null;
        }
        this._updateWebviewContent();
    }

    /** 斜杠命令是 AI 聊天模板的遗留：没有会话上下文，只用提示框展示 */
    private _handleSlashCommand(command: string): void {
        const cmd = (command ?? '').toLowerCase().trim();
        if (cmd === '/peers' || cmd === '/users' || cmd === '/list') {
            void vscode.window.showInformationMessage(this._peersManager.formatPeerList(), { modal: true });
        } else if (cmd === '/help') {
            void vscode.window.showInformationMessage('可用命令：/peers 列出通信对象；/help 显示帮助。点击"编辑聊天对象"可添加新的通信对象。');
        } else {
            void vscode.window.showWarningMessage(`未知的命令: ${command}，输入 /help 查看可用命令`);
        }
    }

    // ==================== 发送 ====================

    private async _handleFileSelect(): Promise<void> {
        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            title: '选择要发送的文件'
        });
        if (!fileUris || fileUris.length === 0) {
            return;
        }
        // 只记录元信息，发送时才流式读取内容，大文件不驻留内存
        for (const uri of fileUris) {
            const uniqueId = `${uri.fsPath}_${Date.now()}_${Math.random()}`;
            this._selectedFiles.set(uniqueId, {
                name: path.basename(uri.fsPath),
                path: uri.fsPath,
                size: fs.statSync(uri.fsPath).size
            });
        }
        this._updateFileListInWebview();
    }

    private _updateFileListInWebview(): void {
        this._view?.webview.postMessage({
            type: 'updateFileList',
            files: Array.from(this._selectedFiles.entries()).map(([id, file]) => ({ id, ...file }))
        });
    }

    private async _handleSendMessage(content: string, targetPeer?: string): Promise<void> {
        if (!content.trim() && this._selectedFiles.size === 0) {
            return;
        }
        if (content.startsWith('/')) {
            this._handleSlashCommand(content);
            return;
        }
        if (!targetPeer) {
            void vscode.window.showWarningMessage('请先选择发送目标');
            return;
        }
        const peer = this._peersManager.getPeerById(targetPeer);
        if (!peer) {
            void vscode.window.showWarningMessage(`未找到目标联系人: ${targetPeer}`);
            return;
        }

        const displayName = this._peersManager.getPeerDisplayName(peer);
        const files = Array.from(this._selectedFiles.values());
        this._selectedFiles.clear();
        this._updateFileListInWebview();

        // 发送者看着这个会话：切换过去并视为已读
        const conv = this._store.getOrCreate(peer.id, displayName);
        this._currentConversationId = conv.id;
        this._store.markRead(conv.id);
        this._updateWebviewContent();

        const outcomes = await this._messaging.send(peer.id, content, files);
        const failed = outcomes.filter(o => !o.ok);
        if (failed.length > 0) {
            void vscode.window.showErrorMessage(`发送给 ${displayName} 失败：${failed[0].error ?? '未知原因'}`);
        }
    }

    // ==================== 刷新界面 ====================

    private _updatePeersList(): void {
        this._view?.webview.postMessage({
            type: 'peersUpdate',
            peers: this._peersManager.getPeers().map(p => ({
                id: p.id,
                displayName: this._peersManager.getPeerDisplayName(p),
                ip: p.ip,
                port: p.port,
                status: p.status,
                hostname: p.hostname,
                nickname: p.nickname
            }))
        });
    }

    private _postNetworkStatus(running: boolean): void {
        this._view?.webview.postMessage({ type: 'networkStatus', running });
    }

    /** 会话变化合并后刷新：100ms 内的多次变化只发一次 */
    private _scheduleUpdate(): void {
        if (this._updateTimer) {
            return;
        }
        this._updateTimer = setTimeout(() => {
            this._updateTimer = null;
            this._updateWebviewContent();
        }, 100);
    }

    private _updateWebviewContent(): void {
        if (!this._view) {
            return;
        }
        const sessions = this._store.list().map(toLegacySession);
        const current = sessions.find(s => s.id === this._currentConversationId);
        this._view.webview.postMessage({
            type: 'update',
            sessions,
            recentSessions: sessions,
            currentSession: current,
            currentSessionId: current?.id ?? null
        });
    }

    // ==================== 未读与通知 ====================

    private _markCurrentRead(): void {
        if (this._currentConversationId) {
            this._store.markRead(this._currentConversationId);
        }
        this._updateBadge();
    }

    /** 活动栏图标的未读徽标：所有会话的未读数之和 */
    private _updateBadge(): void {
        if (!this._view) {
            return;
        }
        const unread = this._store.list().reduce((sum, c) => sum + c.unread, 0);
        this._view.badge = unread > 0 ? { value: unread, tooltip: `${unread} 条未读消息` } : undefined;
    }

    /**
     * 收到消息时的提醒：用户正看着该会话就直接标为已读、不打扰；
     * 否则记未读并更新徽标，通知最多每 5 秒一条，避免连发消息时刷屏
     */
    private _notifyIncoming(notice: IncomingNotice): void {
        const viewing = !!this._view?.visible && this._currentConversationId === notice.conversationId;
        if (viewing) {
            this._store.markRead(notice.conversationId);
            return;
        }
        this._updateBadge();

        const now = Date.now();
        if (now - this._lastToastAt < 5000) {
            return;
        }
        this._lastToastAt = now;
        const open = '查看';
        void vscode.window.showInformationMessage(`${notice.displayName}：${notice.preview}`, open).then(pick => {
            if (pick === open) {
                this._currentConversationId = notice.conversationId;
                this._markCurrentRead();
                void vscode.commands.executeCommand('workbench.view.extension.OSChatContainer');
                this._updateWebviewContent();
            }
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
        if (this._view) {
            this._updateWebviewContent();
            this._updatePeersList();
        }
    }
}
