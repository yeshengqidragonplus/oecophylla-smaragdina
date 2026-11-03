import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PeerFileStore, mergePeers } from '../../peerFileStore';

interface P { id: string; ip: string; port: number }

suite('PeerFileStore', () => {
    let dir: string;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-store-'));
    });

    teardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('文件不存在时创建空文件', () => {
        const file = path.join(dir, 'sub', 'peers.json');
        const result = new PeerFileStore<P>(file).load();
        assert.ok(result.ok);
        assert.deepStrictEqual(result.items, []);
        assert.ok(fs.existsSync(file));
    });

    test('往返读写，且不留临时文件', () => {
        const file = path.join(dir, 'peers.json');
        const store = new PeerFileStore<P>(file);
        const items: P[] = [{ id: 'a', ip: '10.0.0.1', port: 8080 }];
        store.save(items);
        store.save(items.concat({ id: 'b', ip: '10.0.0.2', port: 8080 }));

        const result = store.load();
        assert.ok(result.ok);
        assert.strictEqual(result.items.length, 2);
        assert.deepStrictEqual(fs.readdirSync(dir), ['peers.json']);
    });

    test('损坏的 JSON：返回 corrupt、备份原文件、原文件内容不变', () => {
        const file = path.join(dir, 'peers.json');
        fs.writeFileSync(file, '[{"id": "a", ');
        const result = new PeerFileStore<P>(file).load();

        assert.ok(!result.ok);
        assert.strictEqual(result.reason, 'corrupt');
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), '[{"id": "a", ');
        const backups = fs.readdirSync(dir).filter(n => n.includes('.corrupt-'));
        assert.strictEqual(backups.length, 1);
    });

    test('合法 JSON 但不是数组：视为损坏', () => {
        const file = path.join(dir, 'peers.json');
        fs.writeFileSync(file, '{"a": 1}');
        const result = new PeerFileStore<P>(file).load();
        assert.ok(!result.ok);
        assert.strictEqual(result.reason, 'corrupt');
    });

    test('目录无法创建（父路径是一个文件）：返回 unavailable', () => {
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, 'x');
        const result = new PeerFileStore<P>(path.join(blocker, 'peers.json')).load();
        assert.ok(!result.ok);
        assert.strictEqual(result.reason, 'unavailable');
    });

    test('mergePeers：文件为底，内存条目覆盖同 id，两边独有的都保留', () => {
        const fileItems: P[] = [
            { id: 'manual', ip: '10.0.0.9', port: 8080 },
            { id: 'shared', ip: '10.0.0.1', port: 8080 }
        ];
        const memory = new Map<string, P>([
            ['shared', { id: 'shared', ip: '10.0.0.2', port: 8080 }],
            ['fresh', { id: 'fresh', ip: '10.0.0.3', port: 8080 }]
        ]);
        const merged = mergePeers(fileItems, memory);
        assert.deepStrictEqual(Array.from(merged.keys()).sort(), ['fresh', 'manual', 'shared']);
        assert.strictEqual(merged.get('shared')?.ip, '10.0.0.2');
    });
});
