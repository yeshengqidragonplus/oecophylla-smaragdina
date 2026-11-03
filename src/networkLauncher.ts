import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { StartOptions, networkService } from './core/networkService';
import { getBuildHash } from './core/buildInfo';
import { PeersManager } from './peersManager';
import { logError } from './core/logger';

const MACHINE_ID_KEY = 'oschat.machineId';
const MIN_PORT = 1024;
/** 业务端口 = 主端口 + 1000，必须不超过 65535 */
const MAX_PORT = 64535;

/** 随发现与握手携带的本机标识与版本信息，由 initNetworkIdentity 在激活时准备 */
let identity: StartOptions = {};

/**
 * 准备本机的稳定标识：首次运行生成并保存到全局状态，之后一直不变，
 * 对端据此识别"这还是同一台机器"，DHCP 换 IP 不会再被当成新联系人。
 */
export function initNetworkIdentity(context: vscode.ExtensionContext): void {
    let machineId = context.globalState.get<string>(MACHINE_ID_KEY);
    if (!machineId) {
        machineId = crypto.randomUUID();
        void context.globalState.update(MACHINE_ID_KEY, machineId);
    }
    identity = {
        machineId,
        meta: {
            version: context.extension.packageJSON.version as string,
            build: getBuildHash(),
            vscode: vscode.version
        }
    };
}

/**
 * 读取最新配置并启动（或重启）网络服务。
 * 命令面板、侧边栏按钮与自动启动共用这一个入口，保证行为一致，
 * 且不会把临时参数写回用户设置。
 *
 * @param interactive 是否由用户主动触发。自动启动（false）遇到端口被占用时只记日志、由状态栏提示，
 *   不弹错误：最常见的原因是同一台机器上另一个 VS Code 窗口已经启动了服务，每开一个窗口都弹一次是打扰
 * @returns 是否启动成功（主动触发时，失败原因已通过消息提示给用户）
 */
export async function startNetworkFromConfig(_peersManager?: PeersManager, interactive: boolean = true): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('oschat');
    const port = config.get<number>('port', 8080);
    const nickname = config.get<string>('nickname', '');

    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
        const message = `端口 ${port} 无效：请设置 ${MIN_PORT}-${MAX_PORT} 之间的整数（业务端口为主端口 + 1000）`;
        logError(message);
        offerOpenPortSetting(message);
        return false;
    }

    try {
        await networkService.start(port, nickname, identity);
        vscode.window.showInformationMessage(`网络服务已启动，监听端口 ${port}`);
        return true;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logError('启动网络服务失败:', detail);
        if (interactive || !detail.includes('EADDRINUSE')) {
            offerOpenPortSetting(`启动网络服务失败: ${detail}`);
        }
        return false;
    }
}

/** 停止网络服务 */
export function stopNetwork(): void {
    networkService.stop();
    vscode.window.showInformationMessage('网络服务已停止');
}

/** 弹出错误提示，并提供直达端口设置的入口（不阻塞调用方） */
function offerOpenPortSetting(message: string): void {
    const openSettings = '打开设置';
    void vscode.window.showErrorMessage(message, openSettings).then(pick => {
        if (pick === openSettings) {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'oschat.port');
        }
    });
}
