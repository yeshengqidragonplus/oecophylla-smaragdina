/**
 * "编辑聊天对象"面板的页面：不依赖 vscode，便于单测。
 *
 * 两条硬约束（VS Code 的 webview 就是这样）：
 * - CSP 只放行带 nonce 的脚本，所以不能写 onclick= 这类内联事件，按钮一律事件委托；
 * - webview 是没有 allow-modals 的沙箱 iframe，confirm / alert / prompt 会被直接忽略，
 *   确认类交互要发消息给扩展，用 vscode.window.showWarningMessage。
 */

/** 页面需要的对端字段（界面展示用，不含内部状态） */
export interface EditorPeer {
    id: string;
    hostname: string;
    nickname?: string;
    ip: string;
    port: number;
    lastSeen: number;
    status: 'online' | 'oneway' | 'offline';
}

export interface PeersEditorHtmlOptions {
    cspSource: string;
    nonce: string;
    peers: EditorPeer[];
}

/** 放进 <script type="application/json"> 的数据：转义 "<"，防止主机名里的 </script> 提前结束数据块 */
function embedJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

const STYLE = `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }
        h1 {
            font-size: 20px;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .toolbar { display: flex; gap: 10px; margin-bottom: 20px; }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover { background-color: var(--vscode-button-hoverBackground); }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        .btn-danger {
            background-color: var(--vscode-errorForeground);
            color: white;
        }
        .btn-danger:hover { opacity: 0.8; }
        .btn-small { padding: 4px 8px; font-size: 12px; }
        .peers-table { width: 100%; border-collapse: collapse; }
        .peers-table th,
        .peers-table td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .peers-table th {
            font-weight: 600;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        .peers-table tr:hover { background-color: var(--vscode-list-hoverBackground); }
        .status-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 6px;
        }
        .status-online { background-color: #4caf50; }
        .status-oneway { background-color: #e2b93d; }
        .status-offline { background-color: #9e9e9e; }
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        .modal-overlay.visible { display: flex; }
        .modal {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 20px;
            min-width: 400px;
            max-width: 500px;
        }
        .modal h2 { font-size: 16px; margin-bottom: 16px; }
        .form-group { margin-bottom: 16px; }
        .form-group label { display: block; margin-bottom: 6px; font-weight: 500; }
        .form-group input {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: inherit;
        }
        .form-group input:focus { outline: 1px solid var(--vscode-focusBorder); }
        .form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
        .empty-state { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
        .actions { display: flex; gap: 6px; }
`;

/**
 * 页面脚本：表格由数据在页面里用 DOM API 生成（textContent，主机名等不会被当成 HTML），
 * 编辑 / 删除按钮用事件委托。里面不能出现反引号和美元花括号（外层是模板字符串）。
 */
const SCRIPT = `
(function () {
    const vscode = acquireVsCodeApi();
    let peers = JSON.parse(document.getElementById('peers-data').textContent || '[]');
    const content = document.getElementById('content');
    const modalOverlay = document.getElementById('modalOverlay');

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function statusText(status) {
        return status === 'online' ? '在线' : status === 'oneway' ? '单向（可能被防火墙拦截）' : '离线';
    }

    function formatTime(timestamp) {
        const diff = Date.now() - timestamp;
        if (diff < 60000) {
            return '刚刚';
        } else if (diff < 3600000) {
            return Math.floor(diff / 60000) + '分钟前';
        } else if (diff < 86400000) {
            return Math.floor(diff / 3600000) + '小时前';
        }
        return new Date(timestamp).toLocaleDateString('zh-CN');
    }

    function actionButton(label, className, action, id) {
        const button = el('button', 'btn btn-small ' + className, label);
        button.type = 'button';
        button.dataset.action = action;
        button.dataset.id = id;
        return button;
    }

    function renderTable() {
        content.textContent = '';
        if (peers.length === 0) {
            const empty = el('div', 'empty-state');
            empty.appendChild(el('p', '', '暂无聊天对象'));
            empty.appendChild(el('p', '', '点击“添加聊天对象”按钮添加新的通信目标'));
            content.appendChild(empty);
            return;
        }

        const table = el('table', 'peers-table');
        const thead = el('thead');
        const headRow = el('tr');
        ['状态', '主机名', '昵称', 'IP 地址', '端口', '最后在线', '操作'].forEach(function (title) {
            headRow.appendChild(el('th', '', title));
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = el('tbody');
        peers.forEach(function (peer) {
            const row = el('tr');

            const statusCell = el('td');
            const known = peer.status === 'online' || peer.status === 'oneway' ? peer.status : 'offline';
            statusCell.appendChild(el('span', 'status-indicator status-' + known));
            statusCell.appendChild(document.createTextNode(statusText(peer.status)));
            row.appendChild(statusCell);

            row.appendChild(el('td', '', peer.hostname));
            row.appendChild(el('td', '', peer.nickname ? peer.nickname : '-'));
            row.appendChild(el('td', '', peer.ip));
            row.appendChild(el('td', '', String(peer.port)));
            row.appendChild(el('td', '', formatTime(peer.lastSeen)));

            const actionsCell = el('td');
            const actions = el('div', 'actions');
            actions.appendChild(actionButton('编辑', 'btn-secondary', 'edit', peer.id));
            actions.appendChild(actionButton('删除', 'btn-danger', 'delete', peer.id));
            actionsCell.appendChild(actions);
            row.appendChild(actionsCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        content.appendChild(table);
    }

    function openModal(peer) {
        document.getElementById('modalTitle').textContent = peer ? '编辑聊天对象' : '添加聊天对象';
        document.getElementById('peerId').value = peer ? peer.id : '';
        document.getElementById('hostname').value = peer ? peer.hostname : '';
        document.getElementById('nickname').value = peer && peer.nickname ? peer.nickname : '';
        document.getElementById('ip').value = peer ? peer.ip : '';
        document.getElementById('port').value = peer ? peer.port : '';
        modalOverlay.classList.add('visible');
    }

    function closeModal() {
        modalOverlay.classList.remove('visible');
    }

    // 编辑 / 删除：事件委托。删除不在页面里确认——webview 的沙箱会忽略页面内的确认框，
    // 由扩展弹出确认框。
    content.addEventListener('click', function (event) {
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!button) {
            return;
        }
        const id = button.dataset.id;
        if (button.dataset.action === 'edit') {
            const peer = peers.find(function (p) { return p.id === id; });
            if (peer) {
                openModal(peer);
            }
        } else if (button.dataset.action === 'delete') {
            vscode.postMessage({ type: 'deletePeer', id: id });
        }
    });

    document.getElementById('addBtn').addEventListener('click', function () { openModal(null); });
    document.getElementById('refreshBtn').addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('cancelBtn').addEventListener('click', closeModal);

    document.getElementById('peerForm').addEventListener('submit', function (event) {
        event.preventDefault();
        const peerId = document.getElementById('peerId').value;
        const peer = {
            hostname: document.getElementById('hostname').value,
            nickname: document.getElementById('nickname').value || undefined,
            ip: document.getElementById('ip').value,
            port: parseInt(document.getElementById('port').value, 10)
        };
        if (peerId) {
            peer.id = peerId;
            vscode.postMessage({ type: 'updatePeer', peer: peer });
        } else {
            vscode.postMessage({ type: 'addPeer', peer: peer });
        }
        closeModal();
    });

    window.addEventListener('message', function (event) {
        const message = event.data;
        if (message && message.type === 'update') {
            peers = message.peers;
            renderTable();
        }
    });

    renderTable();
})();
`;

export function buildPeersEditorHtml(options: PeersEditorHtmlOptions): string {
    const { cspSource, nonce, peers } = options;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>编辑聊天对象</title>
    <style>${STYLE}</style>
</head>
<body>
    <h1>📝 编辑聊天对象</h1>

    <div class="toolbar">
        <button class="btn btn-primary" id="addBtn">➕ 添加聊天对象</button>
        <button class="btn btn-secondary" id="refreshBtn">🔄 刷新</button>
    </div>

    <div id="content"></div>

    <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
            <h2 id="modalTitle">添加聊天对象</h2>
            <form id="peerForm">
                <input type="hidden" id="peerId">
                <div class="form-group">
                    <label for="hostname">主机名 *</label>
                    <input type="text" id="hostname" required placeholder="例如：Work-PC">
                </div>
                <div class="form-group">
                    <label for="nickname">昵称</label>
                    <input type="text" id="nickname" placeholder="可选，例如：张三">
                </div>
                <div class="form-group">
                    <label for="ip">IP 地址 *</label>
                    <input type="text" id="ip" required placeholder="例如：192.168.1.100">
                </div>
                <div class="form-group">
                    <label for="port">端口 *</label>
                    <input type="number" id="port" required min="1" max="65535" placeholder="例如：8080">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" id="cancelBtn">取消</button>
                    <button type="submit" class="btn btn-primary">保存</button>
                </div>
            </form>
        </div>
    </div>

    <script type="application/json" id="peers-data">${embedJson(peers)}</script>
    <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
