import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PeersManager, StoredPeerInfo } from './peersManager';
import { log, logError } from './logger';
import { networkService, NetworkMessage, TransferTask } from './networkService';

interface ChatMessage {
    id: string;
    type: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    attachment?: {
        name: string;
        path: string;
        type: 'file' | 'image';
    };
    targetPeer?: string;
}

interface ChatSession {
    id: string;
    title: string;
    peerId?: string;  // 关联的聊天对象
    peerName?: string; // 聊天对象显示名称
    messages: ChatMessage[];
    lastUpdated: number;
    transferStatus?: 'completed' | 'transferring' | 'pending' | 'failed'; // 传输状态
    transferProgress?: number; // 传输进度 0-100
}

/**
 * 接收中的文件传输
 */
interface IncomingFileTransfer {
    fileName: string;
    fileSize: number;
    totalChunks: number;
    receivedChunks: number;
    chunks: Map<number, string>; // chunkIndex -> base64 data
    peerId: string;
    peerName: string;
    startTime: number;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'OSChatView';
    private _view?: vscode.WebviewView;
    private _sessions: ChatSession[] = [];
    private _currentSessionId: string | null = null;
    private _lastSelectedPeerId: string | null = null;
    private _context: vscode.ExtensionContext;
    private _peersManager: PeersManager;
    private _selectedFiles: Map<string, { name: string; path: string; size: number }> = new Map();
    private _activeTransferTasks: Map<string, TransferTask> = new Map();
    /** 接收中的文件传输 key: `${peerId}:${fileName}` */
    private _incomingFileTransfers: Map<string, IncomingFileTransfer> = new Map();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        peersManager: PeersManager
    ) {
        this._context = context;
        this._peersManager = peersManager;
        this._loadSessions();

        // 监听网络消息
        networkService.on('message', (msg: NetworkMessage) => {
            this._handleIncomingMessage(msg);
        });

        // 监听 peer 更新
        networkService.on('peersUpdate', () => {
            this._updatePeersList();
        });

        // 监听传输任务事件
        networkService.on('transferTaskCreated', (task: TransferTask) => {
            this._activeTransferTasks.set(task.id, task);
            this._updateTransferProgress(task);
        });

        networkService.on('transferTaskUpdated', (task: TransferTask) => {
            this._activeTransferTasks.set(task.id, task);
            this._updateTransferProgress(task);
        });

        networkService.on('transferTaskCompleted', (task: TransferTask) => {
            this._activeTransferTasks.delete(task.id);
            this._updateTransferProgress(task);
        });

        networkService.on('transferTaskFailed', (task: TransferTask) => {
            this._activeTransferTasks.set(task.id, task);
            this._updateTransferProgress(task);
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this._setupMessageHandlers(webviewView.webview);
        this._updateWebviewContent();
        this._updatePeersList();
        
        // 初始化网络服务状态
        setTimeout(() => {
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'networkStatus',
                    running: networkService.isRunning()
                });
            }
        }, 100);
    }

    private _loadSessions(): void {
        try {
            const sessionsPath = path.join(this._context.globalStorageUri.fsPath, 'chatSessions.json');
            if (fs.existsSync(sessionsPath)) {
                const data = fs.readFileSync(sessionsPath, 'utf-8');
                this._sessions = JSON.parse(data);
            }
        } catch (error) {
            console.error('Failed to load sessions:', error);
            this._sessions = [];
        }
    }

    private _saveSessions(): void {
        try {
            const sessionsPath = path.join(this._context.globalStorageUri.fsPath, 'chatSessions.json');
            const dir = path.dirname(sessionsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(sessionsPath, JSON.stringify(this._sessions, null, 2));
        } catch (error) {
            console.error('Failed to save sessions:', error);
        }
    }

    private _setupMessageHandlers(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'webviewLog':
                    log(`[界面] ${message.text}`);
                    break;
                case 'sendMessage':
                    log(`[发送] 收到 webview 发送请求: target=${message.targetPeer ?? '(未选择)'}, 内容长度=${(message.content ?? '').length}, 附件=${message.attachment?.name ?? '无'}`);
                    await this._handleSendMessage(message.content, message.attachment, message.targetPeer);
                    break;
                case 'loadSession':
                    this._loadSession(message.sessionId);
                    break;
                case 'newChat':
                    this._createNewChat();
                    break;
                case 'deleteSession':
                    this._deleteSession(message.sessionId);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('myChat.openSettings');
                    break;
                case 'selectFile':
                    await this._handleFileSelect();
                    break;
                case 'removeFile':
                    this._handleRemoveFile(message.fileId);
                    break;
                case 'clearFiles':
                    this._handleClearFiles();
                    break;
                case 'getPeers':
                    this._updatePeersList();
                    break;
                case 'slashCommand':
                    await this._handleSlashCommand(message.command);
                    break;
                case 'openPeersFile':
                    this._openPeersFile();
                    break;
                case 'selectPeer':
                    this._handleSelectPeer(message.peerId, message.peerName);
                    break;
                case 'startNetwork':
                    console.log('[DEBUG] Received startNetwork message, this._view:', this._view ? 'exists' : 'null');
                    await this._handleStartNetwork();
                    break;
                case 'stopNetwork':
                    console.log('[DEBUG] Received stopNetwork message, this._view:', this._view ? 'exists' : 'null');
                    this._handleStopNetwork();
                    break;
            }
        });
    }

    private _openPeersFile(): void {
        const peersFilePath = this._peersManager.getPeersFilePath();
        if (fs.existsSync(peersFilePath)) {
            vscode.window.showTextDocument(vscode.Uri.file(peersFilePath));
        } else {
            vscode.window.showErrorMessage(`Peers 文件不存在: ${peersFilePath}`);
        }
    }

    private _handleSelectPeer(peerId: string, peerName: string): void {
        // 保存选中的 peer 到当前会话
        const session = this._sessions.find(s => s.id === this._currentSessionId);
        if (session) {
            session.peerId = peerId;
            session.peerName = peerName;
            this._saveSessions();
        }
        console.log(`Selected peer: ${peerName} (${peerId})`);
    }

    private async _handleStartNetwork(): Promise<void> {
        console.log('[DEBUG] _handleStartNetwork called');
        const config = vscode.workspace.getConfiguration('oschat');
        const port = config.get('port', 8080);
        const nickname = config.get('nickname', '');
        const peersFilePath = this._peersManager.getPeersFilePath();

        try {
            await networkService.start(port, nickname, peersFilePath);
            vscode.window.showInformationMessage(`网络服务已启动，监听端口 ${port}`);
            // 通知 webview 更新状态
            if (this._view) {
                console.log('[DEBUG] Sending networkStatus running=true to webview');
                this._view.webview.postMessage({
                    type: 'networkStatus',
                    running: true,
                    port: port
                });
            } else {
                console.log('[DEBUG] this._view is null');
            }
        } catch (error) {
            console.log('[DEBUG] _handleStartNetwork error:', error);
            vscode.window.showErrorMessage(`启动网络服务失败：${error}`);
        }
    }

    private _handleStopNetwork(): void {
        console.log('[DEBUG] _handleStopNetwork called');
        networkService.stop();
        vscode.window.showInformationMessage('网络服务已停止');
        // 通知 webview 更新状态
        if (this._view) {
            console.log('[DEBUG] Sending networkStatus running=false to webview');
            this._view.webview.postMessage({
                type: 'networkStatus',
                running: false
            });
        } else {
            console.log('[DEBUG] this._view is null in _handleStopNetwork');
        }
    }

    private async _handleSlashCommand(command: string): Promise<void> {
        const cmd = command.toLowerCase().trim();
        
        if (cmd === '/peers' || cmd === '/users' || cmd === '/list') {
            const peers = this._peersManager.getPeers();
            let content = '📋 已配置的通信对象：\n\n';
            
            if (peers.length === 0) {
                content += '暂无已配置的通信对象\n';
                content += '请点击"编辑聊天对象"或在 peers.json 文件中添加配置';
            } else {
                peers.forEach(peer => {
                    const status = peer.status === 'online' ? '🟢' : '⚪';
                    const displayName = this._peersManager.getPeerDisplayName(peer);
                    content += `${status} ${displayName}\n`;
                    content += `   IP: ${peer.ip}:${peer.port}\n`;
                    content += `   主机名: ${peer.hostname}\n`;
                    if (peer.nickname) {
                        content += `   昵称: ${peer.nickname}\n`;
                    }
                    content += '\n';
                });
            }

            this._addSystemMessage(content);
            this._updateWebviewContent();
        } else if (cmd === '/help') {
            const helpContent = `📖 可用命令：

/peers - 列出所有已配置的通信对象
/help - 显示帮助信息

提示：
- 输入 / 后会自动显示命令提示
- 点击"编辑聊天对象"可添加新的通信对象`;
            this._addSystemMessage(helpContent);
        } else {
            this._addSystemMessage(`❌ 未知的命令: ${command}\n输入 /help 查看可用命令`);
        }
    }

    private _addSystemMessage(content: string): void {
        const systemMessage: ChatMessage = {
            id: Date.now().toString(),
            type: 'system',
            content: content,
            timestamp: Date.now()
        };
        this._addMessageToCurrentSession(systemMessage);
        this._updateWebviewContent();
    }

    private _handleIncomingMessage(msg: NetworkMessage): void {
        const peer = this._peersManager.getPeerById(msg.from);
        const displayName = peer ? this._peersManager.getPeerDisplayName(peer) : msg.from;

        if (msg.type === 'file') {
            this._handleFileChunk(msg, displayName);
            return;
        }

        if (msg.type !== 'message') {
            return;
        }

        const incomingMessage: ChatMessage = {
            id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'assistant',
            content: `📨 来自 ${displayName}:\n${msg.content || ''}`,
            timestamp: Date.now()
        };

        // 按发送方归入对应会话，而不是塞进当前打开的会话
        const session = this._getOrCreateSessionForPeer(msg.from, displayName);
        this._appendMessageToSession(session, incomingMessage);
        this._updateWebviewContent();
    }

    /**
     * 查找或创建与指定 peer 关联的会话
     */
    private _getOrCreateSessionForPeer(peerId: string, displayName: string): ChatSession {
        let session = this._sessions.find(s => s.peerId === peerId);
        if (!session) {
            session = {
                id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                title: displayName,
                peerId: peerId,
                peerName: displayName,
                messages: [],
                lastUpdated: Date.now()
            };
            this._sessions.unshift(session);
            // 没有打开任何会话时，自动切到新消息所在会话
            if (!this._currentSessionId) {
                this._currentSessionId = session.id;
            }
        }
        return session;
    }

    private _appendMessageToSession(session: ChatSession, message: ChatMessage): void {
        session.messages.push(message);
        session.lastUpdated = Date.now();
        this._saveSessions();
    }

    private _addSystemMessageToPeerSession(peerId: string, displayName: string, content: string): void {
        const session = this._getOrCreateSessionForPeer(peerId, displayName);
        this._appendMessageToSession(session, {
            id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            type: 'system',
            content: content,
            timestamp: Date.now()
        });
        this._updateWebviewContent();
    }

    private _handleFileChunk(msg: NetworkMessage, displayName: string): void {
        if (!msg.file || msg.file.chunkIndex === undefined || msg.file.totalChunks === undefined || !msg.file.data) {
            return;
        }

        const transferKey = `${msg.from}:${msg.file.name}`;
        let transfer = this._incomingFileTransfers.get(transferKey);

        if (!transfer) {
            // 首次收到该文件，创建传输记录
            transfer = {
                fileName: msg.file.name,
                fileSize: msg.file.size,
                totalChunks: msg.file.totalChunks,
                receivedChunks: 0,
                chunks: new Map(),
                peerId: msg.from,
                peerName: displayName,
                startTime: Date.now()
            };
            this._incomingFileTransfers.set(transferKey, transfer);

            // 添加系统消息：开始接收
            this._addSystemMessageToPeerSession(msg.from, displayName, `📥 正在接收来自 ${displayName} 的文件: ${msg.file.name} (${this._formatFileSize(msg.file.size)})`);
        }

        // 如果该块已接收过，跳过
        if (transfer.chunks.has(msg.file.chunkIndex)) {
            return;
        }

        // 存储块数据
        transfer.chunks.set(msg.file.chunkIndex, msg.file.data);
        transfer.receivedChunks = transfer.chunks.size;

        // 更新进度
        const progress = Math.floor((transfer.receivedChunks / transfer.totalChunks) * 100);
        this._updateReceiveProgressUI(transferKey, transfer, progress);

        // 检查是否所有块都已接收
        if (transfer.receivedChunks >= transfer.totalChunks) {
            this._assembleAndSaveFile(transferKey, transfer);
        }
    }

    private _updateReceiveProgressUI(transferKey: string, transfer: IncomingFileTransfer, progress: number): void {
        // 更新会话中的传输状态
        const session = this._sessions.find(s => s.peerId === transfer.peerId);
        if (session) {
            session.transferStatus = 'transferring';
            session.transferProgress = progress;
            this._saveSessions();
        }

        // 通知 webview 更新进度
        if (this._view) {
            this._view.webview.postMessage({
                type: 'transferProgress',
                taskId: transferKey,
                status: 'transferring',
                progress: progress,
                transferredBytes: Math.floor((progress / 100) * transfer.fileSize),
                totalBytes: transfer.fileSize
            });
        }
    }

    private _assembleAndSaveFile(transferKey: string, transfer: IncomingFileTransfer): void {
        try {
            // 按顺序组装所有块
            let fileData = '';
            for (let i = 0; i < transfer.totalChunks; i++) {
                const chunk = transfer.chunks.get(i);
                if (chunk === undefined) {
                    throw new Error(`缺少文件块 ${i + 1}/${transfer.totalChunks}`);
                }
                fileData += chunk;
            }

            // 确定保存路径
            const downloadPath = this._getDownloadPath(transfer.fileName);
            const dir = path.dirname(downloadPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // 写入文件（base64 解码）
            const buffer = Buffer.from(fileData, 'base64');
            fs.writeFileSync(downloadPath, buffer);

            // 清理传输记录
            this._incomingFileTransfers.delete(transferKey);

            // 更新会话状态
            const session = this._sessions.find(s => s.peerId === transfer.peerId);
            if (session) {
                session.transferStatus = 'completed';
                session.transferProgress = 100;
                this._saveSessions();
            }

            // 添加系统消息
            this._addSystemMessageToPeerSession(transfer.peerId, transfer.peerName, `✅ 已接收来自 ${transfer.peerName} 的文件: ${transfer.fileName} (${this._formatFileSize(transfer.fileSize)})\n📁 保存位置: ${downloadPath}`);

            // 通知 webview 完成
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'transferProgress',
                    taskId: transferKey,
                    status: 'completed',
                    progress: 100,
                    transferredBytes: transfer.fileSize,
                    totalBytes: transfer.fileSize
                });
            }

            // 弹出通知
            vscode.window.showInformationMessage(`已接收文件: ${transfer.fileName}`);

        } catch (err) {
            const errorMsg = (err as Error).message;
            console.error('文件接收失败:', errorMsg);

            // 更新会话状态为失败
            const session = this._sessions.find(s => s.peerId === transfer.peerId);
            if (session) {
                session.transferStatus = 'failed';
                this._saveSessions();
            }

            this._addSystemMessageToPeerSession(transfer.peerId, transfer.peerName, `❌ 文件接收失败: ${transfer.fileName} - ${errorMsg}`);

            // 清理传输记录
            this._incomingFileTransfers.delete(transferKey);

            vscode.window.showErrorMessage(`文件接收失败: ${transfer.fileName}`);
        }

        this._updateWebviewContent();
    }

    private _formatFileSize(bytes: number): string {
        if (bytes < 1024) {return bytes + ' B';}
        if (bytes < 1024 * 1024) {return (bytes / 1024).toFixed(2) + ' KB';}
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    private _getDownloadPath(fileName: string): string {
        const config = vscode.workspace.getConfiguration('oschat');
        const customPath = config.get<string>('downloadPath', '');
        const baseDir = customPath || path.join(this._context.globalStorageUri.fsPath, 'downloads');

        // 防止路径穿越：只取文件名部分，并过滤非法字符
        const safeName = path.basename(fileName).replace(/[\\/:*?"<>|]/g, '_') || 'received_file';

        // 同名文件不覆盖，自动加序号
        let target = path.join(baseDir, safeName);
        if (fs.existsSync(target)) {
            const ext = path.extname(safeName);
            const stem = path.basename(safeName, ext);
            for (let i = 1; ; i++) {
                target = path.join(baseDir, `${stem} (${i})${ext}`);
                if (!fs.existsSync(target)) {
                    break;
                }
            }
        }
        return target;
    }

    private async _handleFileSelect(): Promise<void> {
        const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            title: '选择要发送的文件'
        });

        if (fileUris && fileUris.length > 0) {
            // 只记录元信息，文件内容在发送时分块流式读取，避免大文件驻留内存
            fileUris.forEach(uri => {
                const uniqueId = `${uri.fsPath}_${Date.now()}_${Math.random()}`;
                this._selectedFiles.set(uniqueId, {
                    name: path.basename(uri.fsPath),
                    path: uri.fsPath,
                    size: fs.statSync(uri.fsPath).size
                });
            });

            this._updateFileListInWebview();
        }
    }
    
    private _updateFileListInWebview(): void {
        if (!this._view) {
            return;
        }
        
        const filesArray = Array.from(this._selectedFiles.entries()).map(([id, file]) => ({
            id,
            name: file.name,
            path: file.path,
            size: file.size
        }));
        
        this._view.webview.postMessage({
            type: 'updateFileList',
            files: filesArray
        });
    }
    
    private _handleRemoveFile(fileId: string): void {
        this._selectedFiles.delete(fileId);
        this._updateFileListInWebview();
    }
    
    private _handleClearFiles(): void {
        this._selectedFiles.clear();
        this._updateFileListInWebview();
    }

    private async _handleSendMessage(
        content: string,
        attachment?: { name: string; path: string; type: 'file' | 'image' },
        targetPeer?: string
    ): Promise<void> {
        if (!content.trim() && this._selectedFiles.size === 0) {
            log('[发送] 忽略：内容为空且无附件');
            return;
        }

        // 检查是否是斜杠命令
        if (content.startsWith('/')) {
            await this._handleSlashCommand(content);
            return;
        }

        // 必须选择目标
        if (!targetPeer) {
            log('[发送] 中止：未选择发送目标');
            this._addSystemMessage('❌ 请先选择发送目标');
            this._updateWebviewContent();
            return;
        }

        const peer = this._peersManager.getPeerById(targetPeer);
        if (!peer) {
            log(`[发送] 中止：peers 列表中找不到 ${targetPeer}`);
            this._addSystemMessage(`❌ 未找到目标用户: ${targetPeer}`);
            this._updateWebviewContent();
            return;
        }

        const displayName = this._peersManager.getPeerDisplayName(peer);

        // 创建用户消息
        const userMessage: ChatMessage = {
            id: Date.now().toString(),
            type: 'user',
            content: content,
            timestamp: Date.now(),
            targetPeer: targetPeer
        };

        this._addMessageToCurrentSession(userMessage);

        // 准备发送内容
        const messages: string[] = content.trim() ? [content] : [];
        const files: { name: string; path: string; size: number }[] = [];

        // 添加选中的文件
        this._selectedFiles.forEach(file => {
            files.push({
                name: file.name,
                path: file.path,
                size: file.size
            });
        });

        // 清空文件选择
        this._selectedFiles.clear();
        this._updateFileListInWebview();

        // 创建传输任务
        try {
            const task = networkService.createTransferTask(targetPeer, messages, files);
            
            // 更新会话状态
            const session = this._sessions.find(s => s.id === this._currentSessionId);
            if (session) {
                session.peerId = targetPeer;
                session.peerName = displayName;
                session.transferStatus = 'pending';
                session.transferProgress = 0;
                this._saveSessions();
            }

            this._addSystemMessage(`⏳ 正在与 ${displayName} 建立连接...`);
            this._updateWebviewContent();

            // 执行传输
            log(`[发送] 开始执行传输任务 ${task.id} → ${targetPeer}（消息 ${messages.length} 条 / 文件 ${files.length} 个）`);
            await networkService.executeTransferTask(task.id);

            log(`[发送] 传输任务 ${task.id} 完成`);
            this._addSystemMessage(`✅ 已成功发送给 ${displayName}`);
            
            // 更新会话状态为完成
            if (session) {
                session.transferStatus = 'completed';
                session.transferProgress = 100;
                session.lastUpdated = Date.now();
                this._saveSessions();
            }
            
        } catch (error) {
            const errorMessage = (error as Error).message;
            logError(`[发送] 失败: ${errorMessage}`);

            if (errorMessage.includes('Connect timeout') || errorMessage.includes('超时')) {
                this._addSystemMessage(`❌ 连接超时: ${displayName} 可能不在线`);
                
                // 更新会话状态为失败
                const session = this._sessions.find(s => s.id === this._currentSessionId);
                if (session) {
                    session.transferStatus = 'failed';
                    this._saveSessions();
                }
                
                // 弹出超时提示
                vscode.window.showErrorMessage(`发送失败: ${displayName} 不在线或未响应（5秒超时）`);
            } else {
                this._addSystemMessage(`❌ 发送失败: ${errorMessage}`);
                
                const session = this._sessions.find(s => s.id === this._currentSessionId);
                if (session) {
                    session.transferStatus = 'failed';
                    this._saveSessions();
                }
            }
        }

        this._updateWebviewContent();
    }

    private _updateTransferProgress(task: TransferTask): void {
        // 找到关联的会话
        const session = this._sessions.find(s => s.peerId === task.peerId);
        if (session) {
            session.transferStatus = task.status === 'completed' ? 'completed' :
                                     task.status === 'transferring' ? 'transferring' :
                                     task.status === 'failed' ? 'failed' :
                                     task.status === 'timeout' ? 'failed' : 'pending';
            session.transferProgress = task.progress;
            this._saveSessions();
            this._updateWebviewContent();
        }

        // 发送进度更新到 webview
        if (this._view) {
            this._view.webview.postMessage({
                type: 'transferProgress',
                taskId: task.id,
                status: task.status,
                progress: task.progress,
                transferredBytes: task.transferredBytes,
                totalBytes: task.totalBytes
            });
        }
    }

    private _addMessageToCurrentSession(message: ChatMessage): void {
        let session = this._sessions.find(s => s.id === this._currentSessionId);
        
        if (!session) {
            session = {
                id: Date.now().toString(),
                title: message.content.substring(0, 30) || message.attachment?.name || '新会话',
                messages: [],
                lastUpdated: Date.now()
            };
            this._currentSessionId = session.id;
            this._sessions.unshift(session);
        }

        session.messages.push(message);
        session.lastUpdated = Date.now();
        
        // 更新标题
        if (session.messages.length === 1 && message.content && message.type === 'user') {
            session.title = message.content.substring(0, 30) + (message.content.length > 30 ? '...' : '');
        }

        this._saveSessions();
    }

    private _loadSession(sessionId: string): void {
        this._currentSessionId = sessionId;
        this._updateWebviewContent();
    }

    private _createNewChat(): void {
        this._currentSessionId = null;
        this._updateWebviewContent();
    }

    private _deleteSession(sessionId: string): void {
        this._sessions = this._sessions.filter(s => s.id !== sessionId);
        if (this._currentSessionId === sessionId) {
            this._currentSessionId = null;
        }
        this._saveSessions();
        this._updateWebviewContent();
    }

    private _updatePeersList(): void {
        if (!this._view) {
            return;
        }

        const peers = this._peersManager.getPeers();
        console.log('[DEBUG] _updatePeersList: raw peers from manager:', JSON.stringify(peers));
        this._view.webview.postMessage({
            type: 'peersUpdate',
            peers: peers.map(p => {
                const peerData = {
                    id: p.id,
                    displayName: this._peersManager.getPeerDisplayName(p),
                    ip: p.ip,
                    port: p.port,
                    status: p.status,
                    hostname: p.hostname,
                    nickname: p.nickname
                };
                console.log('[DEBUG] _updatePeersList: mapped peer:', JSON.stringify(peerData));
                return peerData;
            })
        });
    }

    private _updateWebviewContent(): void {
        if (!this._view) {
            return;
        }

        const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
        // 按最后更新时间排序，最近的在前面
        const recentSessions = [...this._sessions].sort((a, b) => b.lastUpdated - a.lastUpdated);

        this._view.webview.postMessage({
            type: 'update',
            sessions: this._sessions,
            recentSessions: recentSessions,
            currentSession: currentSession,
            currentSessionId: this._currentSessionId
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = this._getNonce();
        
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>OS Chat</title>
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
            background-color: var(--vscode-sideBar-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .header {
            display: none;
        }
        
        .recent-section {
            padding: 12px 16px;
            border-bottom: 1px solid var(--vscode-widget-border);
            max-height: 200px;
            overflow-y: auto;
            flex-shrink: 0;
        }
        
        .recent-title {
            font-size: 12px;
            font-weight: bold;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .view-all-btn {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 11px;
        }
        
        .recent-item {
            padding: 8px 10px;
            border-radius: 6px;
            cursor: pointer;
            margin-bottom: 4px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .recent-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .recent-item.active {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
            border-color: var(--vscode-focusBorder);
        }
        
        /* 状态点样式 */
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        
        .status-dot.completed {
            background-color: #4CAF50; /* 绿色 - 完成 */
        }
        
        .status-dot.transferring {
            background-color: #F44336; /* 红色 - 正在传输 */
        }
        
        .status-dot.pending {
            background-color: #9E9E9E; /* 灰色 - 等待中 */
        }
        
        .status-dot.failed {
            background-color: #F44336; /* 红色 - 失败 */
        }
        
        /* 聊天对象名称 */
        .recent-peer-name {
            font-size: 13px;
            font-weight: 500;
            flex-shrink: 0;
            max-width: 100px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        /* 对话内容预览 */
        .recent-content-preview {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        /* 删除按钮 */
        .delete-btn {
            background: none;
            border: none;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            padding: 2px 4px;
            font-size: 12px;
            opacity: 0;
            transition: opacity 0.2s;
            flex-shrink: 0;
        }
        
        .recent-item:hover .delete-btn {
            opacity: 1;
        }
        
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            min-height: 200px;
        }
        
        .message {
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
        }
        
        .message.user {
            align-items: flex-end;
        }
        
        .message.assistant {
            align-items: flex-start;
        }
        
        .message.system {
            align-items: flex-start;
        }
        
        .message-content {
            max-width: 85%;
            padding: 10px 14px;
            border-radius: 12px;
            word-wrap: break-word;
            line-height: 1.5;
        }
        
        .message.user .message-content {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 4px;
        }
        
        .message.assistant .message-content {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-bottom-left-radius: 4px;
        }
        
        .message.system .message-content {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            font-size: 12px;
            white-space: pre-wrap;
        }
        
        .message-attachment {
            margin-top: 6px;
            padding: 6px 10px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 6px;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        /* 传输进度条 */
        .transfer-progress {
            margin-top: 6px;
            padding: 4px 8px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            font-size: 11px;
        }
        
        .progress-bar {
            height: 4px;
            background-color: var(--vscode-progressBar-background);
            border-radius: 2px;
            margin-top: 4px;
        }
        
        .progress-fill {
            height: 100%;
            background-color: var(--vscode-button-background);
            border-radius: 2px;
            transition: width 0.3s;
        }
        
        .input-section {
            padding: 12px 16px;
            border-top: 1px solid var(--vscode-widget-border);
            background-color: var(--vscode-sideBar-background);
        }
        
        .input-wrapper {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .top-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        
        .target-selector-container {
            position: relative;
            cursor: pointer;
        }
        
        .target-selector {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 10px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            min-width: 100px;
            max-width: 150px;
            flex-shrink: 0;
            height: 32px;
            user-select: none;
            -webkit-user-select: none;
        }
        
        .target-selector:hover {
            border-color: var(--vscode-focusBorder);
        }
        
        .target-selector-text,
        .target-selector-arrow {
            pointer-events: none;
        }
        
        .target-selector-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .target-selector-arrow {
            margin-left: 6px;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        
        .target-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            background-color: var(--vscode-editorSuggestWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 100;
            display: none;
            margin-top: 4px;
            min-width: 150px;
            width: 200px;
        }
        
        .target-dropdown.visible {
            display: block;
        }
        
        .target-dropdown-item {
            padding: 6px 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            user-select: none;
            -webkit-user-select: none;
        }
        
        .target-dropdown-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .target-dropdown-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        
        .target-dropdown-item * {
            pointer-events: none;
        }
        
        .target-dropdown-status {
            font-size: 11px;
        }
        
        .target-dropdown-name {
            flex: 1;
        }
        
        .file-list-container {
            flex: 1;
            min-width: 0;
        }
        
        .file-attachment-area {
            display: none;
            flex-wrap: wrap;
            gap: 4px;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            max-height: 120px;
            overflow-y: auto;
            flex: 1;
            min-width: 0;
        }
        
        .file-attachment-area.has-files {
            display: flex;
        }
        
        .file-attachment {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 3px 6px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            font-size: 11px;
            white-space: nowrap;
        }
        
        .file-attachment-name {
            max-width: 150px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .file-attachment-size {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }
        
        .file-attachment-remove {
            background: none;
            border: none;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            padding: 0 2px;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .input-row {
            display: flex;
            gap: 8px;
            align-items: stretch;
        }
        
        .message-input {
            flex: 1;
            min-height: 60px;
            max-height: 150px;
            padding: 10px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: 14px;
            resize: none;
            line-height: 1.4;
        }
        
        .message-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        .action-buttons {
            display: flex;
            flex-direction: column;
            gap: 6px;
            flex-shrink: 0;
            justify-content: flex-start;
            padding-top: 2px;
        }
        
        .send-btn {
            width: 36px;
            height: 36px;
            border: none;
            border-radius: 8px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            flex-shrink: 0;
        }
        
        .send-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .file-btn {
            width: 36px;
            height: 36px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            flex-shrink: 0;
        }
        
        .file-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        
        .slash-commands-hint {
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 60px;
            background-color: var(--vscode-editorSuggestWidget-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 8px;
            font-size: 12px;
            display: none;
            z-index: 10;
        }
        
        .slash-commands-hint.visible {
            display: block;
        }
        
        .slash-command-item {
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 4px;
        }
        
        .slash-command-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .input-container {
            position: relative;
        }
        
        .no-peers-hint {
            padding: 8px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }
        
        .open-peers-btn {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            font-size: 12px;
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <span class="header-title">🐜 OS Chat</span>
        <div class="header-actions">
            <button class="header-btn" id="networkBtn" data-state="stopped" title="启动监听">
                <span class="btn-icon">▶️</span>
            </button>
            <button class="header-btn" id="settingsBtn" title="设置">⚙️</button>
        </div>
    </div>
    
    <div class="recent-section" id="recentSection" style="order: -1;">
        <div class="recent-title">
            <span>最近对话</span>
            <button class="view-all-btn" id="viewAllBtn">查看全部</button>
        </div>
        <div id="recentList"></div>
    </div>
    
    <div class="chat-container" id="chatContainer">
        <div id="messagesList"></div>
    </div>
    
    <div class="input-section">
        <div class="input-wrapper">
            <div class="top-row">
                <div class="target-selector-container" style="position: relative;">
                    <div id="targetSelector" class="target-selector">
                        <span id="targetSelectorText" class="target-selector-text">选择目标</span>
                        <span class="target-selector-arrow">▼</span>
                    </div>
                    <div id="targetDropdown" class="target-dropdown"></div>
                </div>
                <div id="fileAttachmentArea" class="file-attachment-area"></div>
            </div>
            
            <div class="input-container" style="position: relative;">
                <div class="slash-commands-hint" id="slashHint">
                    <div class="slash-command-item" data-cmd="/peers">/peers - 列出通信对象</div>
                    <div class="slash-command-item" data-cmd="/help">/help - 显示帮助</div>
                </div>
                <div class="input-row">
                    <textarea class="message-input" id="messageInput" placeholder="输入消息或 / 命令..." rows="2"></textarea>
                    <div class="action-buttons">
                        <button class="file-btn" id="fileBtn" title="选择文件">📎</button>
                        <button class="send-btn" id="sendBtn" title="发送">➤</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        let selectedFiles = [];
        let selectedPeer = null;
        let currentSessionId = null;
        let allSessions = [];
        let allPeers = [];
        let isNetworkRunning = false; // 网络服务运行状态
        
        // 获取头部按钮元素
        const networkBtn = document.getElementById('networkBtn');
        const settingsBtn = document.getElementById('settingsBtn');
        console.log('[DEBUG] networkBtn element:', networkBtn);
        
        window.addEventListener('message', function(event) {
            const message = event.data;
            
            if (message.type === 'update') {
                allSessions = message.sessions;
                currentSessionId = message.currentSessionId;
                updateRecentList(message.recentSessions);
                updateMessages(message.currentSession);
            } else if (message.type === 'updateFileList') {
                selectedFiles = message.files || [];
                updateFileList();
            } else if (message.type === 'peersUpdate') {
                allPeers = message.peers;
                console.log('[DEBUG] peersUpdate received, peers:', allPeers);
                updateTargetDropdownList();
                if (selectedPeer) {
                    const peer = allPeers.find(p => p.id === selectedPeer);
                    if (peer) {
                        targetSelectorText.textContent = peer.displayName;
                    }
                }
            } else if (message.type === 'transferProgress') {
                updateTransferProgress(message);
            } else if (message.type === 'networkStatus') {
                console.log('[DEBUG] Received networkStatus message, running:', message.running);
                isNetworkRunning = message.running;
                if (isNetworkRunning) {
                    if (networkBtn) {
                        networkBtn.setAttribute('data-state', 'running');
                        networkBtn.title = '暂停监听';
                        const btnIcon = networkBtn.querySelector('.btn-icon');
                        if (btnIcon) { btnIcon.textContent = '⏸️'; }
                        console.log('[DEBUG] Set button to paused state');
                    }
                } else {
                    if (networkBtn) {
                        networkBtn.setAttribute('data-state', 'stopped');
                        networkBtn.title = '启动监听';
                        const btnIcon = networkBtn.querySelector('.btn-icon');
                        if (btnIcon) { btnIcon.textContent = '▶️'; }
                        console.log('[DEBUG] Set button to playing state');
                    }
                }
            }
        });

        const messageInput = document.getElementById('messageInput');
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 150) + 'px';
            
            const slashHint = document.getElementById('slashHint');
            if (this.value.startsWith('/')) {
                slashHint.classList.add('visible');
            } else {
                slashHint.classList.remove('visible');
            }
        });

        document.querySelectorAll('.slash-command-item').forEach(item => {
            item.addEventListener('click', () => {
                const cmd = item.dataset.cmd;
                messageInput.value = cmd;
                messageInput.focus();
                document.getElementById('slashHint').classList.remove('visible');
            });
        });

        // 绑定网络按钮点击事件
        if (networkBtn) {
            networkBtn.addEventListener('click', function() {
                console.log('[DEBUG] networkBtn clicked!');
                console.log('[DEBUG] toggleNetworkService called, isNetworkRunning:', isNetworkRunning);
                const btnIcon = networkBtn.querySelector('.btn-icon');
                if (isNetworkRunning) {
                    // 停止监听
                    console.log('[DEBUG] Posting stopNetwork message');
                    vscode.postMessage({ type: 'stopNetwork' });
                    networkBtn.setAttribute('data-state', 'stopped');
                    networkBtn.title = '启动监听';
                    if (btnIcon) { btnIcon.textContent = '▶️'; }
                    isNetworkRunning = false;
                } else {
                    // 启动监听
                    console.log('[DEBUG] Posting startNetwork message');
                    vscode.postMessage({ type: 'startNetwork' });
                    networkBtn.setAttribute('data-state', 'running');
                    networkBtn.title = '暂停监听';
                    if (btnIcon) { btnIcon.textContent = '⏸️'; }
                    isNetworkRunning = true;
                }
                console.log('[DEBUG] toggleNetworkService finished, isNetworkRunning:', isNetworkRunning);
            });
        } else {
            console.log('[DEBUG] networkBtn not found!');
        }

        messageInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // 界面日志转发到扩展（"OSChat 日志"输出通道），便于排查界面层问题
        function dbg(text) {
            try { vscode.postMessage({ type: 'webviewLog', text: text }); } catch (e) { /* ignore */ }
        }
        dbg('webview 脚本已加载');

        document.getElementById('sendBtn').addEventListener('click', function() {
            dbg('点击发送按钮');
            sendMessage();
        });

        function sendMessage() {
            const content = messageInput.value.trim();
            dbg('sendMessage(): 目标=' + (selectedPeer || '(未选择)') + ', 内容长度=' + content.length + ', 附件数=' + selectedFiles.length);
            if (!content && selectedFiles.length === 0) {
                dbg('sendMessage(): 内容为空且无附件，忽略');
                return;
            }

            for (const file of selectedFiles) {
                vscode.postMessage({
                    type: 'sendMessage',
                    content: content,
                    attachment: {
                        name: file.name,
                        path: file.path,
                        type: file.name.match(/\\.(png|jpg|jpeg|gif|svg|webp)$/i) ? 'image' : 'file'
                    },
                    targetPeer: selectedPeer
                });
            }

            // 如果没有文件但有内容，也要发送
            if (selectedFiles.length === 0 && content) {
                vscode.postMessage({
                    type: 'sendMessage',
                    content: content,
                    targetPeer: selectedPeer
                });
            }

            messageInput.value = '';
            messageInput.style.height = 'auto';
            document.getElementById('slashHint').classList.remove('visible');
            clearFileSelection();
        }

        document.getElementById('fileBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'selectFile' });
        });

        function clearFileSelection() {
            vscode.postMessage({ type: 'clearFiles' });
        }

        function updateFileList() {
            const fileAttachmentArea = document.getElementById('fileAttachmentArea');
            
            if (selectedFiles.length === 0) {
                fileAttachmentArea.innerHTML = '';
                fileAttachmentArea.classList.remove('has-files');
                return;
            }
            
            fileAttachmentArea.classList.add('has-files');
            
            fileAttachmentArea.innerHTML = selectedFiles.map((file) => \`
                <div class="file-attachment">
                    <span>📎</span>
                    <span class="file-attachment-name">\${escapeHtml(file.name)}</span>
                    <span class="file-attachment-size">\${formatFileSize(file.size)}</span>
                    <button class="file-attachment-remove" data-file-id="\${file.id}" title="删除">✕</button>
                </div>
            \`).join('');
            
            fileAttachmentArea.querySelectorAll('.file-attachment-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const fileId = btn.dataset.fileId;
                    vscode.postMessage({ type: 'removeFile', fileId: fileId });
                });
            });
        }
        
        function formatFileSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }

        const targetSelector = document.getElementById('targetSelector');
        const targetDropdown = document.getElementById('targetDropdown');
        const targetSelectorText = document.getElementById('targetSelectorText');

        console.log('[DEBUG] targetSelector element:', targetSelector);
        console.log('[DEBUG] targetDropdown element:', targetDropdown);

        targetSelector.addEventListener('click', (e) => {
            console.log('[DEBUG] targetSelector clicked!', e);
            e.preventDefault();
            e.stopPropagation();
            console.log('[DEBUG] calling toggleTargetDropdown');
            toggleTargetDropdown();
            return false;
        });

        // 点击外部时关闭下拉菜单
        document.addEventListener('click', function(e) {
            const targetSelectorContainer = document.querySelector('.target-selector-container');
            if (targetSelectorContainer && !targetSelectorContainer.contains(e.target)) {
                hideTargetDropdown();
            }
        });

        function toggleTargetDropdown() {
            console.log('[DEBUG] toggleTargetDropdown called, current visible:', targetDropdown.classList.contains('visible'));
            if (targetDropdown.classList.contains('visible')) {
                console.log('[DEBUG] hiding dropdown');
                hideTargetDropdown();
            } else {
                console.log('[DEBUG] showing dropdown');
                showTargetDropdown();
            }
        }

        function showTargetDropdown() {
            console.log('[DEBUG] showTargetDropdown called');
            updateTargetDropdownList();
            targetDropdown.classList.add('visible');
            console.log('[DEBUG] dropdown visible class added');
        }

        function hideTargetDropdown() {
            console.log('[DEBUG] hideTargetDropdown called');
            targetDropdown.classList.remove('visible');
        }

        function updateTargetDropdownList() {
            console.log('[DEBUG] updateTargetDropdownList called, allPeers:', allPeers);
            if (allPeers.length === 0) {
                targetDropdown.innerHTML = \`
                    <div class="no-peers-hint">
                        暂无通信对象<br>
                        <button class="open-peers-btn" id="openPeersBtn">点击配置 peers.json</button>
                    </div>
                \`;
                const openPeersBtn = document.getElementById('openPeersBtn');
                if (openPeersBtn) {
                    openPeersBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'openPeersFile' });
                        hideTargetDropdown();
                    });
                }
                return;
            }

            const html = allPeers.map((peer, idx) => {
                const isSelected = peer.id === selectedPeer ? 'selected' : '';
                const status = peer.status === 'online' ? '🟢' : '⚪';
                const displayName = escapeHtml(peer.displayName);
                console.log('[DEBUG] rendering peer idx:', idx, 'peer.id:', peer.id, 'displayName:', displayName, 'selected:', isSelected);
                return \`<div class="target-dropdown-item \${isSelected}" data-peer-id="\${peer.id}">
                    <span class="target-dropdown-status">\${status}</span>
                    <span class="target-dropdown-name">\${displayName}</span>
                </div>\`;
            }).join('');
            
            console.log('[DEBUG] setting dropdown innerHTML:', html);
            targetDropdown.innerHTML = html;

            const items = targetDropdown.querySelectorAll('.target-dropdown-item');
            console.log('[DEBUG] found dropdown items:', items.length);
            
            items.forEach((item, index) => {
                const peerId = item.dataset.peerId;
                console.log('[DEBUG] adding click listener to item', index, 'peerId:', peerId);
                
                item.addEventListener('click', function(e) {
                    console.log('[DEBUG] dropdown item clicked!', e);
                    console.log('[DEBUG] clicked element:', e.currentTarget);
                    console.log('[DEBUG] clicked element dataset:', e.currentTarget.dataset);
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 e.currentTarget 而不是闭包中的 item
                    const clickedPeerId = e.currentTarget.dataset.peerId;
                    console.log('[DEBUG] peerId from dataset:', clickedPeerId);
                    const peer = allPeers.find(p => p.id === clickedPeerId);
                    console.log('[DEBUG] found peer:', peer);
                    
                    if (peer) {
                        dbg('选择发送目标: ' + clickedPeerId);
                        selectedPeer = clickedPeerId;
                        targetSelectorText.textContent = peer.displayName;
                        console.log('[DEBUG] targetSelectorText updated to:', targetSelectorText.textContent);
                        hideTargetDropdown();
                        // 通知后端已选择的目标
                        console.log('[DEBUG] posting selectPeer message');
                        vscode.postMessage({ type: 'selectPeer', peerId: clickedPeerId, peerName: peer.displayName });
                    } else {
                        console.log('[DEBUG] peer not found for id:', clickedPeerId);
                    }
                });
            });
        }

        document.getElementById('viewAllBtn').addEventListener('click', () => {
            showAllSessions();
        });

        function updateRecentList(recentSessions) {
            const recentList = document.getElementById('recentList');
            if (recentSessions.length === 0) {
                recentList.innerHTML = '<div style="color: var(--vscode-descriptionForeground); font-size: 12px; padding: 8px;">暂无对话记录</div>';
                return;
            }

            recentList.innerHTML = recentSessions.map(session => {
                // 状态点颜色
                let statusClass = 'pending';
                if (session.transferStatus === 'completed') {
                    statusClass = 'completed';
                } else if (session.transferStatus === 'transferring') {
                    statusClass = 'transferring';
                } else if (session.transferStatus === 'failed') {
                    statusClass = 'failed';
                }
                
                // 聊天对象名称
                const peerName = session.peerName || '未知';
                
                // 对话内容预览
                const lastMessage = session.messages[session.messages.length - 1];
                const contentPreview = lastMessage ? (lastMessage.content.substring(0, 50) || '文件传输') : '空对话';
                
                return \`
                    <div class="recent-item \${session.id === currentSessionId ? 'active' : ''}" data-session-id="\${session.id}">
                        <div class="status-dot \${statusClass}" title="状态: \${session.transferStatus || 'pending'}"></div>
                        <div class="recent-peer-name">\${escapeHtml(peerName)}</div>
                        <div class="recent-content-preview">\${escapeHtml(contentPreview)}</div>
                        <button class="delete-btn" data-delete-id="\${session.id}">✕</button>
                    </div>
                \`;
            }).join('');

            recentList.querySelectorAll('.recent-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (!e.target.classList.contains('delete-btn')) {
                        const sessionId = item.dataset.sessionId;
                        vscode.postMessage({ type: 'loadSession', sessionId });
                    }
                });
            });

            recentList.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const sessionId = btn.dataset.deleteId;
                    vscode.postMessage({ type: 'deleteSession', sessionId });
                });
            });
        }

        function updateMessages(session) {
            const messagesList = document.getElementById('messagesList');

            if (!session || session.messages.length === 0) {
                messagesList.innerHTML = '';
                return;
            }

            messagesList.innerHTML = session.messages.map(msg => \`
                <div class="message \${msg.type}">
                    <div class="message-content">\${escapeHtml(msg.content)}</div>
                    \${msg.attachment ? \`
                        <div class="message-attachment">
                            📎 \${escapeHtml(msg.attachment.name)}
                        </div>
                    \` : ''}
                </div>
            \`).join('');

            const chatContainer = document.getElementById('chatContainer');
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function updateTransferProgress(message) {
            // 可以在消息列表中显示进度
            console.log('Transfer progress:', message.progress, '%');
        }

        function showAllSessions() {
            const recentList = document.getElementById('recentList');
            if (allSessions.length === 0) {
                recentList.innerHTML = '<div style="color: var(--vscode-descriptionForeground); font-size: 12px; padding: 8px;">暂无对话记录</div>';
                return;
            }

            recentList.innerHTML = allSessions.sort((a, b) => b.lastUpdated - a.lastUpdated).map(session => {
                let statusClass = 'pending';
                if (session.transferStatus === 'completed') {
                    statusClass = 'completed';
                } else if (session.transferStatus === 'transferring') {
                    statusClass = 'transferring';
                } else if (session.transferStatus === 'failed') {
                    statusClass = 'failed';
                }
                
                const peerName = session.peerName || '未知';
                const lastMessage = session.messages[session.messages.length - 1];
                const contentPreview = lastMessage ? (lastMessage.content.substring(0, 50) || '文件传输') : '空对话';
                
                return \`
                    <div class="recent-item \${session.id === currentSessionId ? 'active' : ''}" data-session-id="\${session.id}">
                        <div class="status-dot \${statusClass}" title="状态: \${session.transferStatus || 'pending'}"></div>
                        <div class="recent-peer-name">\${escapeHtml(peerName)}</div>
                        <div class="recent-content-preview">\${escapeHtml(contentPreview)}</div>
                        <button class="delete-btn" data-delete-id="\${session.id}">✕</button>
                    </div>
                \`;
            }).join('');

            recentList.querySelectorAll('.recent-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (!e.target.classList.contains('delete-btn')) {
                        const sessionId = item.dataset.sessionId;
                        vscode.postMessage({ type: 'loadSession', sessionId });
                    }
                });
            });

            recentList.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const sessionId = btn.dataset.deleteId;
                    vscode.postMessage({ type: 'deleteSession', sessionId });
                });
            });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        vscode.postMessage({ type: 'getPeers' });
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
        if (this._view) {
            this._updateWebviewContent();
            this._updatePeersList();
        }
    }
}
