import * as assert from 'assert';
import { Conversation, StoredMessage } from '../../core/chatStore';
import { describeMessage, formatFileSize, sessionStatus, toLegacySession } from '../../legacyChatAdapter';

function msg(overrides: Partial<StoredMessage>): StoredMessage {
    return { id: 'm', direction: 'out', text: '', timestamp: 1, ...overrides };
}

function conv(messages: StoredMessage[]): Conversation {
    return { id: 'c1', peerId: 'p1', title: 'Arthur-Win', messages, lastUpdated: 5, unread: 0 };
}

suite('legacyChatAdapter：会话到旧界面的投影', () => {
    test('文件大小格式化', () => {
        assert.strictEqual(formatFileSize(10), '10 B');
        assert.strictEqual(formatFileSize(2048), '2.00 KB');
        assert.strictEqual(formatFileSize(3 * 1024 * 1024), '3.00 MB');
        assert.strictEqual(formatFileSize(5 * 1024 ** 3), '5.00 GB');
    });

    test('收到的文本不再带"📨 来自 X:"前缀；方向映射为 user / assistant / system', () => {
        const session = toLegacySession(conv([
            msg({ id: 'a', direction: 'out', text: '我发的', status: 'delivered' }),
            msg({ id: 'b', direction: 'in', text: '对方发的' }),
            msg({ id: 'c', direction: 'system', text: '提示' })
        ]));
        assert.deepStrictEqual(session.messages.map(m => [m.type, m.content]), [['user', '我发的'], ['assistant', '对方发的'], ['system', '提示']]);
    });

    test('只发文件时气泡有内容（回归：旧界面是空气泡）', () => {
        const text = describeMessage(msg({ file: { name: 'report.xlsx', size: 2_400_000, status: 'completed', progress: 100 }, status: 'delivered' }));
        assert.ok(text.includes('📎 report.xlsx（2.29 MB）') && text.includes('✅ 已发送'));
    });

    test('文件的各种状态：传输中带进度、接收完成带保存位置、失败带原因、取消', () => {
        const file = (status: 'transferring' | 'completed' | 'failed' | 'cancelled', extra = {}) =>
            ({ name: 'a.bin', size: 100, status, progress: 40, ...extra });
        assert.ok(describeMessage(msg({ direction: 'in', file: file('transferring') })).includes('接收中 40%'));
        assert.ok(describeMessage(msg({ direction: 'out', file: file('transferring') })).includes('发送中 40%'));
        assert.ok(describeMessage(msg({ direction: 'in', file: file('completed', { path: '/d/a.bin' }) })).includes('已保存：/d/a.bin'));
        assert.ok(describeMessage(msg({ direction: 'out', file: file('failed', { error: '磁盘空间不足' }) })).includes('发送失败：磁盘空间不足'));
        assert.ok(describeMessage(msg({ direction: 'out', file: file('cancelled') })).includes('已取消'));
    });

    test('文本发送中 / 失败显示状态与原因', () => {
        assert.ok(describeMessage(msg({ text: '你好', status: 'sending' })).includes('发送中'));
        const failed = describeMessage(msg({ text: '你好', status: 'failed', error: '连接失败' }));
        assert.ok(failed.startsWith('你好') && failed.includes('发送失败：连接失败'));
    });

    test('会话状态点：传输中 / 最近发出的消息失败 / 发送中 / 正常（传输中与失败不再同色由界面决定，这里只给出语义）', () => {
        assert.strictEqual(sessionStatus(conv([msg({ file: { name: 'a', size: 1, status: 'transferring', progress: 30 } })])).transferStatus, 'transferring');
        assert.strictEqual(sessionStatus(conv([msg({ status: 'delivered' }), msg({ status: 'failed' })])).transferStatus, 'failed');
        assert.strictEqual(sessionStatus(conv([msg({ status: 'sending' })])).transferStatus, 'pending');
        assert.strictEqual(sessionStatus(conv([msg({ status: 'failed' }), msg({ status: 'delivered' })])).transferStatus, 'completed');
        assert.strictEqual(sessionStatus(conv([])).transferStatus, 'completed');
    });

    test('会话标题用联系人名称，peerName 与 title 一致', () => {
        const session = toLegacySession(conv([]));
        assert.strictEqual(session.peerName, 'Arthur-Win');
        assert.strictEqual(session.title, 'Arthur-Win');
    });
});
