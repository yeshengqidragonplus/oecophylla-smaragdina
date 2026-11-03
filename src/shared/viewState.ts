import { ContactView, ExtToWeb, MessageView, NetworkStatusView, Presence, ViewState } from './protocol';

/**
 * 界面状态的归约（纯函数，不依赖 DOM / vscode）：把扩展推来的消息应用到当前状态。
 * 界面组件只负责渲染这里产出的状态，逻辑集中在这里，便于单测。
 */

export const INITIAL_NETWORK: NetworkStatusView = { state: 'stopped', address: '', online: 0, oneway: 0 };

export function initialState(): ViewState {
    return { network: INITIAL_NETWORK, contacts: [] };
}

function upsertMessage(messages: MessageView[], message: MessageView): MessageView[] {
    const index = messages.findIndex(m => m.id === message.id);
    if (index < 0) {
        return [...messages, message];
    }
    const next = messages.slice();
    next[index] = message;
    return next;
}

export function reduce(state: ViewState, msg: ExtToWeb): ViewState {
    switch (msg.type) {
        case 'state':
            return msg.state;
        case 'status':
            return { ...state, network: msg.network };
        case 'contacts':
            return { ...state, contacts: msg.contacts };
        case 'conversation':
            return { ...state, conversation: msg.conversation };
        case 'message':
        case 'messageUpdate':
            // 只应用到当前打开的会话；别的会话的变化体现在联系人列表的最后一条消息与未读数上
            if (!state.conversation || state.conversation.id !== msg.conversationId) {
                return state;
            }
            return {
                ...state,
                conversation: { ...state.conversation, messages: upsertMessage(state.conversation.messages, msg.message) }
            };
    }
}

const GROUP_ORDER: Presence[] = ['online', 'oneway', 'offline'];

export interface ContactGroup {
    presence: Presence;
    contacts: ContactView[];
}

/** 联系人按在线状态分组（在线 → 单向可达 → 离线），组内有未读的优先，其次按最后一条消息时间倒序，再按名称 */
export function groupContacts(contacts: ContactView[]): ContactGroup[] {
    return GROUP_ORDER
        .map(presence => ({
            presence,
            contacts: contacts
                .filter(c => c.presence === presence)
                .sort((a, b) =>
                    Number(b.unread > 0) - Number(a.unread > 0)
                    || (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0)
                    || a.name.localeCompare(b.name))
        }))
        .filter(group => group.contacts.length > 0);
}

/** 联系人搜索：名称或平台包含关键字（不区分大小写） */
export function filterContacts(contacts: ContactView[], query: string): ContactView[] {
    const q = query.trim().toLowerCase();
    if (!q) {
        return contacts;
    }
    return contacts.filter(c => c.name.toLowerCase().includes(q) || (c.platform ?? '').toLowerCase().includes(q));
}

/** 所有会话的未读总数（活动栏徽标） */
export function totalUnread(contacts: ContactView[]): number {
    return contacts.reduce((sum, c) => sum + c.unread, 0);
}

/** 状态条文案：运行中显示在线人数，单向可达时给出提示，失败显示原因 */
export function describeNetwork(network: NetworkStatusView): { text: string; level: 'ok' | 'warn' | 'error' | 'idle' } {
    switch (network.state) {
        case 'running':
            return network.oneway > 0
                ? { text: `${network.address} · 在线 ${network.online} · ${network.oneway} 个单向可达`, level: 'warn' }
                : { text: `${network.address} · 在线 ${network.online}`, level: 'ok' };
        case 'starting':
            return { text: '正在启动网络服务…', level: 'idle' };
        case 'error':
            return { text: `启动失败：${network.error ?? '未知原因'}`, level: 'error' };
        default:
            return { text: '网络服务未运行', level: 'idle' };
    }
}
