import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileReceiver, cleanupStaleParts } from '../../core/fileReceiver';
import { setConsoleEnabled } from '../../core/logger';
import { FILE_CHUNK_SIZE, FileChunkMessage } from '../../core/protocol';

/** 把一个文件内容切成与发送端一致的分块消息 */
function toChunks(name: string, content: Buffer, transferId?: string): FileChunkMessage[] {
    const totalChunks = Math.max(1, Math.ceil(content.length / FILE_CHUNK_SIZE));
    const chunks: FileChunkMessage[] = [];
    for (let i = 0; i < totalChunks; i++) {
        const piece = content.subarray(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE);
        chunks.push({
            type: 'file', from: 'peer', timestamp: 1,
            file: { name, size: content.length, chunkIndex: i, totalChunks, data: piece.toString('base64'), transferId }
        });
    }
    return chunks;
}

function randomBytes(size: number): Buffer {
    return crypto.randomBytes(size);
}

suite('FileReceiver：流式接收', () => {
    let dir: string;
    let receiver: FileReceiver;
    const completed: Array<{ savedPath: string; fileName: string }> = [];
    const failed: string[] = [];
    const progress: number[] = [];

    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-recv-'));
        completed.length = 0;
        failed.length = 0;
        progress.length = 0;
        receiver = new FileReceiver({ resolveDir: () => dir, progressIntervalMs: 0, sweepIntervalMs: 20, idleTimeoutMs: 100_000 });
        receiver.on('completed', info => completed.push({ savedPath: info.savedPath, fileName: info.fileName }));
        receiver.on('failed', info => failed.push(info.reason));
        receiver.on('progress', info => progress.push(info.progress));
    });

    teardown(() => {
        receiver.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('按序接收：内容一致，最终文件名正确，目录里没有残留的 .part', async () => {
        const content = randomBytes(FILE_CHUNK_SIZE * 3 + 1234);
        toChunks('data.bin', content).forEach(c => receiver.handleChunk('peer-a', c));
        await receiver.whenIdle();

        assert.strictEqual(completed.length, 1);
        assert.deepStrictEqual(fs.readFileSync(completed[0].savedPath), content);
        assert.deepStrictEqual(fs.readdirSync(dir), ['data.bin']);
        assert.deepStrictEqual(failed, []);
    });

    test('乱序且重复的分块：结果与内容一致，重复块不重复计数', async () => {
        const content = randomBytes(FILE_CHUNK_SIZE * 4 + 77);
        const chunks = toChunks('shuffled.bin', content);
        const order = [3, 0, 4, 1, 1, 2, 4, 0];
        order.forEach(i => receiver.handleChunk('peer-a', chunks[i]));
        await receiver.whenIdle();

        assert.strictEqual(completed.length, 1);
        assert.deepStrictEqual(fs.readFileSync(completed[0].savedPath), content);
        assert.strictEqual(progress[progress.length - 1], 100);
    });

    test('0 字节文件正常落盘（回归：旧实现把空数据串当作无效分块丢弃，发送端报成功、接收端没有文件）', async () => {
        toChunks('empty.txt', Buffer.alloc(0)).forEach(c => receiver.handleChunk('peer-a', c));
        await receiver.whenIdle();

        assert.strictEqual(completed.length, 1);
        assert.strictEqual(fs.statSync(completed[0].savedPath).size, 0);
        assert.strictEqual(path.basename(completed[0].savedPath), 'empty.txt');
    });

    test('同名文件并发（transferId 不同）互不混淆，分别保存为 a.bin 与 a (1).bin', async () => {
        const first = randomBytes(FILE_CHUNK_SIZE * 2 + 5);
        const second = randomBytes(FILE_CHUNK_SIZE * 2 + 5);
        const a = toChunks('a.bin', first, 'tid-1');
        const b = toChunks('a.bin', second, 'tid-2');
        // 交错到达
        for (let i = 0; i < a.length; i++) {
            receiver.handleChunk('peer-a', a[i]);
            receiver.handleChunk('peer-a', b[i]);
        }
        await receiver.whenIdle();

        assert.strictEqual(completed.length, 2);
        const saved = completed.map(c => fs.readFileSync(c.savedPath));
        assert.ok(saved.some(s => s.equals(first)) && saved.some(s => s.equals(second)));
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a (1).bin', 'a.bin']);
    });

    test('失败后重发（新的 transferId）：不会拿上次残留的分块拼接（回归：旧实现以 对端+文件名 为键）', async () => {
        const content = randomBytes(FILE_CHUNK_SIZE * 3);
        const partial = toChunks('retry.bin', content, 'old');
        receiver.handleChunk('peer-a', partial[0]);
        receiver.handleChunk('peer-a', partial[1]);

        const fresh = randomBytes(FILE_CHUNK_SIZE * 3);
        toChunks('retry.bin', fresh, 'new').forEach(c => receiver.handleChunk('peer-a', c));
        await receiver.whenIdle();

        assert.strictEqual(completed.length, 1);
        assert.deepStrictEqual(fs.readFileSync(completed[0].savedPath), fresh);
    });

    test('分块长度不符（数据损坏）：传输失败并清理临时文件', async () => {
        const content = randomBytes(FILE_CHUNK_SIZE * 2);
        const chunks = toChunks('bad.bin', content, 't');
        chunks[1].file.data = randomBytes(100).toString('base64');
        chunks.forEach(c => receiver.handleChunk('peer-a', c));
        await receiver.whenIdle();

        assert.strictEqual(completed.length, 0);
        assert.strictEqual(failed.length, 1);
        assert.ok(failed[0].includes('长度不符'));
        assert.deepStrictEqual(fs.readdirSync(dir), []);
    });

    test('保存目录不可用：失败并给出原因，不抛异常', async () => {
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, 'x');
        const broken = new FileReceiver({ resolveDir: () => path.join(blocker, 'sub'), sweepIntervalMs: 1000 });
        const reasons: string[] = [];
        broken.on('failed', info => reasons.push(info.reason));
        toChunks('x.bin', randomBytes(10)).forEach(c => broken.handleChunk('peer-a', c));
        await broken.whenIdle();
        broken.dispose();
        assert.strictEqual(reasons.length, 1);
    });

    test('恶意文件名：最终仍保存在目标目录内且已清理', async () => {
        toChunks('../../../evil\u0000.txt', randomBytes(10)).forEach(c => receiver.handleChunk('peer-a', c));
        await receiver.whenIdle();
        assert.strictEqual(completed.length, 1);
        assert.strictEqual(path.dirname(completed[0].savedPath), dir);
        assert.strictEqual(path.basename(completed[0].savedPath), 'evil.txt');
    });

    test('长时间没有数据：判定中断，清理 .part，并发出 failed', async () => {
        const impatient = new FileReceiver({ resolveDir: () => dir, idleTimeoutMs: 50, sweepIntervalMs: 20 });
        const reasons: string[] = [];
        impatient.on('failed', info => reasons.push(info.reason));
        const chunks = toChunks('stalled.bin', randomBytes(FILE_CHUNK_SIZE * 3), 'stall');
        impatient.handleChunk('peer-a', chunks[0]);
        await impatient.whenIdle();
        await new Promise(resolve => setTimeout(resolve, 200));
        await impatient.whenIdle();
        impatient.dispose();

        assert.strictEqual(reasons.length, 1);
        assert.ok(reasons[0].includes('中断'));
        assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.part')), []);
    });

    test('进度单调不减，最终为 100', async () => {
        toChunks('p.bin', randomBytes(FILE_CHUNK_SIZE * 5)).forEach(c => receiver.handleChunk('peer-a', c));
        await receiver.whenIdle();
        assert.ok(progress.length >= 2);
        assert.deepStrictEqual(progress, [...progress].sort((x, y) => x - y));
        assert.strictEqual(progress[progress.length - 1], 100);
    });

    test('dispose：中止进行中的接收并清理临时文件', async () => {
        const chunks = toChunks('abort.bin', randomBytes(FILE_CHUNK_SIZE * 3), 'abort');
        receiver.handleChunk('peer-a', chunks[0]);
        await receiver.whenIdle();
        assert.strictEqual(receiver.listActive().length, 1);
        receiver.dispose();
        await receiver.whenIdle();
        assert.deepStrictEqual(fs.readdirSync(dir), []);
    });
});

suite('FileReceiver：清理遗留临时文件', () => {
    test('只删除超过期限且命名符合本接收器格式的 .part 文件', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-stale-'));
        try {
            const stale = path.join(dir, 'big.zip.0a1b2c3d.part');
            const fresh = path.join(dir, 'new.zip.deadbeef.part');
            const other = path.join(dir, 'notes.part');
            [stale, fresh, other].forEach(f => fs.writeFileSync(f, 'x'));
            const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
            fs.utimesSync(stale, old, old);
            fs.utimesSync(other, old, old);

            assert.strictEqual(cleanupStaleParts(dir, 24 * 3600 * 1000), 1);
            assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['new.zip.deadbeef.part', 'notes.part']);
            assert.strictEqual(cleanupStaleParts(path.join(dir, 'missing')), 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
