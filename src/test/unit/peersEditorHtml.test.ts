import * as assert from 'assert';
import * as vm from 'vm';
import { buildPeersEditorHtml, EditorPeer } from '../../peersEditorHtml';

type Listener = (event: unknown) => void;

/** 最小 DOM：只实现页面脚本用到的那一小部分，用来真正点一遍按钮 */
class FakeNode {
    className = '';
    type = '';
    value = '';
    dataset: Record<string, string> = {};
    children: FakeNode[] = [];
    parent?: FakeNode;
    classes = new Set<string>();
    classList = {
        add: (name: string) => { this.classes.add(name); },
        remove: (name: string) => { this.classes.delete(name); }
    };
    private _text = '';
    private _listeners = new Map<string, Listener[]>();

    constructor(public tag: string) { }

    get textContent(): string {
        return this._text + this.children.map(c => c.textContent).join('');
    }
    set textContent(value: string) {
        this._text = value;
        this.children = [];
    }

    appendChild(child: FakeNode): FakeNode {
        child.parent = this;
        this.children.push(child);
        return child;
    }

    addEventListener(type: string, listener: Listener): void {
        this._listeners.set(type, [...(this._listeners.get(type) ?? []), listener]);
    }

    emit(type: string, event: unknown): void {
        for (const listener of this._listeners.get(type) ?? []) {
            listener(event);
        }
    }

    /** 只支持页面里用到的 button[data-action] */
    closest(selector: string): FakeNode | null {
        assert.strictEqual(selector, 'button[data-action]');
        for (let node: FakeNode | undefined = this; node; node = node.parent) {
            if (node.tag === 'button' && node.dataset.action !== undefined) {
                return node;
            }
        }
        return null;
    }

    descendants(): FakeNode[] {
        return this.children.flatMap(c => [c, ...c.descendants()]);
    }
}

const peer = (over: Partial<EditorPeer> = {}): EditorPeer => ({
    id: 'iid-1', hostname: 'PC-A', nickname: 'Arthur', ip: '10.0.0.2', port: 6688,
    lastSeen: Date.now(), status: 'offline', ...over
});

const IDS = ['content', 'modalOverlay', 'modalTitle', 'peerId', 'hostname', 'nickname', 'ip', 'port',
    'peerForm', 'addBtn', 'refreshBtn', 'cancelBtn', 'peers-data'];

function boot(peers: EditorPeer[]) {
    const html = buildPeersEditorHtml({ cspSource: 'vscode-resource:', nonce: 'n1', peers });
    const script = /<script nonce="n1">([\s\S]*)<\/script>/.exec(html)![1];
    const data = /<script type="application\/json" id="peers-data">([\s\S]*?)<\/script>/.exec(html)![1];

    const nodes = new Map(IDS.map(id => [id, new FakeNode('div')]));
    nodes.get('peers-data')!.textContent = data;
    const posted: Array<Record<string, unknown>> = [];
    const windowListeners: Listener[] = [];

    // 沙箱里没有 confirm / alert / prompt：页面脚本一旦调用就会 ReferenceError，和 webview 的沙箱一样不可用
    vm.runInNewContext(script, {
        document: {
            getElementById: (id: string) => nodes.get(id),
            createElement: (tag: string) => new FakeNode(tag),
            createTextNode: (text: string) => {
                const node = new FakeNode('#text');
                node.textContent = text;
                return node;
            }
        },
        window: { addEventListener: (_type: string, l: Listener) => windowListeners.push(l) },
        Element: FakeNode,
        // 沙箱里创建的对象原型不同，转成普通对象后才能与本侧的期望值做严格比较
        acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) })
    });

    const node = (id: string) => nodes.get(id)!;
    const rows = () => node('content').descendants().filter(n => n.tag === 'tr' && n.parent?.tag === 'tbody');
    const button = (rowIndex: number, action: string) => {
        const found = rows()[rowIndex].descendants().find(n => n.dataset.action === action);
        assert.ok(found, `第 ${rowIndex} 行没有 ${action} 按钮`);
        return found;
    };
    const click = (b: FakeNode) => node('content').emit('click', { target: b });
    return { html, script, data, node, posted, rows, button, click, windowListeners };
}

suite('peersEditorHtml：编辑聊天对象面板', () => {
    test('CSP 只放行带 nonce 的脚本；页面没有内联事件属性，也不用 confirm / alert / prompt', () => {
        const { html, script } = boot([peer()]);
        const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
        assert.ok(csp.includes("script-src 'nonce-n1'"));
        assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
        // 内联 onclick 等会被 CSP 拦掉，按钮就成了摆设（这个面板曾经因此删不掉也改不了联系人）
        assert.ok(!/\son[a-z]+\s*=/i.test(html), '不应出现 onclick= 之类的内联事件属性');
        assert.ok(!/\b(confirm|alert|prompt)\s*\(/.test(script), 'webview 沙箱里这些调用会被忽略');
    });

    test('数据块：主机名里的 </script> 不会提前结束数据块，数据可原样还原', () => {
        const evil = peer({ hostname: '</script><img src=x onerror=alert(1)>', nickname: '"><b>' });
        const { html, data } = boot([evil]);
        assert.ok(!html.includes('</script><img'));
        assert.deepStrictEqual(JSON.parse(data), [evil]);
    });

    test('每个对端一行；主机名等按文本显示，不会被当成 HTML', () => {
        const { rows, node } = boot([
            peer({ id: 'a', hostname: '<img src=x onerror=alert(1)>', status: 'online' }),
            peer({ id: 'b', nickname: undefined, status: 'oneway' }),
            peer({ id: 'c', status: 'offline' })
        ]);
        assert.strictEqual(rows().length, 3);
        assert.ok(rows()[0].textContent.includes('<img src=x onerror=alert(1)>'));
        assert.ok(!node('content').descendants().some(n => n.tag === 'img'));
        assert.ok(rows()[0].textContent.includes('在线'));
        assert.ok(rows()[1].textContent.includes('单向'));
        assert.ok(rows()[2].textContent.includes('离线'));
        assert.ok(rows()[1].textContent.includes('-'), '没有昵称显示短横线');
    });

    test('点"删除"发出 deletePeer 请求（带该行的 id），确认由扩展负责', () => {
        const { button, click, posted } = boot([peer({ id: 'a' }), peer({ id: 'iid:with:colon' })]);
        click(button(1, 'delete'));
        assert.deepStrictEqual(posted, [{ type: 'deletePeer', id: 'iid:with:colon' }]);
    });

    test('点"编辑"打开表单并带出该对端；保存发 updatePeer（带 id），新增发 addPeer', () => {
        const { button, click, node, posted } = boot([peer({ id: 'a', hostname: 'PC-A', nickname: 'Arthur', ip: '10.0.0.2', port: 6688 })]);
        click(button(0, 'edit'));
        assert.ok(node('modalOverlay').classes.has('visible'));
        assert.strictEqual(node('peerId').value, 'a');
        assert.strictEqual(node('hostname').value, 'PC-A');
        assert.strictEqual(node('nickname').value, 'Arthur');
        assert.strictEqual(node('ip').value, '10.0.0.2');
        assert.strictEqual(String(node('port').value), '6688');

        node('port').value = '7000';
        node('peerForm').emit('submit', { preventDefault: () => undefined });
        assert.deepStrictEqual(posted.pop(), {
            type: 'updatePeer',
            peer: { hostname: 'PC-A', nickname: 'Arthur', ip: '10.0.0.2', port: 7000, id: 'a' }
        });
        assert.ok(!node('modalOverlay').classes.has('visible'), '保存后关闭表单');

        node('addBtn').emit('click', {});
        assert.strictEqual(node('peerId').value, '');
        node('hostname').value = 'PC-B';
        node('nickname').value = '';
        node('ip').value = '10.0.0.3';
        node('port').value = '8080';
        node('peerForm').emit('submit', { preventDefault: () => undefined });
        assert.deepStrictEqual(posted.pop(), {
            type: 'addPeer',
            peer: { hostname: 'PC-B', ip: '10.0.0.3', port: 8080 }
        });
    });

    test('收到 update 消息重绘表格；没有对端时显示提示', () => {
        const { rows, node, windowListeners } = boot([peer({ id: 'a' })]);
        assert.strictEqual(rows().length, 1);
        windowListeners.forEach(l => l({ data: { type: 'update', peers: [peer({ id: 'x' }), peer({ id: 'y' })] } }));
        assert.strictEqual(rows().length, 2);
        windowListeners.forEach(l => l({ data: { type: 'update', peers: [] } }));
        assert.strictEqual(rows().length, 0);
        assert.ok(node('content').textContent.includes('暂无聊天对象'));
    });
});
