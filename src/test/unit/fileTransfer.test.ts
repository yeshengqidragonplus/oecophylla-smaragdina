import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileReceiveService } from '../../core/fileReceiveService';
import { FileReceiver } from '../../core/fileReceiver';
import { setConsoleEnabled } from '../../core/logger';
import { BusinessMessage, NetworkService, TransferTask } from '../../core/networkService';
import { skipWithoutLan } from './helpers';

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

interface Pair {
    a: NetworkService;
    b: NetworkService;
    /** A 眼中 B 的联系人 id */
    idB: string;
    dir: string;
}

suite('文件传输：发送流水线与落盘确认（端到端，环回）', () => {
    let pair: Pair;
    let service: FileReceiveService | undefined;
    const tmpFiles: string[] = [];

    suiteSetup(() => setConsoleEnabled(false));
    suiteTeardown(() => setConsoleEnabled(true));

    async function setupPair(withReceiver: boolean, resolveDir?: (dir: string) => string, ctx?: Mocha.Context): Promise<Pair> {
        if (ctx) {
            skipWithoutLan(ctx);
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oschat-xfer-'));
        const portA = randomBasePort();
        const a = new NetworkService();
        const b = new NetworkService();
        await a.start(portA);
        await b.start(portA + 2000);
        if (withReceiver) {
            const receiver = new FileReceiver({ resolveDir: () => (resolveDir ? resolveDir(dir) : dir), sweepIntervalMs: 1000 });
            service = new FileReceiveService(b, receiver);
        }
        // 等 A 通过发现得知 B 的身份与协议版本
        assert.ok(await waitFor(() => a.getPeers().some(p => p.port === portA + 2000 && p.status === 'online' && !!p.iid), 8000), 'A 没有发现 B');
        const idB = a.getPeers().find(p => p.port === portA + 2000)!.id;
        return { a, b, idB, dir };
    }

    function makeFile(size: number): { filePath: string; content: Buffer } {
        const content = crypto.randomBytes(size);
        const filePath = path.join(os.tmpdir(), `oschat-src-${crypto.randomBytes(4).toString('hex')}.bin`);
        fs.writeFileSync(filePath, content);
        tmpFiles.push(filePath);
        return { filePath, content };
    }

    teardown(() => {
        service?.dispose();
        service = undefined;
        if (pair) {
            pair.a.stop();
            pair.b.stop();
            fs.rmSync(pair.dir, { recursive: true, force: true });
        }
        tmpFiles.splice(0).forEach(f => fs.rmSync(f, { force: true }));
    });

    test('端到端：流水线发送 1.5MB 文件，接收端落盘后回 file_ack，内容一致，进度单调到 100', async function () {
        this.timeout(30_000);
        pair = await setupPair(true, undefined, this);
        const { filePath, content } = makeFile(1_500_000);
        const task = pair.a.createTransferTask(pair.idB, [], [{ name: 'big.bin', path: filePath, size: content.length }]);
        const progress: number[] = [];
        pair.a.on('transferTaskUpdated', (t: TransferTask) => progress.push(t.progress));

        await pair.a.executeTransferTask(task.id);

        assert.strictEqual(task.status, 'completed');
        assert.deepStrictEqual(fs.readFileSync(path.join(pair.dir, 'big.bin')), content);
        assert.deepStrictEqual(progress, [...progress].sort((x, y) => x - y));
        assert.strictEqual(progress[progress.length - 1], 100);
        assert.deepStrictEqual(fs.readdirSync(pair.dir), ['big.bin'], '不应残留 .part');
        assert.strictEqual((pair.a as unknown as { _ackWaiters: Map<string, unknown> })._ackWaiters.size, 0, '确认等待项应被清理');
    });

    test('0 字节文件端到端成功，接收端确实有这个文件（回归：旧实现发送端报成功、接收端没有文件）', async function () {
        this.timeout(20_000);
        pair = await setupPair(true, undefined, this);
        const { filePath } = makeFile(0);
        const task = pair.a.createTransferTask(pair.idB, [], [{ name: 'empty.txt', path: filePath, size: 0 }]);
        await pair.a.executeTransferTask(task.id);
        assert.strictEqual(fs.statSync(path.join(pair.dir, 'empty.txt')).size, 0);
    });

    test('接收端无法保存（目录不可用）：发送端收到 file_ack 失败并报出原因，而不是误报成功', async function () {
        this.timeout(20_000);
        pair = await setupPair(true, dir => {
            const blocker = path.join(dir, 'blocker');
            fs.writeFileSync(blocker, 'x');
            return path.join(blocker, 'sub');
        }, this);
        const { filePath, content } = makeFile(100_000);
        const task = pair.a.createTransferTask(pair.idB, [], [{ name: 'x.bin', path: filePath, size: content.length }]);
        await assert.rejects(() => pair.a.executeTransferTask(task.id), /对方没有成功保存「x\.bin」/);
        assert.strictEqual(task.status, 'failed');
    });

    test('接收端从未收到数据（如重启过）：发送端立即失败，不干等 30 秒确认超时', async function () {
        this.timeout(20_000);
        pair = await setupPair(true, undefined, this);
        // 模拟分块全部丢失：接收器丢弃所有分块，只剩 file_end 到达
        service!.receiver.handleChunk = () => undefined;
        const { filePath, content } = makeFile(100_000);
        const task = pair.a.createTransferTask(pair.idB, [], [{ name: 'lost.bin', path: filePath, size: content.length }]);
        const started = Date.now();
        await assert.rejects(() => pair.a.executeTransferTask(task.id), /没有收到该文件的数据/);
        assert.ok(Date.now() - started < 5000, `失败耗时 ${Date.now() - started}ms`);
    });

    test('旧版接收端（协议 < 3，不会回 file_ack）：发送端不等待确认，传输层确认即视为成功', async function () {
        this.timeout(20_000);
        pair = await setupPair(false, undefined, this);
        const received: BusinessMessage[] = [];
        pair.b.on('message', m => received.push(m));
        // 模拟旧版对端：把 B 的协议版本记为 2
        const rec = pair.a.registry.resolve(pair.idB)!;
        pair.a.registry.observe({ kind: 'ack', ip: rec.ip, port: rec.port, iid: rec.iid, proto: 2 });

        const { filePath, content } = makeFile(200_000);
        const task = pair.a.createTransferTask(pair.idB, [], [{ name: 'old.bin', path: filePath, size: content.length }]);
        const started = Date.now();
        await pair.a.executeTransferTask(task.id);
        assert.ok(Date.now() - started < 10_000);
        assert.strictEqual(task.status, 'completed');
        assert.ok(received.some(m => m.type === 'file'));
        assert.ok(!received.some(m => m.type === 'file_end'), '旧版对端不应收到 file_end');
    });

    test('取消：停止继续发送，任务状态为 cancelled', async function () {
        this.timeout(20_000);
        pair = await setupPair(true, undefined, this);
        const { filePath, content } = makeFile(5_000_000);
        const task = pair.a.createTransferTask(pair.idB, [], [{ name: 'cancel.bin', path: filePath, size: content.length }]);
        pair.a.on('transferTaskUpdated', (t: TransferTask) => {
            if (t.status === 'transferring') {
                pair.a.cancelTransferTask(t.id);
            }
        });
        await assert.rejects(() => pair.a.executeTransferTask(task.id), /已取消/);
        assert.strictEqual(task.status, 'cancelled');
        assert.strictEqual(pair.a.cancelTransferTask(task.id), false, '已结束的任务不能再取消');
    });

    test('待发送的文件被删除/不存在：给出可读提示', async function () {
        this.timeout(20_000);
        pair = await setupPair(true, undefined, this);
        const task = pair.a.createTransferTask(pair.idB, [], [{ name: 'gone.bin', path: path.join(pair.dir, 'nope.bin'), size: 10 }]);
        await assert.rejects(() => pair.a.executeTransferTask(task.id), /已被移动或删除/);
    });

    test('已结束超过 10 分钟的任务会被清理（回归：任务表原先只增不删）', async function () {
        this.timeout(20_000);
        pair = await setupPair(true, undefined, this);
        const old = pair.a.createTransferTask(pair.idB, ['x'], []);
        const internals = pair.a as unknown as { _transferTasks: Map<string, TransferTask> };
        old.status = 'completed';
        old.completedAt = Date.now() - 11 * 60 * 1000;
        const recent = pair.a.createTransferTask(pair.idB, ['y'], []);
        recent.status = 'completed';
        recent.completedAt = Date.now();
        pair.a.createTransferTask(pair.idB, ['z'], []);
        assert.ok(!internals._transferTasks.has(old.id));
        assert.ok(internals._transferTasks.has(recent.id));
    });
});
