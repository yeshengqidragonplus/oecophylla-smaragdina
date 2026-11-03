import { useEffect, useMemo, useReducer, useState } from 'preact/hooks';
import { ContactView, ExtToWeb, Presence } from '../shared/protocol';
import { describeNetwork, filterContacts, groupContacts, initialState, reduce } from '../shared/viewState';
import { post } from './vscode';

const GROUP_TITLE: Record<Presence, string> = { online: '在线', oneway: '单向可达', offline: '离线' };
const PRESENCE_ICON: Record<Presence, string> = {
    online: 'codicon-circle-filled presence-online',
    oneway: 'codicon-warning presence-oneway',
    offline: 'codicon-circle-outline presence-offline'
};

function StatusBar({ network }: { network: ReturnType<typeof initialState>['network'] }) {
    const status = describeNetwork(network);
    const running = network.state === 'running' || network.state === 'starting';
    return (
        <div class={`status-bar status-${status.level}`}>
            <span class="status-text" title={status.text}>{status.text}</span>
            <button class="icon-button" title={running ? '停止网络服务' : '启动网络服务'} onClick={() => post({ type: 'toggleNetwork' })}>
                <span class={`codicon ${running ? 'codicon-debug-stop' : 'codicon-play'}`} />
            </button>
        </div>
    );
}

function ContactRow({ contact }: { contact: ContactView }) {
    return (
        <button class="contact" onClick={() => post({ type: 'openConversation', peerId: contact.id })}>
            <span class={`codicon ${PRESENCE_ICON[contact.presence]}`} />
            <span class="contact-main">
                <span class="contact-name">{contact.name}</span>
                {contact.lastMessage && <span class="contact-preview">{contact.lastMessage.text}</span>}
            </span>
            {contact.unread > 0 && <span class="badge">{contact.unread}</span>}
        </button>
    );
}

/**
 * 联系人页（M3 会在此基础上加会话页、消息气泡、文件卡片等）。
 * 组件只渲染 reduce 产出的状态；所有逻辑在 shared/viewState，已有单测。
 */
export function App() {
    const [state, dispatch] = useReducer(reduce, undefined, initialState);
    const [query, setQuery] = useState('');

    useEffect(() => {
        const onMessage = (event: MessageEvent<ExtToWeb>): void => dispatch(event.data);
        window.addEventListener('message', onMessage);
        post({ type: 'ready' }); // 先监听、再通知扩展：扩展收到 ready 后回推完整状态
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const groups = useMemo(() => groupContacts(filterContacts(state.contacts, query)), [state.contacts, query]);

    return (
        <div class="app">
            <StatusBar network={state.network} />
            <input
                class="search"
                type="search"
                placeholder="搜索联系人"
                value={query}
                onInput={event => setQuery((event.target as HTMLInputElement).value)}
            />
            {groups.length === 0 && (
                <div class="empty">
                    {state.contacts.length === 0 ? '还没有联系人。网络服务运行后会自动发现同网段的对方，也可以手动添加。' : '没有匹配的联系人'}
                </div>
            )}
            {groups.map(group => (
                <section key={group.presence}>
                    <h2 class="group-title">{GROUP_TITLE[group.presence]}（{group.contacts.length}）</h2>
                    {group.contacts.map(contact => <ContactRow key={contact.id} contact={contact} />)}
                </section>
            ))}
            <div class="toolbar">
                <button class="link-button" onClick={() => post({ type: 'addContact' })}>＋ 添加联系人</button>
                <button class="link-button" onClick={() => post({ type: 'runDiagnose' })}>运行诊断</button>
            </div>
        </div>
    );
}
