import * as assert from 'assert';
import { FILE_CHUNK_SIZE, MAX_FILE_SIZE, parseBusinessFrame, parsePresenceMessage } from '../../core/protocol';

const json = (value: unknown): string => JSON.stringify(value);

function fileFrame(overrides: Record<string, unknown> = {}, fileOverrides: Record<string, unknown> = {}): string {
    return json({
        type: 'file', from: 'x', timestamp: 1,
        file: { name: 'a.txt', size: 100, chunkIndex: 0, totalChunks: 1, data: 'aGVsbG8=', ...fileOverrides },
        ...overrides
    });
}

suite('protocol：UDP 发现/心跳消息校验', () => {
    test('合法的发现请求：保留头部与身份字段', () => {
        const result = parsePresenceMessage(json({
            type: 'discovery_request', from: '10.0.0.2', fromHostname: 'PC-A', fromNickname: '甲',
            timestamp: 5, transferPort: 7688, proto: 2, iid: 'm:6688', boot: 'ab12', meta: { os: 'darwin', version: '0.1.0' }
        }));
        assert.ok(result.ok);
        assert.strictEqual(result.msg.type, 'discovery_request');
        assert.strictEqual(result.msg.iid, 'm:6688');
        assert.strictEqual(result.msg.meta?.os, 'darwin');
        assert.strictEqual(result.msg.transferPort, 7688);
    });

    test('旧版消息（没有 proto/iid/boot/meta）同样合法', () => {
        const result = parsePresenceMessage(json({ type: 'heartbeat', from: '10.0.0.2', timestamp: 1 }));
        assert.ok(result.ok);
        assert.strictEqual(result.msg.iid, undefined);
    });

    test('拒绝：非 JSON、数组、未知类型、业务类型、字段类型错误', () => {
        assert.ok(!parsePresenceMessage('not json').ok);
        assert.ok(!parsePresenceMessage('[]').ok);
        assert.ok(!parsePresenceMessage(json({ type: 'whatever' })).ok);
        assert.ok(!parsePresenceMessage(json({ type: 'message', content: 'x' })).ok);
        assert.ok(!parsePresenceMessage(json({ type: 'heartbeat', fromHostname: 123 })).ok);
        assert.ok(!parsePresenceMessage(json({ type: 'heartbeat', transferPort: 70000 })).ok);
        assert.ok(!parsePresenceMessage(json({ type: 'heartbeat', fromNickname: 'x'.repeat(101) })).ok);
        assert.ok(!parsePresenceMessage(json({ type: 'heartbeat', meta: 'bad' })).ok);
    });
});

suite('protocol：KCP 业务帧校验', () => {
    test('合法的文本消息', () => {
        const result = parseBusinessFrame(json({ type: 'message', id: 'u1', content: '你好', from: 'x', timestamp: 1 }));
        assert.ok(result.ok && result.msg.type === 'message');
        assert.strictEqual(result.msg.content, '你好');
        assert.strictEqual(result.msg.id, 'u1');
    });

    test('文本消息缺少 content、过长、id 非法时被拒绝', () => {
        assert.ok(!parseBusinessFrame(json({ type: 'message' })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'message', content: 'x'.repeat(1_000_001) })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'message', content: 'x', id: 5 })).ok);
    });

    test('合法的文件分块（旧版发送方不带 chunkSize / transferId）', () => {
        const result = parseBusinessFrame(fileFrame());
        assert.ok(result.ok && result.msg.type === 'file');
        assert.strictEqual(result.msg.file.chunkSize, undefined);
        assert.strictEqual(result.msg.file.transferId, undefined);
    });

    test('0 字节文件：totalChunks 为 1，空数据串合法', () => {
        const result = parseBusinessFrame(fileFrame({}, { size: 0, data: '', totalChunks: 1 }));
        assert.ok(result.ok);
    });

    test('totalChunks 必须与文件大小一致：拒绝用超大 totalChunks 撑爆内存的畸形帧', () => {
        assert.ok(!parseBusinessFrame(fileFrame({}, { size: 100, totalChunks: 1_000_000_000 })).ok);
        assert.ok(!parseBusinessFrame(fileFrame({}, { size: FILE_CHUNK_SIZE * 3, totalChunks: 2 })).ok);
        assert.ok(parseBusinessFrame(fileFrame({}, { size: FILE_CHUNK_SIZE * 3, totalChunks: 3, chunkIndex: 2 })).ok);
    });

    test('size 超过上限、chunkIndex 越界、chunkSize 非法、分块数据过长都被拒绝', () => {
        assert.ok(!parseBusinessFrame(fileFrame({}, { size: MAX_FILE_SIZE + 1, totalChunks: 1 })).ok);
        assert.ok(!parseBusinessFrame(fileFrame({}, { chunkIndex: 1 })).ok);
        assert.ok(!parseBusinessFrame(fileFrame({}, { chunkIndex: -1 })).ok);
        assert.ok(!parseBusinessFrame(fileFrame({}, { chunkSize: 10 })).ok);
        assert.ok(!parseBusinessFrame(fileFrame({}, { data: 'A'.repeat(FILE_CHUNK_SIZE * 2) })).ok);
    });

    test('文件名缺失/过长、size 不是整数被拒绝；带 transferId 与 chunkSize 的新版分块合法', () => {
        assert.ok(!parseBusinessFrame(fileFrame({}, { name: '' })).ok);
        assert.ok(!parseBusinessFrame(fileFrame({}, { name: 'x'.repeat(513) })).ok);
        assert.ok(!parseBusinessFrame(fileFrame({}, { size: 1.5 })).ok);
        const ok = parseBusinessFrame(fileFrame({}, { transferId: 't-1', chunkSize: FILE_CHUNK_SIZE }));
        assert.ok(ok.ok && ok.msg.type === 'file' && ok.msg.file.transferId === 't-1');
    });

    test('未知业务类型与发现/心跳类型都不是业务帧', () => {
        assert.ok(!parseBusinessFrame(json({ type: 'heartbeat' })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'nope' })).ok);
        assert.ok(!parseBusinessFrame('{').ok);
    });
});

suite('protocol：文件收尾与落盘确认', () => {
    test('合法的 file_end 与 file_ack', () => {
        const end = parseBusinessFrame(json({ type: 'file_end', transferId: 't1', name: 'a.bin', size: 10, totalChunks: 1 }));
        assert.ok(end.ok && end.msg.type === 'file_end' && end.msg.transferId === 't1');
        const ok = parseBusinessFrame(json({ type: 'file_ack', transferId: 't1', ok: true }));
        assert.ok(ok.ok && ok.msg.type === 'file_ack' && ok.msg.ok === true);
        const fail = parseBusinessFrame(json({ type: 'file_ack', transferId: 't1', ok: false, reason: '磁盘空间不足' }));
        assert.ok(fail.ok && fail.msg.type === 'file_ack' && fail.msg.reason === '磁盘空间不足');
    });

    test('file_end / file_ack 字段缺失或非法被拒绝', () => {
        assert.ok(!parseBusinessFrame(json({ type: 'file_end', name: 'a', size: 1, totalChunks: 1 })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'file_end', transferId: 't', name: 'a', size: -1, totalChunks: 1 })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'file_end', transferId: 't', name: 'a', size: 1, totalChunks: 0 })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'file_ack', transferId: 't', ok: 'yes' })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'file_ack', transferId: '', ok: true })).ok);
        assert.ok(!parseBusinessFrame(json({ type: 'file_ack', transferId: 't', ok: false, reason: 'x'.repeat(501) })).ok);
    });
});
