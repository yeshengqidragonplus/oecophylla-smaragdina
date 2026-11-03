import * as assert from 'assert';
import {
    AUTO_PEER_TTL,
    ONLINE_TIMEOUT,
    PENDING_GRACE,
    PeerRegistry,
    computePresence
} from '../../core/peerRegistry';

const T0 = 1_000_000;

suite('PeerRegistry：在线三态', () => {
    test('computePresence：往返确认 → online；只收到对方的包 → 宽限后 oneway；都没有 → offline', () => {
        const base = { lastHeard: 0, lastAck: 0, pendingSince: 0 };
        assert.strictEqual(computePresence(base, T0), 'offline');
        assert.strictEqual(computePresence({ ...base, lastAck: T0 - 1000, lastHeard: T0 - 1000 }, T0), 'online');
        assert.strictEqual(computePresence({ ...base, lastHeard: T0 - 1000, pendingSince: T0 - 1000 }, T0), 'online');
        assert.strictEqual(computePresence({ ...base, lastHeard: T0 - 1000, pendingSince: T0 - PENDING_GRACE - 1 }, T0), 'oneway');
        assert.strictEqual(computePresence({ ...base, lastAck: T0 - ONLINE_TIMEOUT - 1, lastHeard: T0 - ONLINE_TIMEOUT - 1 }, T0), 'offline');
    });

    test('收到对方入站包：宽限期内显示在线（避免健康链路上黄灯闪烁），宽限后仍无确认则降为 oneway，再久无声则 offline', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'inbound', ip: '10.0.0.2', port: 8080, now: T0 });
        assert.strictEqual(registry.resolve('10.0.0.2:8080')?.presence, 'online');

        registry.sweep(T0 + PENDING_GRACE + 1000);
        assert.strictEqual(registry.resolve('10.0.0.2:8080')?.presence, 'oneway');

        registry.sweep(T0 + ONLINE_TIMEOUT + 1000);
        assert.strictEqual(registry.resolve('10.0.0.2:8080')?.presence, 'offline');
    });

    test('往返确认后保持在线，之后又只收到入站包时不会立刻降级', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, now: T0 });
        registry.observe({ kind: 'inbound', ip: '10.0.0.2', port: 8080, now: T0 + 30_000 });
        registry.sweep(T0 + 60_000);
        assert.strictEqual(registry.resolve('10.0.0.2:8080')?.presence, 'online');
    });

    test('单向可达的回归：能收到对方的心跳但对方从不应答我们的探测，最终显示 oneway 而不是 online', () => {
        const registry = new PeerRegistry();
        for (let t = 0; t <= 80_000; t += 30_000) {
            registry.observe({ kind: 'inbound', ip: '10.0.0.2', port: 8080, now: T0 + t });
        }
        registry.sweep(T0 + 80_000);
        assert.strictEqual(registry.resolve('10.0.0.2:8080')?.presence, 'oneway');
    });

    test('presence 变化触发 change；lastSeen 的刷新不触发', () => {
        const registry = new PeerRegistry();
        let changes = 0;
        registry.on('change', () => changes++);
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, hostname: 'PC-A', now: T0 });
        const afterFirst = changes;
        assert.ok(afterFirst >= 1);
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, hostname: 'PC-A', now: T0 + 1000 });
        assert.strictEqual(changes, afterFirst);
    });

    test('markAllOffline：全部离线并保留 lastSeen', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, now: T0 });
        registry.markAllOffline();
        const rec = registry.resolve('10.0.0.2:8080')!;
        assert.strictEqual(rec.presence, 'offline');
        assert.strictEqual(rec.lastSeen, T0);
    });
});

suite('PeerRegistry：身份与合并', () => {
    test('带 iid 的对端换 IP：只更新地址，不产生重复联系人，旧地址留作别名', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.10.214.233', port: 6688, iid: 'win-1:6688', hostname: 'DESKTOP-OF5OG27', now: T0 });
        registry.observe({ kind: 'ack', ip: '10.10.213.68', port: 6688, iid: 'win-1:6688', hostname: 'DESKTOP-OF5OG27', now: T0 + 1000 });
        registry.observe({ kind: 'ack', ip: '10.10.215.150', port: 6688, iid: 'win-1:6688', hostname: 'DESKTOP-OF5OG27', now: T0 + 2000 });

        const list = registry.list();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].id, 'win-1:6688');
        assert.strictEqual(list[0].ip, '10.10.215.150');
        assert.deepStrictEqual(list[0].aliases.sort(), ['10.10.213.68:6688', '10.10.214.233:6688']);
        assert.strictEqual(registry.resolve('10.10.214.233:6688')?.id, 'win-1:6688');
    });

    test('手工添加的条目（只有 ip:端口）在首次收到带 iid 的应答后被认领并升级，保留昵称与手工标记', () => {
        const registry = new PeerRegistry();
        registry.addManual('10.0.0.9', 8080, '张三', 'PC-Z');
        registry.observe({ kind: 'ack', ip: '10.0.0.9', port: 8080, iid: 'zhang:8080', hostname: 'PC-Z', now: T0 });

        const list = registry.list();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].id, 'zhang:8080');
        assert.strictEqual(list[0].nickname, '张三');
        assert.strictEqual(list[0].manual, true);
        assert.ok(list[0].aliases.includes('10.0.0.9:8080'));
    });

    test('旧文件里同主机名、不同 IP 的离线旧版条目，在新版对端出现后合并为一个联系人（你的 peers.json 里同一台 Windows 有 3 个 IP）', () => {
        const registry = new PeerRegistry();
        registry.load([
            { id: '10.10.214.233:6688', ip: '10.10.214.233', port: 6688, hostname: 'DESKTOP-OF5OG27', nickname: 'Arthur-Win', lastSeen: T0 - 3000 },
            { id: '10.10.213.68:6688', ip: '10.10.213.68', port: 6688, hostname: 'DESKTOP-OF5OG27', nickname: 'Arthur-Win', lastSeen: T0 - 2000 },
            { id: '10.10.215.150:6688', ip: '10.10.215.150', port: 6688, hostname: 'DESKTOP-OF5OG27', nickname: 'Arthur-Win', lastSeen: T0 - 1000 },
            { id: '10.10.212.227:6688', ip: '10.10.212.227', port: 6688, hostname: 'PC-A', nickname: 'Arthur-Work-Win', lastSeen: T0 - 1000 }
        ]);
        assert.strictEqual(registry.size, 4);

        registry.observe({ kind: 'ack', ip: '10.10.216.5', port: 6688, iid: 'arthur-win:6688', hostname: 'DESKTOP-OF5OG27', now: T0 });

        const list = registry.list();
        assert.strictEqual(list.length, 2, '三个同主机名条目应合并为一个，其余联系人不受影响');
        const merged = registry.resolve('arthur-win:6688')!;
        assert.strictEqual(merged.nickname, 'Arthur-Win');
        assert.strictEqual(merged.ip, '10.10.216.5');
        assert.ok(['10.10.214.233:6688', '10.10.213.68:6688', '10.10.215.150:6688'].every(a => merged.aliases.includes(a)));
        assert.ok(registry.resolve('10.10.212.227:6688'), '不同主机名的联系人必须保留');
    });

    test('在线的旧版条目不会被主机名合并（只合并离线的幽灵条目）', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.5', port: 8080, hostname: 'SAME-NAME', now: T0 });
        registry.observe({ kind: 'ack', ip: '10.0.0.6', port: 8080, iid: 'new:8080', hostname: 'SAME-NAME', now: T0 + 1000 });
        assert.strictEqual(registry.list().length, 2);
    });

    test('对端重装换了 iid、占用同一地址：清理旧的离线自动条目', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.7', port: 8080, iid: 'old:8080', now: T0 });
        registry.sweep(T0 + ONLINE_TIMEOUT + 1000);
        registry.observe({ kind: 'ack', ip: '10.0.0.7', port: 8080, iid: 'new:8080', now: T0 + ONLINE_TIMEOUT + 2000 });
        const list = registry.list();
        assert.deepStrictEqual(list.map(r => r.id), ['new:8080']);
        assert.ok(list[0].aliases.includes('old:8080'));
    });

    test('boot 标识变化触发 restarted 事件（对端重启过）', () => {
        const registry = new PeerRegistry();
        const restarted: string[] = [];
        registry.on('restarted', rec => restarted.push(rec.id));
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, iid: 'p:8080', boot: 'aaaa', now: T0 });
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, iid: 'p:8080', boot: 'aaaa', now: T0 + 1000 });
        assert.deepStrictEqual(restarted, []);
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, iid: 'p:8080', boot: 'bbbb', now: T0 + 2000 });
        assert.deepStrictEqual(restarted, ['p:8080']);
    });

    test('自己的 ensureByAddress：未知地址补建为非手工、离线的条目，重复调用不重复创建', () => {
        const registry = new PeerRegistry();
        const first = registry.ensureByAddress('10.0.0.3', 8080);
        const second = registry.ensureByAddress('10.0.0.3', 8080);
        assert.strictEqual(first.id, second.id);
        assert.strictEqual(first.manual, false);
        assert.strictEqual(first.presence, 'offline');
        assert.strictEqual(registry.size, 1);
    });
});

suite('PeerRegistry：清理、编辑与持久化', () => {
    test('自动发现的条目 30 天未见被清理，手工条目永不清理', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, now: T0 });
        registry.addManual('10.0.0.9', 8080, '手工');
        registry.sweep(T0 + AUTO_PEER_TTL + ONLINE_TIMEOUT + 10_000);
        assert.deepStrictEqual(registry.list().map(r => r.id), ['10.0.0.9:8080']);
    });

    test('remove 会删除记录；通过别名也能删除', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, iid: 'a:8080', now: T0 });
        registry.observe({ kind: 'ack', ip: '10.0.0.3', port: 8080, iid: 'a:8080', now: T0 + 1 });
        assert.strictEqual(registry.remove('10.0.0.2:8080'), true);
        assert.strictEqual(registry.size, 0);
        assert.strictEqual(registry.remove('nope'), false);
    });

    test('edit：手工条目改地址即换 id，旧 id 留作别名；编辑后标记为手工', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, now: T0 });
        const edited = registry.edit('10.0.0.2:8080', { ip: '10.0.0.20', nickname: '新昵称' })!;
        assert.strictEqual(edited.id, '10.0.0.20:8080');
        assert.ok(edited.aliases.includes('10.0.0.2:8080'));
        assert.strictEqual(edited.manual, true);
        assert.strictEqual(edited.presence, 'offline');
    });

    test('持久化往返：不包含 presence 等运行期字段；加载后全部离线', () => {
        const registry = new PeerRegistry();
        registry.observe({ kind: 'ack', ip: '10.0.0.2', port: 8080, iid: 'a:8080', hostname: 'PC-A', nickname: 'A', now: T0 });
        const persisted = registry.toPersisted();
        assert.ok(!('presence' in persisted[0]));
        assert.ok(!('status' in persisted[0]));

        const restored = new PeerRegistry();
        restored.load(JSON.parse(JSON.stringify(persisted)));
        const rec = restored.resolve('a:8080')!;
        assert.strictEqual(rec.presence, 'offline');
        assert.strictEqual(rec.hostname, 'PC-A');
        assert.strictEqual(rec.nickname, 'A');
        assert.strictEqual(rec.lastSeen, T0);
    });

    test('加载旧格式文件（含 status、没有 manual/iid）：条目视为手工，status 被忽略，缺失字段补全', () => {
        const registry = new PeerRegistry();
        registry.load([
            { id: '192.168.1.100:8080', ip: '192.168.1.100', port: 8080, hostname: 'PC-A', status: 'online', lastSeen: T0 },
            { ip: '192.168.1.101', port: 8080 },
            { ip: 123, port: 'x' },
            null
        ] as never);
        const list = registry.list();
        assert.strictEqual(list.length, 2);
        assert.ok(list.every(r => r.manual && r.presence === 'offline'));
        assert.strictEqual(registry.resolve('192.168.1.101:8080')?.transferPort, 9080);
    });
});
