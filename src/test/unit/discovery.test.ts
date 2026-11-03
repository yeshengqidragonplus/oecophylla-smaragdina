import * as assert from 'assert';
import { NetworkService } from '../../core/networkService';

type Internals = {
    _broadcastEnabled: boolean;
    _probePeers(): void;
};

function internals(service: NetworkService): Internals {
    return service as unknown as Internals;
}

function randomBasePort(): number {
    return 30000 + Math.floor(Math.random() * 15000);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return condition();
}

suite('发现：单播探测不依赖广播', () => {
    test('两端都关闭广播；手工配置的对端靠单播探测互相找到，并被认领升级为稳定身份', async function () {
        this.timeout(10_000);
        const portA = randomBasePort();
        const portB = portA + 2000;
        const a = new NetworkService();
        const b = new NetworkService();
        internals(a)._broadcastEnabled = false;
        internals(b)._broadcastEnabled = false;
        await a.start(portA);
        await b.start(portB);
        try {
            const ip = a.getLocalIp();

            // 模拟 peers.json 里手工配置的对端：从未联系过（旧实现下，失联超过 180 秒就不再探测）
            a.registry.addManual(ip, portB, '手工配置的B');
            internals(a)._probePeers();

            const aSeesB = await waitFor(
                () => a.getPeers().some(p => p.port === portB && p.status === 'online'), 3000);
            assert.ok(aSeesB, 'A 没有通过单播探测发现 B');

            const bSeesA = await waitFor(() => b.getPeers().some(p => p.port === portA), 3000);
            assert.ok(bSeesA, 'B 没有因 A 的探测而登记 A');

            // 手工条目被认领升级为 B 的实例 ID，昵称与手工标记保留
            const peerB = a.getPeers().find(p => p.port === portB)!;
            assert.strictEqual(peerB.id, b.getInstanceId());
            assert.strictEqual(peerB.nickname, '手工配置的B');
            assert.strictEqual(peerB.manual, true);
        } finally {
            a.stop();
            b.stop();
        }
    });

    test('单播探测后对端只登记一次（不重复）', async function () {
        this.timeout(10_000);
        const portA = randomBasePort();
        const portB = portA + 2000;
        const a = new NetworkService();
        const b = new NetworkService();
        internals(a)._broadcastEnabled = false;
        internals(b)._broadcastEnabled = false;
        await a.start(portA);
        await b.start(portB);
        try {
            const ip = a.getLocalIp();
            a.registry.addManual(ip, portB);
            internals(a)._probePeers();
            assert.ok(await waitFor(() => a.getPeers().some(p => p.port === portB && p.status === 'online'), 3000));
            internals(a)._probePeers();
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.strictEqual(a.getPeers().filter(p => p.port === portB).length, 1);
        } finally {
            a.stop();
            b.stop();
        }
    });
});
