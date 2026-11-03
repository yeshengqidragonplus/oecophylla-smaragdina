import * as assert from 'assert';
import { buildWebviewHtml } from '../../webviewHtml';

const assets = {
    cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
    scriptUri: 'https://x/dist/webview/main.js',
    styleUri: 'https://x/dist/webview/main.css',
    codiconUri: 'https://x/dist/webview/codicons/codicon.css',
    nonce: 'abc123',
    title: 'OS Chat'
};

suite('webviewHtml：新界面外壳', () => {
    test('CSP：默认全部禁止；脚本只允许带 nonce 的；样式与字体只允许扩展自己的资源；不允许内联样式与 eval', () => {
        const html = buildWebviewHtml(assets);
        const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
        assert.ok(csp.includes("default-src 'none'"));
        assert.ok(csp.includes("script-src 'nonce-abc123'"));
        assert.ok(csp.includes(`style-src ${assets.cspSource}`));
        assert.ok(csp.includes(`font-src ${assets.cspSource}`));
        assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
    });

    test('只有一个带 nonce 的外链脚本，没有内联脚本；引用样式、codicon 与挂载点', () => {
        const html = buildWebviewHtml(assets);
        const scripts = html.match(/<script[^>]*>/g) ?? [];
        assert.strictEqual(scripts.length, 1);
        assert.ok(scripts[0].includes('nonce="abc123"') && scripts[0].includes('src="https://x/dist/webview/main.js"'));
        assert.ok(/<script[^>]*><\/script>/.test(html), '脚本标签内不应有内联代码');
        assert.ok(html.includes('href="https://x/dist/webview/main.css"'));
        assert.ok(html.includes('href="https://x/dist/webview/codicons/codicon.css"'));
        assert.ok(html.includes('<div id="root"></div>'));
    });

    test('资源地址与标题中的特殊字符被转义，不能借此注入属性', () => {
        const html = buildWebviewHtml({ ...assets, scriptUri: 'https://x/a"onload="alert(1)', title: '<b>t</b>' });
        assert.ok(!html.includes('"onload="alert'));
        assert.ok(html.includes('&quot;onload=&quot;alert(1)'));
        assert.ok(html.includes('&lt;b>t&lt;/b>') || html.includes('&lt;b&gt;'));
    });
});
