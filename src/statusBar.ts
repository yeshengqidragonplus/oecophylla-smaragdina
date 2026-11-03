import * as vscode from 'vscode';
import { networkService } from './core/networkService';

const RUNNING_CONTEXT = 'oschat.running';

/**
 * 网络状态的可见入口：
 * - 状态栏项：运行中显示在线人数；启动失败、存在单向可达的对端时显示警告并指向诊断；
 * - 上下文键 oschat.running：让标题栏在"启动 / 停止"之间切换，而不是永远显示一个启动按钮。
 */
export function registerStatusUi(context: vscode.ExtensionContext): void {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);

    const update = (): void => {
        const status = networkService.getStatus();
        const peers = networkService.getPeers();
        const online = peers.filter(p => p.status === 'online').length;
        const oneway = peers.filter(p => p.status === 'oneway').length;
        const running = status.state === 'running' || status.state === 'starting';
        void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT, running);

        item.backgroundColor = undefined;
        item.command = 'workbench.view.extension.OSChatContainer';
        switch (status.state) {
            case 'running':
                item.text = oneway > 0 ? `$(broadcast) OS Chat ${online} $(warning)` : `$(broadcast) OS Chat ${online}`;
                item.tooltip = `运行中 · ${status.ip}:${status.port} · ${online} 人在线`
                    + (oneway > 0 ? `\n${oneway} 个对端单向可达（可能被防火墙拦截），点击运行诊断` : '');
                if (oneway > 0) {
                    item.command = 'myChat.diagnose';
                }
                break;
            case 'starting':
                item.text = '$(sync~spin) OS Chat';
                item.tooltip = '正在启动网络服务…';
                break;
            case 'error':
                item.text = '$(warning) OS Chat';
                item.tooltip = `网络服务启动失败：${status.error ?? '未知原因'}\n点击运行诊断`;
                item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                item.command = 'myChat.diagnose';
                break;
            default:
                item.text = '$(circle-slash) OS Chat';
                item.tooltip = '网络服务未运行，点击打开侧边栏';
                break;
        }
        item.show();
    };

    networkService.on('statusChange', update);
    networkService.on('peersUpdate', update);
    context.subscriptions.push(item, new vscode.Disposable(() => {
        networkService.off('statusChange', update);
        networkService.off('peersUpdate', update);
    }));
    update();
}
