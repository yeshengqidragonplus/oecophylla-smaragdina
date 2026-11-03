import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore } from '../../core/chatStore';
import { setConsoleEnabled } from '../../core/logger';

suite('ChatStore：一人一会话与持久化', () => {
    let tmp: string;
    let dir: string;

    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));
    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-chat-'));
        dir = path.join(tmp, 'chats');
    });
    teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const make = (options = {}): ChatStore => new ChatStore(dir, { saveDelayMs: 10, ...options });

    test('同一个联系人始终只有一个会话；别名 id 与规范 id 归到同一会话', () => {
        const aliases: Record<string, string> = { '10.0.0.2:6688': 'win:6688', '10.0.0.9:6688': 'win:6688' };
        const store = make({ resolvePeerId: (id: string) => aliases[id] ?? id });
        const first = store.getOrCreate('10.0.0.2:6688', 'Arthur-Win');
        const second = store.getOrCreate('win:6688', 'Arthur-Win');
        const third = store.getOrCreate('10.0.0.9:6688', 'Arthur-Win');
        assert.strictEqual(first.id, second.id);
        assert.strictEqual(first.id, third.id);
        assert.strictEqual(store.list().length, 1);
        assert.strictEqual(first.peerId, 'win:6688', '旧会话保存的别名应升级为规范 id');
    });

    test('追加、状态更新、未读计数、已读', () => {
        const store = make();
        const conv = store.getOrCreate('p1', 'A');
        const out = store.append(conv.id, { direction: 'out', text: '你好', status: 'sending' });
        store.update(conv.id, out.id, { status: 'delivered' });
        store.append(conv.id, { direction: 'in', text: '收到' });
        store.append(conv.id, { direction: 'in', text: '再见' });
        assert.strictEqual(conv.messages.length, 3);
        assert.strictEqual(conv.messages[0].status, 'delivered');
        assert.strictEqual(conv.unread, 2);
        store.markRead(conv.id);
        assert.strictEqual(conv.unread, 0);
    });

    test('持久化往返：flush 后新实例能读回全部内容', async () => {
        const store = make();
        const conv = store.getOrCreate('p1', 'A');
        store.append(conv.id, { direction: 'out', text: '第一条', status: 'delivered' });
        store.append(conv.id, { direction: 'in', text: '第二条', file: { name: 'a.bin', size: 3, status: 'completed', progress: 100, path: '/x/a.bin' } });
        await store.flush();

        const reloaded = make();
        await reloaded.load();
        const got = reloaded.findByPeer('p1')!;
        assert.strictEqual(got.messages.length, 2);
        assert.strictEqual(got.messages[1].file?.name, 'a.bin');
        assert.strictEqual(got.unread, 1);
    });

    test('只写有变化的会话；进度更新（persist=false）不触发写盘', async () => {
        const store = make();
        const a = store.getOrCreate('a', 'A');
        const b = store.getOrCreate('b', 'B');
        const msg = store.append(a.id, { direction: 'in', text: 'x', file: { name: 'f', size: 10, status: 'transferring', progress: 0 } });
        store.append(b.id, { direction: 'in', text: 'y' });
        await store.flush();
        const fileB = path.join(dir, `${b.id}.json`);
        const before = fs.statSync(fileB).mtimeMs;

        await new Promise(resolve => setTimeout(resolve, 30));
        store.update(a.id, msg.id, { file: { name: 'f', size: 10, status: 'transferring', progress: 50 } }, false);
        await store.flush();
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${a.id}.json`), 'utf-8'));
        assert.strictEqual(onDisk.messages[0].file.progress, 0, '瞬时进度不应写盘');
        assert.strictEqual(fs.statSync(fileB).mtimeMs, before, '没有变化的会话不应重写');

        store.update(a.id, msg.id, { file: { name: 'f', size: 10, status: 'completed', progress: 100 } });
        await store.flush();
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${a.id}.json`), 'utf-8')).messages[0].file.status, 'completed');
    });

    test('每个会话最多保留 maxMessages 条，丢弃最旧的', () => {
        const store = make({ maxMessages: 5 });
        const conv = store.getOrCreate('p', 'P');
        for (let i = 0; i < 12; i++) {
            store.append(conv.id, { direction: 'out', text: `m${i}` });
        }
        assert.deepStrictEqual(conv.messages.map(m => m.text), ['m7', 'm8', 'm9', 'm10', 'm11']);
    });

    test('删除会话同时删除文件', async () => {
        const store = make();
        const conv = store.getOrCreate('p', 'P');
        store.append(conv.id, { direction: 'out', text: 'x' });
        await store.flush();
        assert.ok(fs.existsSync(path.join(dir, `${conv.id}.json`)));
        store.remove(conv.id);
        await store.flush();
        assert.ok(!fs.existsSync(path.join(dir, `${conv.id}.json`)));
        assert.strictEqual(store.list().length, 0);
    });

    test('损坏的会话文件被挪到一边保留，不影响其他会话', async () => {
        const store = make();
        const ok = store.getOrCreate('ok', 'OK');
        store.append(ok.id, { direction: 'in', text: '好的' });
        await store.flush();
        fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');

        const reloaded = make();
        await reloaded.load();
        assert.strictEqual(reloaded.list().length, 1);
        assert.ok(fs.readdirSync(dir).some(n => n.startsWith('broken.json.corrupt-')));
    });

    test('写盘是原子的：不留临时文件', async () => {
        const store = make();
        const conv = store.getOrCreate('p', 'P');
        store.append(conv.id, { direction: 'out', text: 'x' });
        await store.flush();
        assert.ok(fs.readdirSync(dir).every(n => !n.endsWith('.tmp')));
    });
});

suite('ChatStore：旧版 chatSessions.json 迁移', () => {
    let tmp: string;
    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));
    setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-mig-')); });
    teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

    // 重现真实数据的形态：同一个对端 5 个会话，另有一个以原始 id 命名的会话
    function writeLegacy(): string {
        const legacy = path.join(tmp, 'chatSessions.json');
        const msg = (id: string, type: string, content: string, ts: number) => ({ id, type, content, timestamp: ts });
        fs.writeFileSync(legacy, JSON.stringify([
            { id: 's1', title: 'Arthur-Win', peerId: '10.10.214.233:6688', peerName: 'Arthur-Win', lastUpdated: 500, messages: [
                msg('m3', 'assistant', '📨 来自 Arthur-Win:\n收到，我看一下', 300), msg('m1', 'user', '你好', 100), msg('m2', 'system', '⏳ 正在建立连接...', 200)] },
            { id: 's2', title: 'x', peerId: '10.10.214.233:6688', peerName: 'Arthur-Win', lastUpdated: 400, messages: [msg('m4', 'user', '在吗', 400)] },
            { id: 's3', title: 'x', peerId: '10.10.214.233:6688', peerName: 'Arthur-Win', lastUpdated: 100, messages: [msg('m1', 'user', '你好', 100)] },
            { id: 's4', title: '10.10.213.68:6688', peerId: '10.10.213.68:6688', peerName: '10.10.213.68:6688', lastUpdated: 50, messages: [msg('m5', 'assistant', '📨 来自 10.10.213.68:6688:\n测试', 50)] },
            { id: 's5', title: '新会话', messages: [msg('m6', 'system', '❌ 请先选择发送目标', 10)] },
            { id: 's6', title: '残留', messages: [msg('m7', 'user', '没有关联联系人的消息', 20)] }
        ]));
        return legacy;
    }

    test('同一个联系人的多个旧会话合并为一个：消息按时间排序、按 id 去重、去掉"📨 来自"前缀', async () => {
        const legacyPath = writeLegacy();
        // 两个旧地址都属于同一台机器
        const canonical = (id: string): string => (id.startsWith('10.10.214.233') || id.startsWith('10.10.213.68')) ? 'arthur-win:6688' : id;
        const store = new ChatStore(path.join(tmp, 'chats'), { legacyPath, resolvePeerId: canonical, saveDelayMs: 10 });
        await store.load();

        const conv = store.findByPeer('10.10.214.233:6688')!;
        assert.strictEqual(conv.peerId, 'arthur-win:6688');
        assert.strictEqual(conv.title, 'Arthur-Win');
        assert.deepStrictEqual(conv.messages.map(m => m.id), ['m5', 'm1', 'm2', 'm3', 'm4']);
        assert.strictEqual(conv.messages.find(m => m.id === 'm3')!.text, '收到，我看一下');
        assert.strictEqual(conv.messages.find(m => m.id === 'm3')!.direction, 'in');
        assert.strictEqual(conv.messages.find(m => m.id === 'm1')!.direction, 'out');

        // 只有系统消息的空会话被丢弃；无联系人但有真实内容的集中到"未关联"会话
        const all = store.list();
        assert.strictEqual(all.length, 2);
        const orphan = all.find(c => c.peerId === '')!;
        assert.deepStrictEqual(orphan.messages.map(m => m.text), ['没有关联联系人的消息']);
    });

    test('迁移后原文件改名保留作为备份，再次加载不会重复迁移', async () => {
        const legacyPath = writeLegacy();
        const options = { legacyPath, saveDelayMs: 10 };
        const first = new ChatStore(path.join(tmp, 'chats'), options);
        await first.load();
        assert.ok(!fs.existsSync(legacyPath));
        assert.ok(fs.readdirSync(tmp).some(n => n.startsWith('chatSessions.json.migrated-')));

        const second = new ChatStore(path.join(tmp, 'chats'), options);
        await second.load();
        assert.strictEqual(second.list().length, first.list().length);
        assert.strictEqual(second.list().reduce((n, c) => n + c.messages.length, 0), first.list().reduce((n, c) => n + c.messages.length, 0));
    });

    test('旧文件无法解析时跳过迁移并保留原文件', async () => {
        const legacyPath = path.join(tmp, 'chatSessions.json');
        fs.writeFileSync(legacyPath, '{ broken');
        const store = new ChatStore(path.join(tmp, 'chats'), { legacyPath });
        await store.load();
        assert.ok(fs.existsSync(legacyPath));
        assert.strictEqual(store.list().length, 0);
    });

    test('没有旧文件时正常启动', async () => {
        const store = new ChatStore(path.join(tmp, 'chats'), { legacyPath: path.join(tmp, 'nope.json') });
        await store.load();
        assert.strictEqual(store.list().length, 0);
    });
});
