import * as assert from 'assert';
import { ContactView, ConversationView, MessageView, ViewState } from '../../shared/protocol';
import { describeNetwork, filterContacts, groupContacts, initialState, reduce, totalUnread } from '../../shared/viewState';

const contact = (overrides: Partial<ContactView>): ContactView => ({ id: 'c', name: 'C', presence: 'online', unread: 0, ...overrides });
const message = (overrides: Partial<MessageView>): MessageView => ({ id: 'm', direction: 'out', text: 't', timestamp: 1, ...overrides });
const conversation = (messages: MessageView[]): ConversationView => ({ id: 'conv1', peerId: 'p1', title: '甲', messages });

suite('viewState：界面状态归约', () => {
    test('state 消息整体替换；status / contacts 只更新对应部分', () => {
        let state = initialState();
        state = reduce(state, { type: 'state', state: { network: { state: 'running', address: '10.0.0.1:6688', online: 2, oneway: 0 }, contacts: [contact({ id: 'a' })] } });
        assert.strictEqual(state.network.state, 'running');
        state = reduce(state, { type: 'contacts', contacts: [contact({ id: 'b' }), contact({ id: 'c' })] });
        assert.deepStrictEqual(state.contacts.map(c => c.id), ['b', 'c']);
        assert.strictEqual(state.network.address, '10.0.0.1:6688');
        state = reduce(state, { type: 'status', network: { state: 'stopped', address: '', online: 0, oneway: 0 } });
        assert.strictEqual(state.network.state, 'stopped');
        assert.strictEqual(state.contacts.length, 2);
    });

    test('当前会话收到新消息追加、状态更新按 id 原地替换（不重复追加）', () => {
        let state: ViewState = { ...initialState(), conversation: conversation([message({ id: 'm1', status: 'sending' })]) };
        state = reduce(state, { type: 'message', conversationId: 'conv1', message: message({ id: 'm2', direction: 'in', text: '收到' }) });
        assert.deepStrictEqual(state.conversation!.messages.map(m => m.id), ['m1', 'm2']);
        state = reduce(state, { type: 'messageUpdate', conversationId: 'conv1', message: message({ id: 'm1', status: 'delivered' }) });
        assert.deepStrictEqual(state.conversation!.messages.map(m => [m.id, m.status]), [['m1', 'delivered'], ['m2', undefined]]);
    });

    test('别的会话的消息不影响当前打开的会话；没有打开会话时忽略', () => {
        const open: ViewState = { ...initialState(), conversation: conversation([]) };
        assert.strictEqual(reduce(open, { type: 'message', conversationId: 'other', message: message({}) }), open);
        const none = initialState();
        assert.strictEqual(reduce(none, { type: 'message', conversationId: 'conv1', message: message({}) }), none);
    });

    test('conversation 消息打开 / 关闭会话；状态不可变（返回新对象）', () => {
        const before = initialState();
        const opened = reduce(before, { type: 'conversation', conversation: conversation([]) });
        assert.notStrictEqual(opened, before);
        assert.strictEqual(before.conversation, undefined);
        assert.strictEqual(reduce(opened, { type: 'conversation', conversation: undefined }).conversation, undefined);
    });
});

suite('viewState：联系人分组、搜索与状态文案', () => {
    test('按 在线 → 单向可达 → 离线 分组，空组不出现', () => {
        const groups = groupContacts([
            contact({ id: '1', presence: 'offline', name: '丙' }),
            contact({ id: '2', presence: 'online', name: '甲' }),
            contact({ id: '3', presence: 'oneway', name: '乙' })
        ]);
        assert.deepStrictEqual(groups.map(g => g.presence), ['online', 'oneway', 'offline']);
        assert.deepStrictEqual(groupContacts([contact({ presence: 'online' })]).map(g => g.presence), ['online']);
    });

    test('组内排序：有未读的优先，其次最后消息时间倒序，再按名称', () => {
        const group = groupContacts([
            contact({ id: 'old', name: 'A', lastMessage: { text: 'x', timestamp: 100 } }),
            contact({ id: 'new', name: 'B', lastMessage: { text: 'x', timestamp: 200 } }),
            contact({ id: 'unread', name: 'C', unread: 2, lastMessage: { text: 'x', timestamp: 50 } }),
            contact({ id: 'none', name: 'D' })
        ])[0];
        assert.deepStrictEqual(group.contacts.map(c => c.id), ['unread', 'new', 'old', 'none']);
    });

    test('搜索：名称或平台，不区分大小写；空关键字返回全部', () => {
        const all = [contact({ id: '1', name: 'Arthur-Win', platform: 'win32 · v0.1.0' }), contact({ id: '2', name: '张三', platform: 'darwin' })];
        assert.deepStrictEqual(filterContacts(all, 'arthur').map(c => c.id), ['1']);
        assert.deepStrictEqual(filterContacts(all, 'DARWIN').map(c => c.id), ['2']);
        assert.strictEqual(filterContacts(all, '  ').length, 2);
        assert.strictEqual(filterContacts(all, '不存在').length, 0);
    });

    test('未读总数', () => {
        assert.strictEqual(totalUnread([contact({ unread: 2 }), contact({ unread: 3 }), contact({})]), 5);
    });

    test('状态条文案：运行中 / 单向可达警告 / 启动失败 / 未运行', () => {
        assert.deepStrictEqual(describeNetwork({ state: 'running', address: '10.0.0.1:6688', online: 3, oneway: 0 }), { text: '10.0.0.1:6688 · 在线 3', level: 'ok' });
        const warn = describeNetwork({ state: 'running', address: '10.0.0.1:6688', online: 1, oneway: 2 });
        assert.strictEqual(warn.level, 'warn');
        assert.ok(warn.text.includes('2 个单向可达'));
        assert.deepStrictEqual(describeNetwork({ state: 'error', address: '', online: 0, oneway: 0, error: 'EADDRINUSE' }), { text: '启动失败：EADDRINUSE', level: 'error' });
        assert.strictEqual(describeNetwork({ state: 'stopped', address: '', online: 0, oneway: 0 }).level, 'idle');
    });
});
