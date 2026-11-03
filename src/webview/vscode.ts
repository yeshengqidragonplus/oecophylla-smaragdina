import { PersistedUiState, WebToExt } from '../shared/protocol';

/** VS Code 注入给 webview 的 API（只声明用到的部分） */
interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

/** 向扩展发请求：类型化，字段缺失或消息名拼错在编译期报错 */
export function post(message: WebToExt): void {
    api.postMessage(message);
}

/** 侧边栏被隐藏再显示时恢复界面状态（如未发送的草稿） */
export function loadUiState(): PersistedUiState {
    const saved = api.getState() as Partial<PersistedUiState> | undefined;
    return { drafts: saved?.drafts ?? {} };
}

export function saveUiState(state: PersistedUiState): void {
    api.setState(state);
}
