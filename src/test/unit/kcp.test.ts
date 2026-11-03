import * as assert from 'assert';
import { Kcp } from '../../core/kcp';

/**
 * KCP 协议层测试：两个 Kcp 实例之间接一条"不可靠链路"（丢包、乱序、重复、延迟），
 * 用模拟时钟驱动，验证 ARQ 最终能把数据完整、按序地送达。
 * 之前 714 行的 ARQ 实现只有端到端冒烟，没有协议层单测。
 */

/** 可复现的伪随机数（LCG），保证每次运行丢的是同一批包 */
function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

interface LinkOptions {
    loss: number;
    duplicate?: number;
    /** 最大额外延迟（毫秒），随机延迟会造成乱序 */
    jitter?: number;
    baseDelay?: number;
    seed: number;
}

class SimulatedLink {
    private readonly _queue: Array<{ at: number; data: Buffer }> = [];
    private readonly _random: () => number;

    constructor(private readonly _options: LinkOptions, private readonly _deliver: (data: Buffer) => void) {
        this._random = makeRandom(_options.seed);
    }

    send(data: Buffer, now: number): void {
        if (this._random() < this._options.loss) {
            return;
        }
        const copies = this._random() < (this._options.duplicate ?? 0) ? 2 : 1;
        for (let i = 0; i < copies; i++) {
            const delay = (this._options.baseDelay ?? 5) + this._random() * (this._options.jitter ?? 0);
            this._queue.push({ at: now + delay, data: Buffer.from(data) });
        }
    }

    pump(now: number): void {
        this._queue.sort((a, b) => a.at - b.at);
        while (this._queue.length > 0 && this._queue[0].at <= now) {
            this._deliver(this._queue.shift()!.data);
        }
    }
}

/** 在模拟时钟下把 messages 从 A 发到 B，返回 B 按序收到的消息 */
function transfer(messages: Buffer[], options: LinkOptions, maxSimulatedMs = 300_000): { received: Buffer[]; elapsed: number } {
    const a = new Kcp(0x11223344);
    const b = new Kcp(0x11223344);
    for (const k of [a, b]) {
        k.setNodelay(1, 10, 2, 1);
        k.setWndSize(256, 256);
        k.setMtu(1200);
    }
    let now = 1_000;
    const aToB = new SimulatedLink({ ...options, seed: options.seed }, data => b.input(data));
    const bToA = new SimulatedLink({ ...options, seed: options.seed + 1 }, data => a.input(data));
    a.setOutput(data => aToB.send(data, now));
    b.setOutput(data => bToA.send(data, now));

    const received: Buffer[] = [];
    const queue = [...messages];
    const start = now;
    while (received.length < messages.length && now - start < maxSimulatedMs) {
        // 发送窗口有余量时继续塞消息
        while (queue.length > 0 && a.waitSnd() < 200) {
            assert.ok(a.send(queue[0]) >= 0, 'send 不应失败');
            queue.shift();
        }
        aToB.pump(now);
        bToA.pump(now);
        a.update(now);
        b.update(now);
        let data = b.recv();
        while (data !== null) {
            received.push(data);
            data = b.recv();
        }
        now += 10;
    }
    return { received, elapsed: now - start };
}

function patterned(size: number, seed: number): Buffer {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
        buf[i] = (i * 31 + seed) & 0xff;
    }
    return buf;
}

suite('Kcp：ARQ 在不可靠链路上的可靠性', () => {
    test('无损链路：多条消息按序完整送达（含大于单个 MTU 的消息）', () => {
        const messages = [patterned(10, 1), patterned(5000, 2), patterned(90_000, 3), patterned(1, 4)];
        const { received } = transfer(messages, { loss: 0, seed: 1 });
        assert.strictEqual(received.length, messages.length);
        received.forEach((m, i) => assert.ok(m.equals(messages[i]), `第 ${i} 条不一致`));
    });

    test('20% 丢包：一条 120KB 的消息（约 100 个分片）最终完整送达', () => {
        const message = patterned(120_000, 7);
        const { received } = transfer([message], { loss: 0.2, seed: 42 });
        assert.strictEqual(received.length, 1);
        assert.ok(received[0].equals(message));
    });

    test('40% 丢包 + 重复 + 乱序：多条消息仍按序、完整送达', () => {
        const messages = Array.from({ length: 6 }, (_, i) => patterned(30_000 + i * 1000, i + 10));
        const { received } = transfer(messages, { loss: 0.4, duplicate: 0.2, jitter: 80, seed: 99 });
        assert.strictEqual(received.length, messages.length);
        received.forEach((m, i) => assert.ok(m.equals(messages[i]), `第 ${i} 条不一致或乱序`));
    });

    test('大延迟与抖动（Wi-Fi 场景）：送达，且耗时在合理范围内', () => {
        const message = patterned(100_000, 5);
        const { received, elapsed } = transfer([message], { loss: 0.05, baseDelay: 40, jitter: 60, seed: 5 });
        assert.strictEqual(received.length, 1);
        assert.ok(received[0].equals(message));
        assert.ok(elapsed < 60_000, `耗时 ${elapsed}ms`);
    });

    test('单条消息最多 128 个分片（MTU 1200 时约 150KB）：超过的 send 直接返回负数；业务帧（约 88KB）有余量', () => {
        const k = new Kcp(1);
        k.setMtu(1200);
        assert.ok(k.send(patterned(150_000, 1)) < 0, '约 128 个分片以上应被拒绝');
        assert.ok(k.send(patterned(90_000, 1)) >= 0, '一个文件分块帧（约 88KB）必须能发送');
    });

    test('链路完全中断：持续重传直至判定死链（单段 RTO 按 1.5 倍退避，约需模拟 20 分钟；真实场景由传输层 5 秒确认停滞先判离线），而不是无限等待', () => {
        const a = new Kcp(1);
        a.setNodelay(1, 10, 2, 1);
        let now = 1_000;
        a.setOutput(() => undefined); // 所有包都丢
        a.send(patterned(1000, 1));
        for (let i = 0; i < 300_000 && !a.isDeadLink; i++) {
            a.update(now);
            now += 10;
        }
        assert.ok(a.isDeadLink, '重传超限后应判定链路死亡');
    });

    test('不同 conv 的报文互不干扰', () => {
        const a = new Kcp(1);
        const other = new Kcp(2);
        let leaked = false;
        other.setOutput(() => undefined);
        a.setOutput(data => { if (other.input(data) >= 0) { leaked = true; } });
        a.send(patterned(100, 1));
        a.update(1_000);
        a.update(1_020);
        assert.strictEqual(leaked, false);
        assert.strictEqual(other.recv(), null);
    });
});
