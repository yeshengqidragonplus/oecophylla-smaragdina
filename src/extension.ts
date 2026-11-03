import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { SettingsPanel } from './settingsPanel';
import { PeersManager } from './peersManager';
import { networkService } from './core/networkService';
import { PeersEditor } from './peersEditor';
import { initNetworkIdentity, startNetworkFromConfig, stopNetwork } from './networkLauncher';
import { scanSubnet, showDiagnostics } from './diagnose';
import { registerStatusUi } from './statusBar';
import { setLogSink, log } from './core/logger';
import { getBuildHash } from './core/buildInfo';

let chatProvider: ChatViewProvider;
let peersManager: PeersManager;

export function activate(context: vscode.ExtensionContext) {
    // 日志通道：网络层与发送链路日志统一汇集于此，便于排查
    const logChannel = vscode.window.createOutputChannel('OSChat 日志');
    context.subscriptions.push(logChannel);
    setLogSink(logChannel);
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.showLogs', () => {
            logChannel.show(true);
        })
    );
    log(`OSChat 激活，插件版本 ${context.extension.packageJSON.version}，构建 ${getBuildHash()}，传输层 UDP+KCP`);

    // 本机稳定标识与版本信息（随发现与握手发出）
    initNetworkIdentity(context);

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

    // 状态栏与标题栏的启动/停止切换（先于自动启动注册，才能收到启动状态）
    registerStatusUi(context);

    // 自动启动网络服务（读取最新配置，不阻塞激活）
    if (vscode.workspace.getConfiguration('oschat').get<boolean>('autoConnect', true)) {
        void startNetworkFromConfig(peersManager, false);
    }

    // 注册启动网络服务的命令：端口、昵称统一来自设置，运行中再次执行即重启
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.startNetwork', () => startNetworkFromConfig(peersManager))
    );

    // 注册停止网络服务的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.stopNetwork', () => stopNetwork())
    );

    // 诊断与手动扫描网段
    context.subscriptions.push(
        vscode.commands.registerCommand('myChat.diagnose', () => showDiagnostics(context)),
        vscode.commands.registerCommand('myChat.scanSubnet', () => scanSubnet())
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
    let restartPromptOpen = false;
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('oschat.peersFilePath')) {
                peersManager.refreshFilePath();
                chatProvider.refresh();
            }
            // 端口与昵称只在启动时读取：服务运行中被修改时提示重启（一次保存多项设置只提示一次）
            if ((e.affectsConfiguration('oschat.port') || e.affectsConfiguration('oschat.nickname'))
                && networkService.isRunning() && !restartPromptOpen) {
                restartPromptOpen = true;
                const restart = '立即重启';
                void vscode.window.showInformationMessage('OS Chat 的端口或昵称已更改，需要重启网络服务才能生效。', restart)
                    .then(pick => {
                        restartPromptOpen = false;
                        if (pick === restart) {
                            void startNetworkFromConfig(peersManager);
                        }
                    });
            }
        })
    );

    console.log(`OS Chat 已激活`);
}

export function deactivate() {
    networkService.stop();
    if (peersManager) {
        peersManager.flush();
    }
    console.log('OS Chat 已停用');
}
