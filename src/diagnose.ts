import * as os from 'os';
import * as vscode from 'vscode';
import { getBuildHash } from './core/buildInfo';
import { buildDiagnosticReport } from './core/diagnostics';
import { listExcludedInterfaces, listLanInterfaces } from './core/netInterfaces';
import { networkService } from './core/networkService';

/** 汇总当前状态生成诊断报告，在新的 Markdown 文档中打开，并提供一键复制 */
export async function showDiagnostics(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('oschat');
    const status = networkService.getStatus();

    const report = buildDiagnosticReport({
        now: Date.now(),
        env: {
            platform: process.platform,
            arch: process.arch,
            osRelease: os.release(),
            node: process.versions.node,
            vscode: vscode.version,
            version: context.extension.packageJSON.version as string,
            build: getBuildHash()
        },
        status,
        settings: {
            // 运行中以实际使用的端口为准，其次才是设置里的值
            port: status.state === 'running' ? status.port : config.get<number>('port', 8080),
            nickname: config.get<string>('nickname', ''),
            autoConnect: config.get<boolean>('autoConnect', true)
        },
        interfaces: listLanInterfaces(),
        excluded: listExcludedInterfaces(),
        peers: networkService.registry.list(),
        lastError: networkService.getLastNetError(),
        errorCounts: networkService.getNetErrorCounts()
    });

    const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });

    const copy = '复制报告';
    void vscode.window.showInformationMessage('诊断报告已生成，可复制后发给对方一起排查。', copy).then(pick => {
        if (pick === copy) {
            void vscode.env.clipboard.writeText(report);
        }
    });
}

/** 手动扫描网段：确认后向本机所在网段的每个地址发一个 UDP 探测包 */
export async function scanSubnet(): Promise<void> {
    if (!networkService.isRunning()) {
        void vscode.window.showWarningMessage('网络服务没有运行，请先启动网络服务再扫描网段。');
        return;
    }
    const port = networkService.getStatus().port;
    const go = '开始扫描';
    const pick = await vscode.window.showInformationMessage(
        `将向本机所在网段的每个 IP 发送一个 UDP 探测包（目标端口 ${port}），用于广播被过滤的网络。仅限你自己的内网使用，企业网络可能记录此类探测。继续吗？`,
        { modal: true },
        go);
    if (pick !== go) {
        return;
    }

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'OS Chat：正在扫描网段…' },
            () => networkService.scanSubnets());
        const skipped = result.skipped.length > 0 ? `；已跳过：${result.skipped.join('、')}` : '';
        void vscode.window.showInformationMessage(
            `已向 ${result.scanned} 个地址发出探测。对方应答后会出现在联系人里${skipped}`);
    } catch (error) {
        void vscode.window.showErrorMessage(`扫描网段失败：${error instanceof Error ? error.message : String(error)}`);
    }
}
