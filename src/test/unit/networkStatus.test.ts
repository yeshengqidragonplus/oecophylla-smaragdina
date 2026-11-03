import * as assert from 'assert';
import { NetworkService, NetworkStatus } from '../../core/networkService';
import { setConsoleEnabled } from '../../core/logger';

function randomBasePort(): number {
    return 30000 + Math.floor(Math.random() * 15000);
}

suite('NetworkService：运行状态与唤醒检测', () => {
    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    test('statusChange：starting → running → stopped', async () => {
        const service = new NetworkService();
        const states: string[] = [];
        service.on('statusChange', (status: NetworkStatus) => states.push(status.state));
        await service.start(randomBasePort());
        service.stop();
        const distinct = states.filter((s, i) => i === 0 || s !== states[i - 1]);
        assert.deepStrictEqual(distinct, ['starting', 'running', 'stopped']);
    });

    test('启动失败（端口被占用）：状态为 error 并带原因，抛出的错误与状态一致，且之后可正常停止', async () => {
        const port = randomBasePort();
        const first = new NetworkService();
        const second = new NetworkService();
        await first.start(port);
        try {
            const states: NetworkStatus[] = [];
            second.on('statusChange', (status: NetworkStatus) => states.push(status));
            await assert.rejects(() => second.start(port), /KCP 传输层启动失败/);
            const last = states[states.length - 1];
            assert.strictEqual(last.state, 'error');
            assert.ok(last.error && last.error.includes('EADDRINUSE'), `错误原因应包含 EADDRINUSE：${last.error}`);
            assert.strictEqual(second.getStatus().state, 'error');
            second.stop();
            assert.strictEqual(second.getStatus().state, 'stopped');
        } finally {
            first.stop();
        }
    });

    test('getStatus：运行中包含端口、实例 ID、boot 与可用网卡', async () => {
        const service = new NetworkService();
        const port = randomBasePort();
        await service.start(port);
        try {
            const status = service.getStatus();
            assert.strictEqual(status.state, 'running');
            assert.strictEqual(status.port, port);
            assert.ok(status.instanceId.endsWith(`:${port}`));
            assert.ok(status.boot.length > 0);
            assert.ok(Array.isArray(status.interfaces));
        } finally {
            service.stop();
        }
    });

    test('节拍间隔异常（睡眠唤醒）：重新发现、清空探测状态，并发出 networkResume', async () => {
        const service = new NetworkService();
        await service.start(randomBasePort());
        try {
            const reasons: string[] = [];
            service.on('networkResume', (reason: string) => reasons.push(reason));
            const internals = service as unknown as { _lastTickAt: number; _peerTick(): void; _probeState: Map<string, unknown> };
            internals._probeState.set('stale', {});
            internals._lastTickAt = Date.now() - 60_000;
            internals._peerTick();
            assert.strictEqual(reasons.length, 1);
            assert.ok(reasons[0].includes('挂起'));
            assert.ok(!internals._probeState.has('stale'), '探测状态应被清空，所有对端立即到期');
        } finally {
            service.stop();
        }
    });

    test('正常节拍不会误触发唤醒处理', async () => {
        const service = new NetworkService();
        await service.start(randomBasePort());
        try {
            const reasons: string[] = [];
            service.on('networkResume', (reason: string) => reasons.push(reason));
            (service as unknown as { _peerTick(): void })._peerTick();
            assert.deepStrictEqual(reasons, []);
        } finally {
            service.stop();
        }
    });
});

suite('NetworkService：手动扫描网段', () => {
    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    test('只在服务运行时可用', async () => {
        const service = new NetworkService();
        await assert.rejects(() => service.scanSubnets(), /未运行/);
    });

    test('向真实网卡所在网段的每个主机地址单播探测（目标端口为本机主端口），不含本机、网络地址与广播地址', async function () {
        const service = new NetworkService();
        const port = randomBasePort();
        await service.start(port);
        try {
            const real = service.getLanInterfaces().filter(i => !i.virtual && i.prefix >= 22);
            if (real.length === 0) {
                this.skip(); // 当前环境没有可扫描的真实局域网网卡
            }
            const sent: Array<{ ip: string; port: number }> = [];
            (service as unknown as { _udpSend(b: Buffer, p: number, ip: string, scope: string): void })._udpSend =
                (_buffer, targetPort, ip) => { sent.push({ ip, port: targetPort }); };

            const result = await service.scanSubnets();
            assert.ok(result.scanned > 0);
            assert.strictEqual(sent.length, result.scanned);
            assert.ok(sent.every(t => t.port === port));
            const own = real[0];
            assert.ok(!sent.some(t => t.ip === own.address), '不应探测本机地址');
            assert.ok(!sent.some(t => t.ip === own.broadcast), '不应探测广播地址');
        } finally {
            service.stop();
        }
    });
});
