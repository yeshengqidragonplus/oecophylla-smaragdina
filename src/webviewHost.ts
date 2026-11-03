import * as vscode from 'vscode';
import { buildWebviewHtml } from './webviewHtml';

/** 新界面（独立打包的 Preact 前端）可访问的资源根目录：只开放 dist，不开放源码与依赖 */
export function webviewResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
    return [vscode.Uri.joinPath(extensionUri, 'dist')];
}

/** 生成加载新界面的 HTML；M3 接入侧边栏时在 resolveWebviewView 里使用 */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
    const asset = (...segments: string[]): string =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', ...segments)).toString();
    return buildWebviewHtml({
        cspSource: webview.cspSource,
        scriptUri: asset('main.js'),
        styleUri: asset('main.css'),
        codiconUri: asset('codicons', 'codicon.css'),
        nonce,
        title: 'OS Chat'
    });
}
