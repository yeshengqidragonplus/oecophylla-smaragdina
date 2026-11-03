import * as vscode from 'vscode';
import { getBuildHash } from './core/buildInfo';

/**
 * 旧版侧边栏界面的 HTML / CSS / 脚本（原样从 chatViewProvider.ts 搬出）。
 *
 * 这是内联在模板字符串里的前端，无法 lint、无类型检查。按改造计划，
 * M3 会用独立打包的 webview（TypeScript + 外置 CSS）整体替换它，届时删除本文件。
 * 在那之前只做必要的修补，不再往里加功能。
 */
export function getLegacyChatHtml(webview: vscode.Webview, nonce: string): string {
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

        .build-badge {
            margin-left: auto;
            margin-right: 8px;
            font-size: 10px;
            font-weight: normal;
            font-family: var(--vscode-editor-font-family, monospace);
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
            user-select: all;
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
            white-space: pre-wrap;
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
            <span class="build-badge" title="构建指纹（MD5 前 8 位）：两端一致即为同一个构建">构建 ${getBuildHash()}</span>
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
                isNetworkRunning = message.running;
                if (isNetworkRunning) {
                    if (networkBtn) {
                        networkBtn.setAttribute('data-state', 'running');
                        networkBtn.title = '暂停监听';
                        const btnIcon = networkBtn.querySelector('.btn-icon');
                        if (btnIcon) { btnIcon.textContent = '⏸️'; }
                    }
                } else {
                    if (networkBtn) {
                        networkBtn.setAttribute('data-state', 'stopped');
                        networkBtn.title = '启动监听';
                        const btnIcon = networkBtn.querySelector('.btn-icon');
                        if (btnIcon) { btnIcon.textContent = '▶️'; }
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
                const btnIcon = networkBtn.querySelector('.btn-icon');
                if (isNetworkRunning) {
                    // 停止监听
                    vscode.postMessage({ type: 'stopNetwork' });
                    networkBtn.setAttribute('data-state', 'stopped');
                    networkBtn.title = '启动监听';
                    if (btnIcon) { btnIcon.textContent = '▶️'; }
                    isNetworkRunning = false;
                } else {
                    // 启动监听
                    vscode.postMessage({ type: 'startNetwork' });
                    networkBtn.setAttribute('data-state', 'running');
                    networkBtn.title = '暂停监听';
                    if (btnIcon) { btnIcon.textContent = '⏸️'; }
                    isNetworkRunning = true;
                }
            });
        } else {
        }

        // 输入法组合期间（如中文拼音选词）按 Enter 是确认候选字，不能当作发送。
        // Chromium 里该 keydown 的 isComposing 为 true、keyCode 为 229；
        // 部分输入法在 compositionend 之后才触发确认用的 keydown，所以再用标志位兜底一拍
        let imeComposing = false;
        messageInput.addEventListener('compositionstart', function() { imeComposing = true; });
        messageInput.addEventListener('compositionend', function() {
            setTimeout(function() { imeComposing = false; }, 0);
        });
        messageInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                if (e.isComposing || imeComposing || e.keyCode === 229) {
                    return;
                }
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


        targetSelector.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
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
            if (targetDropdown.classList.contains('visible')) {
                hideTargetDropdown();
            } else {
                showTargetDropdown();
            }
        }

        function showTargetDropdown() {
            updateTargetDropdownList();
            targetDropdown.classList.add('visible');
        }

        function hideTargetDropdown() {
            targetDropdown.classList.remove('visible');
        }

        function updateTargetDropdownList() {
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
                const status = peer.status === 'online' ? '🟢' : peer.status === 'oneway' ? '🟡' : '⚪';
                const displayName = escapeHtml(peer.displayName);
                return \`<div class="target-dropdown-item \${isSelected}" data-peer-id="\${peer.id}">
                    <span class="target-dropdown-status">\${status}</span>
                    <span class="target-dropdown-name">\${displayName}</span>
                </div>\`;
            }).join('');
            
            targetDropdown.innerHTML = html;

            const items = targetDropdown.querySelectorAll('.target-dropdown-item');
            
            items.forEach((item, index) => {
                const peerId = item.dataset.peerId;
                
                item.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    // 使用 e.currentTarget 而不是闭包中的 item
                    const clickedPeerId = e.currentTarget.dataset.peerId;
                    const peer = allPeers.find(p => p.id === clickedPeerId);
                    
                    if (peer) {
                        dbg('选择发送目标: ' + clickedPeerId);
                        selectedPeer = clickedPeerId;
                        targetSelectorText.textContent = peer.displayName;
                        hideTargetDropdown();
                        // 通知后端已选择的目标
                        vscode.postMessage({ type: 'selectPeer', peerId: clickedPeerId, peerName: peer.displayName });
                    } else {
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
