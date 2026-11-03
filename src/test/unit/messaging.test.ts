import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore } from '../../core/chatStore';
import { FileReceiver } from '../../core/fileReceiver';
import { setConsoleEnabled } from '../../core/logger';
import { IncomingNotice, MessagingService } from '../../core/messaging';
import { NetworkService } from '../../core/networkService';

function randomBasePort(): number {
    return 30000 + Math.floor(Math.random() * 15000);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    return condition();
}

interface Side {
    network: NetworkService;
    store: ChatStore;
    messaging: MessagingService;
    notices: IncomingNotice[];
    downloads: string;
}

suite('MessagingService：收发消息与文件（端到端，环回）', () => {
    let tmp: string;
    let a: Side;
    let b: Side;
    let idB: string;
    let idA: string;

    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    async function makeSide(name: string, port: number): Promise<Side> {
        const network = new NetworkService();
        await network.start(port);
        const store = new ChatStore(path.join(tmp, name, 'chats'), {
            saveDelayMs: 10,
            resolvePeerId: id => network.registry.resolve(id)?.id ?? id
        });
        await store.load();
        const downloads = path.join(tmp, name, 'downloads');
        const receiver = new FileReceiver({ resolveDir: () => downloads, sweepIntervalMs: 1000 });
        const notices: IncomingNotice[] = [];
        const messaging = new MessagingService({
            network, store, receiver,
            displayName: id => network.registry.resolve(id)?.hostname ?? id
        });
        messaging.on('incoming', n => notices.push(n));
        return { network, store, messaging, notices, downloads };
    }

    setup(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-msg-'));
        const port = randomBasePort();
        a = await makeSide('a', port);
        b = await makeSide('b', port + 2000);
        assert.ok(await waitFor(() => a.network.getPeers().some(p => p.port === port + 2000 && p.status === 'online' && !!p.iid)
            && b.network.getPeers().some(p => p.port === port && p.status === 'online' && !!p.iid), 8000), '两端没有互相发现');
        idB = a.network.getPeers().find(p => p.port === port + 2000)!.id;
        idA = b.network.getPeers().find(p => p.port === port)!.id;
    });

    teardown(async () => {
        a.messaging.dispose();
        b.messaging.dispose();
        a.network.stop();
        b.network.stop();
        await a.store.flush();
        await b.store.flush();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    function makeFile(size: number, name = 'f.bin'): { filePath: string; content: Buffer } {
        const content = crypto.randomBytes(size);
        const filePath = path.join(tmp, name);
        fs.writeFileSync(filePath, content);
        return { filePath, content };
    }

    test('发送文本：发送方消息变为 delivered，接收方入库到该联系人的会话并发出 incoming 通知', async function () {
        this.timeout(20_000);
        const outcomes = await a.messaging.send(idB, '你好，世界');
        assert.deepStrictEqual(outcomes.map(o => o.ok), [true]);

        const sent = a.store.findByPeer(idB)!;
        assert.strictEqual(sent.messages.length, 1);
        assert.strictEqual(sent.messages[0].status, 'delivered');

        assert.ok(await waitFor(() => !!b.store.findByPeer(idA)?.messages.length, 5000));
        const got = b.store.findByPeer(idA)!;
        assert.deepStrictEqual(got.messages.map(m => [m.direction, m.text]), [['in', '你好，世界']]);
        assert.strictEqual(got.unread, 1);
        assert.strictEqual(b.notices.length, 1);
        assert.strictEqual(b.notices[0].kind, 'text');
        assert.strictEqual(b.notices[0].preview, '你好，世界');
    });

    test('发送文件：接收方会话里出现文件消息，完成后带保存路径与 100% 进度；发送方为 delivered', async function () {
        this.timeout(30_000);
        const { filePath, content } = makeFile(700_000, 'doc.bin');
        const outcomes = await a.messaging.send(idB, '', [{ name: 'doc.bin', path: filePath, size: content.length }]);
        assert.deepStrictEqual(outcomes.map(o => o.ok), [true]);

        const sent = a.store.findByPeer(idB)!.messages[0];
        assert.strictEqual(sent.status, 'delivered');
        assert.strictEqual(sent.file?.status, 'completed');
        assert.strictEqual(sent.file?.progress, 100);

        const got = b.store.findByPeer(idA)!.messages.find(m => m.file)!;
        assert.strictEqual(got.file?.status, 'completed');
        assert.strictEqual(got.file?.progress, 100);
        assert.deepStrictEqual(fs.readFileSync(got.file!.path!), content);
        assert.ok(b.notices.some(n => n.kind === 'file' && n.preview.includes('doc.bin')));
    });

    test('文字与多个文件：各自独立成消息、各有各的状态，按顺序出现在同一个会话里', async function () {
        this.timeout(30_000);
        const f1 = makeFile(50_000, 'one.bin');
        const f2 = makeFile(60_000, 'two.bin');
        const outcomes = await a.messaging.send(idB, '附件如下', [
            { name: 'one.bin', path: f1.filePath, size: 50_000 },
            { name: 'two.bin', path: f2.filePath, size: 60_000 }
        ]);
        assert.deepStrictEqual(outcomes.map(o => o.ok), [true, true, true]);
        const conv = a.store.findByPeer(idB)!;
        assert.deepStrictEqual(conv.messages.map(m => m.file?.name ?? m.text), ['附件如下', 'one.bin', 'two.bin']);
        assert.ok(conv.messages.every(m => m.status === 'delivered'));
    });

    test('一人一会话：用旧版 ip:端口 与实例 ID 向同一个人发送，落在同一个会话（回归：旧实现一个人 5 个会话）', async function () {
        this.timeout(30_000);
        const rec = a.network.registry.resolve(idB)!;
        await a.messaging.send(idB, '第一条');
        await a.messaging.send(`${rec.ip}:${rec.port}`, '第二条');
        assert.strictEqual(a.store.list().length, 1);
        assert.deepStrictEqual(a.store.list()[0].messages.map(m => m.text), ['第一条', '第二条']);
    });

    test('失败可重试：待发送文件不存在时消息为 failed 并带原因，文件恢复后重试成功', async function () {
        this.timeout(30_000);
        const missing = path.join(tmp, 'later.bin');
        const outcomes = await a.messaging.send(idB, '', [{ name: 'later.bin', path: missing, size: 10 }]);
        assert.strictEqual(outcomes[0].ok, false);
        assert.ok(outcomes[0].error?.includes('已被移动或删除'));

        const conv = a.store.findByPeer(idB)!;
        const failed = conv.messages[0];
        assert.strictEqual(failed.status, 'failed');
        assert.strictEqual(failed.file?.status, 'failed');

        const content = crypto.randomBytes(10);
        fs.writeFileSync(missing, content);
        const retried = await a.messaging.retry(conv.id, failed.id);
        assert.strictEqual(retried?.ok, true);
        assert.strictEqual(conv.messages[0].status, 'delivered');
        assert.strictEqual(conv.messages[0].error, undefined);
    });

    test('取消：文件消息变为 failed + cancelled，原因为"已取消"', async function () {
        this.timeout(30_000);
        const { filePath, content } = makeFile(5_000_000, 'big.bin');
        const pending = a.messaging.send(idB, '', [{ name: 'big.bin', path: filePath, size: content.length }]);
        const msgId = await (async () => {
            await waitFor(() => !!a.store.findByPeer(idB)?.messages[0], 2000);
            return a.store.findByPeer(idB)!.messages[0].id;
        })();
        // 等任务真正开始传输后取消
        await waitFor(() => a.messaging.cancel(msgId), 5000);
        const outcomes = await pending;

        assert.strictEqual(outcomes[0].ok, false);
        const message = a.store.findByPeer(idB)!.messages[0];
        assert.strictEqual(message.status, 'failed');
        assert.strictEqual(message.file?.status, 'cancelled');
        assert.strictEqual(message.error, '已取消');
    });

    test('向未知且不可达的联系人发送：失败并给出可读原因（连接失败，对方可能不在线）', async function () {
        this.timeout(30_000);
        a.network.registry.addManual('127.0.0.1', 9, '不存在的人');
        const ghost = a.network.registry.findByAddress('127.0.0.1', 9)!;
        const outcomes = await a.messaging.send(ghost.id, '有人吗');
        assert.strictEqual(outcomes[0].ok, false);
        assert.ok(outcomes[0].error?.includes('连接失败'));
        assert.strictEqual(a.store.findByPeer(ghost.id)!.messages[0].status, 'failed');
    });
});
