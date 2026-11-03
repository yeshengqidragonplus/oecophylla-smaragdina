/**
 * 扩展 ↔ webview 的消息协议（类型化，两端共享）。
 *
 * 旧界面用字符串类型的 postMessage，消息名拼错、字段缺失只能在运行时发现；
 * 新界面两端都引用这里的类型，编译期即检查。约定：
 * - 界面加载完成后先发 `ready`，扩展回推完整的 `state`（不再靠定时器抢跑）；
 * - 之后扩展只推增量（`message` / `messageUpdate` / `contacts` / `status` / `unread`）；
 * - 界面不持有业务状态，只显示扩展推来的状态，用户操作一律以请求形式发回扩展。
 */

export type Presence = 'online' | 'oneway' | 'offline';

export interface NetworkStatusView {
    state: 'stopped' | 'starting' | 'running' | 'error';
    /** 本机地址与主端口，如 10.10.213.120:6688 */
    address: string;
    error?: string;
    /** 在线与单向可达的对端数 */
    online: number;
    oneway: number;
}

export interface ContactView {
    id: string;
    name: string;
    presence: Presence;
    /** 对端系统与版本，如 "darwin · v0.1.0"（旧版对端为空） */
    platform?: string;
    lastMessage?: { text: string; timestamp: number };
    unread: number;
}

export interface FileView {
    name: string;
    size: number;
    status: 'transferring' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    path?: string;
    error?: string;
}

export interface MessageView {
    id: string;
    direction: 'in' | 'out' | 'system';
    text: string;
    timestamp: number;
    status?: 'sending' | 'delivered' | 'failed';
    error?: string;
    file?: FileView;
}

export interface ConversationView {
    id: string;
    peerId: string;
    title: string;
    messages: MessageView[];
}

export interface ViewState {
    network: NetworkStatusView;
    contacts: ContactView[];
    /** 当前打开的会话；undefined 表示在联系人页 */
    conversation?: ConversationView;
}

/** 扩展 → 界面 */
export type ExtToWeb =
    | { type: 'state'; state: ViewState }
    | { type: 'status'; network: NetworkStatusView }
    | { type: 'contacts'; contacts: ContactView[] }
    | { type: 'conversation'; conversation: ConversationView | undefined }
    | { type: 'message'; conversationId: string; message: MessageView }
    | { type: 'messageUpdate'; conversationId: string; message: MessageView };

/** 界面 → 扩展 */
export type WebToExt =
    | { type: 'ready' }
    | { type: 'openConversation'; peerId: string }
    | { type: 'closeConversation' }
    | { type: 'send'; peerId: string; text: string }
    | { type: 'pickFiles'; peerId: string }
    | { type: 'retry'; conversationId: string; messageId: string }
    | { type: 'cancel'; messageId: string }
    | { type: 'openFile'; path: string }
    | { type: 'revealFile'; path: string }
    | { type: 'toggleNetwork' }
    | { type: 'addContact' }
    | { type: 'runDiagnose' };

/** 界面自己持久化的状态（vscode.getState / setState）：侧边栏被隐藏再显示时恢复，不丢草稿 */
export interface PersistedUiState {
    drafts: Record<string, string>;
}
