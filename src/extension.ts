import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { SettingsPanel } from './settingsPanel';
import { PeersManager } from './peersManager';
import { networkService } from './networkService';
import { PeersEditor } from './peersEditor';

let chatProvider: ChatViewProvider;
let peersManager: PeersManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "Oecophylla smaragdina" is now active!');

    // 初始化 PeersManager
    peersManager = new PeersManager(context);

    // 注册 Chat View Provider
    chatProvider = new ChatViewProvider(context.extensionUri, context, peersManager);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
    );

    // 注册打开设置的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.openSettings', () => {
            SettingsPanel.createOrShow(context.extensionUri, peersManager);
        })
    );

    // 注册新建会话的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.newChat', () => {
            if (chatProvider) {
                chatProvider.refresh();
            }
        })
    );

    // 监听网络服务的 peer 更新事件
    networkService.on('peersUpdate', (peers: import('./networkService').PeerInfo[]) => {
        peers.forEach((peer: import('./networkService').PeerInfo) => {
            peersManager.updatePeer({
                id: peer.id,
                hostname: peer.hostname,
                nickname: peer.nickname,
                ip: peer.ip,
                port: peer.port,
                lastSeen: peer.lastSeen,
                status: peer.status
            });
        });
        chatProvider.refresh();
    });

    // 启动网络服务
    const config = vscode.workspace.getConfiguration('oschat');
    const port = config.get('port', 8080);
    const nickname = config.get('nickname', '');
    const autoConnect = config.get('autoConnect', false);
    const peersFilePath = peersManager.getPeersFilePath();

    if (autoConnect) {
        startNetworkService(port, nickname, peersFilePath);
    }

    // 注册启动网络服务的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.startNetwork', async () => {
            const portInput = await vscode.window.showInputBox({
                prompt: '请输入监听端口',
                value: String(port),
                validateInput: (value) => {
                    const num = parseInt(value);
                    if (isNaN(num) || num < 1 || num > 65535) {
                        return '请输入有效的端口号码 (1-65535)';
                    }
                    return null;
                }
            });
            
            if (portInput) {
                const nicknameInput = await vscode.window.showInputBox({
                    prompt: '请输入你的昵称（可选）',
                    value: nickname
                });
                
                await startNetworkService(parseInt(portInput), nicknameInput || '', peersFilePath);
            }
        })
    );

    // 注册停止网络服务的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.stopNetwork', () => {
            networkService.stop();
            vscode.window.showInformationMessage('网络服务已停止');
        })
    );

    // 注册编辑聊天对象的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.editPeers', () => {
            PeersEditor.createOrShow(context.extensionUri, peersManager);
        })
    );

    // 注册打开 peers.json 文件的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.openPeersFile', () => {
            const peersFilePath = peersManager.getPeersFilePath();
            if (peersFilePath) {
                vscode.window.showTextDocument(vscode.Uri.file(peersFilePath));
            } else {
                vscode.window.showErrorMessage('无法找到 peers.json 文件路径');
            }
        })
    );

    // 监听配置更改
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('oschat.peersFilePath')) {
                peersManager.refreshFilePath();
                chatProvider.refresh();
            }
        })
    );

    console.log(`OS Chat 已激活`);
}

async function startNetworkService(port: number, nickname: string, peersFilePath: string): Promise<void> {
    try {
        await networkService.start(port, nickname, peersFilePath);
        vscode.window.showInformationMessage(`网络服务已启动，监听端口 ${port}`);
        
        // 保存配置
        const config = vscode.workspace.getConfiguration('oschat');
        await config.update('port', port, vscode.ConfigurationTarget.Global);
        await config.update('nickname', nickname, vscode.ConfigurationTarget.Global);
    } catch (error) {
        vscode.window.showErrorMessage(`启动网络服务失败: ${error}`);
    }
}

export function deactivate() {
    networkService.stop();
    if (peersManager) {
        peersManager.flush();
    }
    console.log('OS Chat 已停用');
}
