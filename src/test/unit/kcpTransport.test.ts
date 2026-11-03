import * as assert from 'assert';
import { KcpError, KcpTransport } from '../../core/kcpTransport';
import { BusinessMessage, NetworkService, TextMessage } from '../../core/networkService';
import { setConsoleEnabled } from '../../core/logger';

const LOCAL = '127.0.0.1';

type Internals = {
    _updateTimer: ReturnType<typeof setInterval> | null;
    _sessions: Map<string, unknown>;
    _convIndex: Map<number, unknown>;
    _socket: { close(): void } | null;
    _isRunning: boolean;
    _transport?: KcpTransport;
};

function randomBasePort(): number {
    return 30000 + Math.floor(Math.random() * 15000);
}

/** 模拟进程崩溃：不发 FIN、不清理对端状态，只是本端突然消失并释放端口 */
function crash(transport: KcpTransport): void {
    const t = transport as unknown as Internals;
    if (t._updateTimer) {
        clearInterval(t._updateTimer);
        t._updateTimer = null;
    }
    t._sessions.clear();
    t._convIndex.clear();
    t._socket?.close();
    t._socket = null;
    t._isRunning = false;
}

function nextData(transport: KcpTransport): Promise<{ from: string; text: string }> {
    return new Promise(resolve => {
        transport.once('data', (from: string, data: Buffer) => resolve({ from, text: data.toString() }));
    });
}

async function makeTransport(basePort: number, id: string): Promise<KcpTransport> {
    const transport = new KcpTransport(basePort);
    transport.setLocalId(id);
    await transport.start();
    return transport;
}

suite('KcpTransport：会话建立与收发', () => {
    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    test('建立会话并收发消息', async function () {
        this.timeout(10_000);
        const base = randomBasePort();
        const a = await makeTransport(base, 'peer-a');
        const b = await makeTransport(base + 2000, 'peer-b');
        try {
            await a.connect('peer-b', LOCAL, b.port);
            const received = nextData(b);
            await a.send('peer-b', Buffer.from('hello'));
            assert.deepStrictEqual(await received, { from: 'peer-a', text: 'hello' });
        } finally {
            a.stop();
            b.stop();
        }
    });

    test('同一对端的并发 connect 共用一次握手，只产生一个会话', async function () {
        this.timeout(10_000);
        const base = randomBasePort();
        const a = await makeTransport(base, 'peer-a');
        const b = await makeTransport(base + 2000, 'peer-b');
        try {
            const first = a.connect('peer-b', LOCAL, b.port);
            const second = a.connect('peer-b', LOCAL, b.port);
            assert.strictEqual(first, second);
            await Promise.all([first, second, a.connect('peer-b', LOCAL, b.port)]);
            assert.strictEqual(a.connectionCount, 1);
            assert.strictEqual(b.connectionCount, 1);
        } finally {
            a.stop();
            b.stop();
        }
    });

    test('双向同时建连：两端各只保留一个会话，且两个方向都能发送', async function () {
        this.timeout(10_000);
        const base = randomBasePort();
        const a = await makeTransport(base, 'peer-a');
        const b = await makeTransport(base + 2000, 'peer-b');
        try {
            await Promise.all([
                a.connect('peer-b', LOCAL, b.port),
                b.connect('peer-a', LOCAL, a.port)
            ]);
            // 等待仲裁尘埃落定
            await new Promise(resolve => setTimeout(resolve, 300));
            assert.strictEqual(a.connectionCount, 1);
            assert.strictEqual(b.connectionCount, 1);

            const atB = nextData(b);
            await a.send('peer-b', Buffer.from('a→b'));
            assert.strictEqual((await atB).text, 'a→b');

            const atA = nextData(a);
            await b.send('peer-a', Buffer.from('b→a'));
            assert.strictEqual((await atA).text, 'b→a');
        } finally {
            a.stop();
            b.stop();
        }
    });

    test('长度为 0 的保活帧不会作为业务消息上报', async function () {
        this.timeout(10_000);
        const base = randomBasePort();
        const a = await makeTransport(base, 'peer-a');
        const b = await makeTransport(base + 2000, 'peer-b');
        try {
            await a.connect('peer-b', LOCAL, b.port);
            const seen: string[] = [];
            b.on('data', (_from: string, data: Buffer) => seen.push(data.toString()));
            await a.send('peer-b', Buffer.alloc(0));
            await a.send('peer-b', Buffer.from('x'));
            assert.deepStrictEqual(seen, ['x']);
        } finally {
            a.stop();
            b.stop();
        }
    });
});

suite('KcpTransport：对端重启后的恢复（回归）', () => {
    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    test('发起方崩溃重启后重新握手，不会被旧会话挡住（旧实现同一发起方恒判旧会话胜出）', async function () {
        this.timeout(10_000);
        const base = randomBasePort();
        const b = await makeTransport(base + 2000, 'peer-b');
        const a = await makeTransport(base, 'peer-a');
        let a2: KcpTransport | undefined;
        try {
            await a.connect('peer-b', LOCAL, b.port);
            crash(a); // 没有 FIN，B 上留着 peer-a 发起的僵尸会话

            a2 = await makeTransport(base, 'peer-a');
            const started = Date.now();
            await a2.connect('peer-b', LOCAL, b.port);
            assert.ok(Date.now() - started < 2000, '握手应在 SYN 首次/重发内完成，而不是等到超时');

            const received = nextData(b);
            await a2.send('peer-b', Buffer.from('after restart'));
            assert.deepStrictEqual(await received, { from: 'peer-a', text: 'after restart' });
        } finally {
            a.stop();
            a2?.stop();
            b.stop();
        }
    });

    test('应答方崩溃重启后重新握手：已有会话由我方发起、且我方 id 较小时也不会被忽略（boot 标识变化）', async function () {
        this.timeout(10_000);
        const base = randomBasePort();
        const a = await makeTransport(base, 'peer-a');       // id 较小，旧实现下会无条件忽略对方的 SYN
        const b = await makeTransport(base + 2000, 'peer-b');
        let b2: KcpTransport | undefined;
        try {
            await a.connect('peer-b', LOCAL, b.port);
            crash(b);

            b2 = await makeTransport(base + 2000, 'peer-b');
            const started = Date.now();
            await b2.connect('peer-a', LOCAL, a.port);
            assert.ok(Date.now() - started < 2000);

            const received = nextData(a);
            await b2.send('peer-a', Buffer.from('b restarted'));
            assert.deepStrictEqual(await received, { from: 'peer-b', text: 'b restarted' });
        } finally {
            a.stop();
            b.stop();
            b2?.stop();
        }
    });

    test('对端重启后向僵尸会话发送：收到 RST 后立刻失败为 SESSION_CLOSED，而不是干等 5 秒确认超时', async function () {
        this.timeout(15_000);
        const base = randomBasePort();
        const a = await makeTransport(base, 'peer-a');
        const b = await makeTransport(base + 2000, 'peer-b');
        let b2: KcpTransport | undefined;
        try {
            await a.connect('peer-b', LOCAL, b.port);
            crash(b);
            b2 = await makeTransport(base + 2000, 'peer-b');

            const started = Date.now();
            await assert.rejects(
                () => a.send('peer-b', Buffer.from('to a dead session')),
                (err: unknown) => err instanceof KcpError && err.code === 'SESSION_CLOSED');
            assert.ok(Date.now() - started < 2500, `失败耗时 ${Date.now() - started}ms，应远小于 5000ms 的确认超时`);
        } finally {
            a.stop();
            b.stop();
            b2?.stop();
        }
    });

    test('已有会话胜出而忽略了对端的新 SYN 时，通过保活探测让对端重新握手成功', async function () {
        this.timeout(10_000);
        const base = randomBasePort();
        const a = await makeTransport(base, 'peer-a');
        const b = await makeTransport(base + 2000, 'peer-b');
        try {
            await a.connect('peer-b', LOCAL, b.port);
            // B 单边丢了会话（没重启、没发 FIN）
            const internals = b as unknown as Internals;
            internals._sessions.clear();
            internals._convIndex.clear();

            const started = Date.now();
            await b.connect('peer-a', LOCAL, a.port);
            assert.ok(Date.now() - started < 4000, `重新握手耗时 ${Date.now() - started}ms`);

            const received = nextData(a);
            await b.send('peer-a', Buffer.from('healed'));
            assert.strictEqual((await received).text, 'healed');
        } finally {
            a.stop();
            b.stop();
        }
    });
});

suite('NetworkService：会话失效时自动重建并重试', () => {
    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    test('对端重启后第一次发送无需用户重试，自动重建会话并送达', async function () {
        this.timeout(20_000);
        const portA = randomBasePort();
        const portB = portA + 2000;
        const a = new NetworkService();
        let b = new NetworkService();
        let b2: NetworkService | undefined;
        try {
            await a.start(portA);
            await b.start(portB);
            const idB = `${a.getLocalIp()}:${portB}`;
            const message = (text: string): TextMessage => ({
                type: 'message', from: 'x', to: idB, content: text, timestamp: Date.now()
            });

            const first = new Promise<string>(resolve => b.once('message', (m: BusinessMessage) => resolve(m.type === 'message' ? m.content : '')));
            await a.sendToPeer(idB, message('before restart'));
            assert.strictEqual(await first, 'before restart');

            // B 崩溃（A 上留下僵尸会话），随后在同一端口重启
            crash((b as unknown as Internals)._transport as KcpTransport);
            b.stop();
            b2 = new NetworkService();
            await b2.start(portB);

            const second = new Promise<string>(resolve => b2!.once('message', (m: BusinessMessage) => resolve(m.type === 'message' ? m.content : '')));
            const started = Date.now();
            await a.sendToPeer(idB, message('after restart'));
            assert.strictEqual(await second, 'after restart');
            assert.ok(Date.now() - started < 6000, `自动重试耗时 ${Date.now() - started}ms`);
        } finally {
            a.stop();
            b.stop();
            b2?.stop();
        }
    });
});
