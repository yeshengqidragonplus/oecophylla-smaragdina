import * as vscode from 'vscode';
import * as path from 'path';
import { PeersManager } from './peersManager';
import { PeersEditor } from './peersEditor';

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    public static readonly viewType = 'OSChatSettings';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _peersManager: PeersManager;

    public static createOrShow(extensionUri: vscode.Uri, peersManager: PeersManager): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 如果面板已存在，则显示它
        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(column);
            return;
        }

        // 创建新面板
        const panel = vscode.window.createWebviewPanel(
            SettingsPanel.viewType,
            'OS Chat 设置',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, peersManager);
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
                    case 'saveSettings':
                        await this._saveSettings(message.settings);
                        break;
                    case 'selectFolder':
                        await this._selectFolder(message.settingId);
                        break;
                    case 'openPeersEditor':
                        PeersEditor.createOrShow(this._extensionUri, this._peersManager);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private async _selectFolder(settingId: string): Promise<void> {
        const folderUris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            title: '选择文件夹'
        });

        if (folderUris && folderUris.length > 0) {
            this._panel.webview.postMessage({
                type: 'folderSelected',
                settingId: settingId,
                folderPath: folderUris[0].fsPath
            });
        }
    }

    private async _saveSettings(settings: {
        port: number;
        autoConnect: boolean;
        nickname: string;
        peersFilePath: string;
        downloadPath: string;
        theme: string
    }): Promise<void> {
        const config = vscode.workspace.getConfiguration('oschat');
        await config.update('port', settings.port, vscode.ConfigurationTarget.Global);
        await config.update('autoConnect', settings.autoConnect, vscode.ConfigurationTarget.Global);
        await config.update('nickname', settings.nickname, vscode.ConfigurationTarget.Global);
        await config.update('peersFilePath', settings.peersFilePath, vscode.ConfigurationTarget.Global);
        await config.update('downloadPath', settings.downloadPath, vscode.ConfigurationTarget.Global);
        await config.update('theme', settings.theme, vscode.ConfigurationTarget.Global);
        
        vscode.window.showInformationMessage('设置已保存');
    }

    public dispose(): void {
        SettingsPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private _update(): void {
        const config = vscode.workspace.getConfiguration('oschat');
        const port = config.get('port', 8080);
        const autoConnect = config.get('autoConnect', false);
        const nickname = config.get('nickname', '');
        const peersFilePathConfig = config.get<string>('peersFilePath', '');
        const downloadPath = config.get('downloadPath', '');
        const theme = config.get('theme', 'default');
        
        // 计算实际的 peers.json 路径
        let peersFilePath: string;
        if (peersFilePathConfig) {
            peersFilePath = path.join(peersFilePathConfig, 'peers.json');
        } else {
            // 默认使用当前工作目录
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                peersFilePath = path.join(workspaceFolders[0].uri.fsPath, 'peers.json');
            } else {
                peersFilePath = path.join(process.cwd(), 'peers.json');
            }
        }

        this._panel.webview.html = this._getHtmlForWebview(
            port,
            autoConnect,
            nickname,
            peersFilePath,
            downloadPath,
            theme
        );
    }

    private _getHtmlForWebview(
        port: number,
        autoConnect: boolean,
        nickname: string,
        peersFilePath: string,
        downloadPath: string,
        theme: string
    ): string {
        const nonce = this._getNonce();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>OS Chat 设置</title>
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
        
        h2 {
            font-size: 16px;
            margin: 20px 0 12px;
        }
        
        .setting-group {
            margin-bottom: 20px;
        }
        
        .setting-item {
            margin-bottom: 16px;
        }
        
        .setting-label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
        }
        
        .setting-input {
            width: 100%;
            max-width: 400px;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: inherit;
        }
        
        .setting-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        .setting-description {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .checkbox-wrapper {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .checkbox-wrapper input[type="checkbox"] {
            width: 16px;
            height: 16px;
        }
        
        .select-wrapper {
            display: flex;
            align-items: center;
        }
        
        .select-wrapper select {
            width: 200px;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: inherit;
        }
        
        .path-input-wrapper {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        
        .path-input-wrapper .setting-input {
            flex: 1;
            max-width: none;
        }
        
        .browse-btn {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            white-space: nowrap;
        }
        
        .browse-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .save-btn {
            padding: 10px 24px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            margin-top: 20px;
        }
        
        .save-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .section-icon {
            margin-right: 8px;
        }
        
        .port-input {
            width: 120px !important;
        }
    </style>
</head>
<body>
    <h1>⚙️ OS Chat 设置</h1>
    
    <div class="setting-group">
        <h2><span class="section-icon">🌐</span>网络配置</h2>
        
        <div class="setting-item">
            <label class="setting-label" for="port">监听端口</label>
            <input type="number" id="port" class="setting-input port-input" value="${port}" min="1" max="65535" placeholder="8080">
            <div class="setting-description">用于接收局域网内其他主机发送的广播消息的 UDP 端口</div>
        </div>
        
        <div class="setting-item">
            <div class="checkbox-wrapper">
                <input type="checkbox" id="autoConnect" ${autoConnect ? 'checked' : ''}>
                <label for="autoConnect">启动时自动启动网络服务</label>
            </div>
            <div class="setting-description">勾选后插件激活时会自动启动 UDP 监听服务</div>
        </div>
        
        <div class="setting-item">
            <label class="setting-label" for="nickname">我的昵称</label>
            <input type="text" id="nickname" class="setting-input" value="${nickname}" placeholder="可选，留空则使用主机名">
            <div class="setting-description">在局域网内显示的名称，留空则使用计算机名</div>
        </div>
    </div>
    
    <div class="setting-group">
        <h2><span class="section-icon">📁</span>数据存储</h2>
        
        <div class="setting-item">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <label class="setting-label" for="peersFilePath" style="margin-bottom: 0;">聊天对象管理</label>
                <button class="browse-btn" id="editPeersBtn" style="padding: 6px 12px; font-size: 12px;">✏️ 编辑聊天对象</button>
            </div>
            <label class="setting-label" for="peersFilePath">聊天对象 JSON 保存位置</label>
            <div class="path-input-wrapper">
                <input type="text" id="peersFilePath" class="setting-input" value="${peersFilePath}" placeholder="留空则使用默认存储位置">
                <button class="browse-btn" id="selectPeersPathBtn">选择文件夹</button>
            </div>
            <div class="setting-description">存储发现的聊天对象信息的 JSON 文件所在文件夹</div>
        </div>
        
        <div class="setting-item">
            <label class="setting-label" for="downloadPath">接收文件保存位置</label>
            <div class="path-input-wrapper">
                <input type="text" id="downloadPath" class="setting-input" value="${downloadPath}" placeholder="留空则使用默认下载位置">
                <button class="browse-btn" id="selectDownloadPathBtn">选择文件夹</button>
            </div>
            <div class="setting-description">接收他人发送的文件时保存的文件夹</div>
        </div>
    </div>
    
    <div class="setting-group">
        <h2><span class="section-icon">🎨</span>外观设置</h2>
        
        <div class="setting-item">
            <label class="setting-label" for="theme">主题</label>
            <div class="select-wrapper">
                <select id="theme">
                    <option value="default" ${theme === 'default' ? 'selected' : ''}>默认（跟随 VS Code）</option>
                    <option value="light" ${theme === 'light' ? 'selected' : ''}>浅色</option>
                    <option value="dark" ${theme === 'dark' ? 'selected' : ''}>深色</option>
                </select>
            </div>
        </div>
    </div>
    
    <button class="save-btn" id="saveBtn">保存设置</button>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        // 编辑聊天对象按钮
        document.getElementById('editPeersBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openPeersEditor' });
        });
        
        // 处理文件夹选择
        document.getElementById('selectPeersPathBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'selectFolder', settingId: 'peersFilePath' });
        });
        
        document.getElementById('selectDownloadPathBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'selectFolder', settingId: 'downloadPath' });
        });
        
        // 处理来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'folderSelected') {
                document.getElementById(message.settingId).value = message.folderPath;
            }
        });
        
        document.getElementById('saveBtn').addEventListener('click', () => {
            const settings = {
                port: parseInt(document.getElementById('port').value) || 8080,
                autoConnect: document.getElementById('autoConnect').checked,
                nickname: document.getElementById('nickname').value,
                peersFilePath: document.getElementById('peersFilePath').value,
                downloadPath: document.getElementById('downloadPath').value,
                theme: document.getElementById('theme').value
            };
            
            // 验证端口
            if (settings.port < 1 || settings.port > 65535) {
                alert('端口号必须在 1-65535 之间');
                return;
            }
            
            vscode.postMessage({
                type: 'saveSettings',
                settings: settings
            });
        });
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
}
