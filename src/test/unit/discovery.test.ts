import * as assert from 'assert';
import { NetworkService, PeerInfo } from '../../core/networkService';

type Internals = {
    _broadcastEnabled: boolean;
    _peers: Map<string, PeerInfo>;
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
    test('两端都关闭广播；手工配置的对端失联很久后仍能靠单播探测互相找到（回归：旧实现 180 秒后不再探测）', async function () {
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
            const peerBId = `${ip}:${portB}`;
            const peerAId = `${ip}:${portA}`;

            // 模拟 peers.json 里手工配置的对端：离线，且 10 分钟前就见过（旧实现早已停止探测）
            internals(a)._peers.set(peerBId, {
                id: peerBId, hostname: '', ip, port: portB, transferPort: portB + 1000,
                lastSeen: Date.now() - 600_000, status: 'offline'
            });
            internals(a)._probePeers();

            const aSeesB = await waitFor(
                () => a.getPeers().some(p => p.id === peerBId && p.status === 'online'), 3000);
            assert.ok(aSeesB, 'A 没有通过单播探测发现 B');

            const bSeesA = await waitFor(() => b.getPeers().some(p => p.id === peerAId), 3000);
            assert.ok(bSeesA, 'B 没有因 A 的探测而登记 A');
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
            const peerBId = `${ip}:${portB}`;
            internals(a)._peers.set(peerBId, {
                id: peerBId, hostname: '', ip, port: portB, transferPort: portB + 1000,
                lastSeen: 0, status: 'offline'
            });
            internals(a)._probePeers();
            assert.ok(await waitFor(() => a.getPeers().some(p => p.id === peerBId && p.status === 'online'), 3000));
            assert.strictEqual(a.getPeers().filter(p => p.id === peerBId).length, 1);
        } finally {
            a.stop();
            b.stop();
        }
    });
});
