/**
 * 新界面的 HTML 外壳（不依赖 vscode，便于单测）。
 *
 * 前端代码在独立打包的 dist/webview/main.js 里，这里只生成加载它的最小 HTML：
 * 脚本带 nonce、没有任何内联脚本；样式、字体只允许来自扩展自己的资源，不允许内联样式。
 */
export interface WebviewAssets {
    /** webview.cspSource */
    cspSource: string;
    scriptUri: string;
    styleUri: string;
    codiconUri: string;
    nonce: string;
    title: string;
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function buildWebviewHtml(assets: WebviewAssets): string {
    const csp = [
        "default-src 'none'",
        `style-src ${assets.cspSource}`,
        `font-src ${assets.cspSource}`,
        `img-src ${assets.cspSource} data:`,
        `script-src 'nonce-${assets.nonce}'`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link href="${escapeAttribute(assets.codiconUri)}" rel="stylesheet">
    <link href="${escapeAttribute(assets.styleUri)}" rel="stylesheet">
    <title>${escapeAttribute(assets.title)}</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${assets.nonce}" src="${escapeAttribute(assets.scriptUri)}"></script>
</body>
</html>`;
}
