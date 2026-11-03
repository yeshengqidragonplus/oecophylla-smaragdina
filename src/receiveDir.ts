import * as path from 'path';
import * as vscode from 'vscode';
import { defaultDownloadDir, resolveDownloadDir } from './core/downloadDir';

const warned = new Set<string>();

/**
 * 接收文件的保存目录（每次新传输开始时解析，设置变化立即生效）。
 * 顺序：用户配置的 oschat.downloadPath → 系统"下载"文件夹下的 OS Chat → 扩展全局存储下的 downloads → 临时目录。
 * 用户配置的目录不可用时回退并提示一次原因（如外接卷未挂载），而不是让接收失败。
 */
export function resolveReceiveDir(context: vscode.ExtensionContext): string {
    const configured = vscode.workspace.getConfiguration('oschat').get<string>('downloadPath', '');
    const result = resolveDownloadDir({
        configured,
        defaultDir: defaultDownloadDir(),
        fallbackDirs: [path.join(context.globalStorageUri.fsPath, 'downloads')]
    });
    if (result.fallbackReason && configured.trim() && !warned.has(result.fallbackReason)) {
        warned.add(result.fallbackReason);
        void vscode.window.showWarningMessage(
            `OS Chat：接收文件的目录不可用（${result.fallbackReason}），本次改存到 ${result.dir}。`);
    }
    return result.dir;
}
