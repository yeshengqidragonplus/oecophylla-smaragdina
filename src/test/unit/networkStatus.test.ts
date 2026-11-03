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
