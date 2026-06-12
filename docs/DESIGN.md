# Oecophylla smaragdina 设计文档

> 一个面向小型局域网（内网）的 VS Code 聊天插件：侧边栏聊天界面，支持点对点文本消息与文件传输，无需任何中心服务器。

本文档描述当前实现的整体设计与关键决策，与代码保持同步。开发约定与命令速查见 [CLAUDE.md](../CLAUDE.md)。

## 1. 目标与非目标

### 目标

- 同一局域网内多台机器（以及同一台机器上的多个 VS Code 实例）互相**自动发现**
- 点对点**文本消息**与**文件传输**，文件传输有真实进度反馈
- 在线/离线状态实时可见
- 零配置可用（默认端口 + 自动发现），同时允许手工维护聊天对象列表
- 不依赖任何外部服务器或原生模块（纯 Node 内置 API，避免 C++ 工具链依赖）

### 非目标

- 不做加密与身份认证（信任内网环境，见 §8 安全考量）
- 不做消息持久化历史/漫游（消息只存在于当次会话内存中）
- 不做 NAT 穿透 / 公网通信
- 不做群聊（仅一对一会话）

## 2. 总体架构

### 2.1 双通道网络模型（核心设计）

每个实例使用两类 UDP 通道，职责严格分离：发现/心跳走裸 UDP，业务消息走 KCP（可靠 UDP）：

```
                ┌─────────────────────────── 实例 A ───────────────────────────┐
                │                                                              │
 广播/单播      │  UDP 主 socket（oschat.port，默认 8080）                      │
 ◄────────────► │    · 发心跳 / 收 heartbeat、heartbeat_ack、discovery_response │
                │  UDP 共享发现 socket（固定 41320，reuseAddr）                  │
 广播 ◄──────── │    · 仅收 discovery_request（同机多实例都能收到广播）           │
                │                                                              │
 可靠流(KCP)    │  KCP 服务（专用 UDP 端口 = 主端口 + 1000，KcpTransport）        │
 ◄────────────► │    · 所有业务消息：聊天文本、文件分块                           │
                │                                                              │
                └──────────────────────────────────────────────────────────────┘
```

- **UDP 只负责"谁在线"**：广播发现、心跳、在线/离线判定。UDP 不可靠没关系——丢一两个心跳不影响正确性。
- **KCP 负责"说什么"**：聊天消息和文件全部走 KCP（`src/kcp.ts`，ikcp.c 的纯 TypeScript 移植：选择重传、快速重传、RTO、滑动窗口、拥塞控制）。可靠、有序、自带流控，文件分块无需自己实现重传。
- 身份标识 **peerId = `ip:主UDP端口`**。KCP 端口不直接参与身份，通过 UDP 消息的 `transferPort` 字段告知对端（默认为主端口 + 1000）。

> 历史决策：早期版本使用 kcpjs 库承载业务消息，但 kcpjs 依赖原生模块（需要 C++ 工具链编译），一度替换为 Node 内置 `net`（TCP）。现按 UDP+KCP 的预期架构回归，KCP 协议改为项目内纯 TypeScript 实现（`src/kcp.ts`，零原生依赖），不再有编译问题。

### 2.2 模块与数据流

```
                        ┌────────────────┐
   网络事件（EventEmitter）│ networkService │◄──── KcpTransport（由它创建并持有）
                        └───────┬────────┘
                                │ peersUpdate / message / transferTask*
                                ▼
                        ┌────────────────┐
                        │  extension.ts  │  入口：注册 myChat.* 命令、桥接事件
                        └───┬────────┬───┘
                            │        │
              updatePeer()  ▼        ▼  refresh() / 收消息入会话
                   ┌──────────────┐ ┌──────────────────┐
                   │ PeersManager │ │ ChatViewProvider │──postMessage──► Webview UI
                   │ (peers.json) │ │  (侧边栏视图)      │
                   └──────────────┘ └──────────────────┘
```

| 模块 | 职责 |
|---|---|
| `src/networkService.ts` | 模块级单例（`export const networkService`），EventEmitter。UDP 发现/心跳、peer 表维护、传输任务（TransferTask）编排、文件分块发送 |
| `src/kcp.ts` | KCP 协议核心（ikcp.c 纯 TS 移植，ARQ，无 FEC，零依赖） |
| `src/kcpTransport.ts` | KCP 业务通道：专用 UDP socket、SYN/ACK 握手、conv 路由、帧编解码、会话表（peerId → KCP 会话） |
| `src/extension.ts` | 插件入口：注册 `myChat.*` 命令、把 networkService 事件接到 PeersManager 与 ChatViewProvider、按 `oschat.autoConnect` 自动启动 |
| `src/chatViewProvider.ts` | 侧边栏 Webview（视图 ID `OSChatView`）：会话/消息管理、文件接收重组与进度、HTML 界面内联生成 |
| `src/peersManager.ts` | 聊天对象持久化（peers.json，带写盘防抖） |
| `src/peersEditor.ts` / `src/settingsPanel.ts` | peers 编辑、设置的独立 Webview 面板 |

## 3. 线上协议

所有线上消息（裸 UDP 与 KCP）共用 `NetworkMessage` 接口，JSON 编码，`type` 字段区分：

| type | 通道 | 用途 |
|---|---|---|
| `discovery_request` | UDP 广播 → 41320 | 发现请求（携带本端 hostname/nickname/transferPort） |
| `discovery_response` | UDP 单播 → 请求方主端口 | 发现应答 |
| `heartbeat` / `heartbeat_ack` | UDP 单播 | 心跳与确认，维护在线状态 |
| `message` | KCP | 聊天文本（`content` 字段） |
| `file` | KCP | 文件分块（`file.{name,size,chunkIndex,totalChunks,data(base64)}`） |

### 3.1 自动发现

1. 启动时及之后每 **60 秒**，从 UDP 主 socket 向 `255.255.255.255:41320` 和子网广播地址发送 `discovery_request`。源端口即本端主端口，对方据此知道往哪回复。
2. 所有实例都以 `reuseAddr` 共同绑定固定发现端口 **41320**——广播包会投递给同一端口的所有绑定者，因此**同一台机器上主端口不同的多个实例也能互相发现**（这是引入共享发现端口的原因；绑定失败不致命，只是无法被广播发现）。
3. 收到请求方单播 `discovery_response` 回请求方主端口，双方据此互相登记/刷新 peer。

自消息过滤：比较 **IP + 端口**（`_isSelf`），只比较 IP 会误杀同机其他实例。

### 3.2 心跳与在线判定

- 每 **30 秒**向在线（或刚离线不久）的 peer 单播 `heartbeat`，对方回 `heartbeat_ack`；任何 UDP 消息到达都会刷新该 peer 的 `lastSeen` 并置为在线。
- 超过 **90 秒**未见任何消息 → 标记离线，触发 `peersUpdate`。
- KCP 会话成功建立（`sessionConnected`）同样会把离线 peer 拉回在线——握手成功本身就是在线证明。

### 3.3 KCP 会话与帧协议

- **数据报分型**：KCP 专用 UDP 端口上的每个数据报以 1 字节前缀区分——`0x01` 控制报文（JSON：`syn`/`ack`/`fin`），`0x02` KCP 报文（按 conv 路由到会话）。
- **握手即身份**：发起方选随机 32 位 conv，发送 `{"t":"syn","conv":N,"id":"<发起方peerId>"}`，每 500ms 重发直至收到 `ack`（默认 5 秒超时）。握手自带 peerId，无需单独身份帧。
- **双向同时建连仲裁**：A、B 可能同时向对方发起握手，产生两个冗余会话。约定 **发起方 peerId 字典序较小的会话胜出**，另一个销毁。双方独立执行此规则得到一致结果。
- **帧格式**：KCP 可靠字节流之上，4 字节大端长度前缀 + JSON 负载。接收侧按前缀拆帧；单帧上限 64 MB，超限直接断会话防内存攻击。
- **发送确认**：与 TCP 不同，KCP 入队即"成功"，因此 `send()` 等待发送队列被对端 ACK 清空才完成；确认无进展超过 5 秒 → 判定对端离线，销毁会话并报错（快速失败）。另有在途段数背压上限与 KCP 死链（单段重传 20 次）检测。
- **在线检测即握手**：发送前不做额外探测，握手（5 秒超时）失败即视为对方不在线。
- **KCP 参数**：极速模式（nodelay=1、10ms 时钟、快速重传阈值 2、关闭拥塞控制——内网场景），收发窗口 256。空闲超过 10 分钟的会话自动回收（心跳在主通道，业务通道允许静默）。

## 4. 文件传输

### 发送侧（networkService）

1. UI 发起 → `createTransferTask()` 创建 TransferTask（状态机：`pending → connecting → transferring → completed / failed / timeout`）。
2. `executeTransferTask()`：先确保 KCP 会话，然后顺序发送文本消息，再逐个文件分块发送。
3. 分块：**64 KB** 原始字节/块，`fs.promises.open` + 按偏移读取——**流式读盘，整个文件不驻留内存**；每块转 base64 放入 `file` 消息。进度按真实已发字节计算，变化时才发 `transferTaskUpdated` 事件。
4. 选文件时只记录元信息（名称/路径/大小），发送时才读取内容。

### 接收侧（chatViewProvider）

1. 按 `from + 文件名` 维护 `IncomingFileTransfer`，收集分块并更新进度 UI。
2. 收齐后重组写盘，保存目录取 `oschat.downloadPath`（默认下载目录）。
3. **文件名安全**（防路径穿越，硬性约定）：`path.basename` + 过滤 `[\\/:*?"<>|]`；同名文件自动加序号，不覆盖已有文件。

## 5. 会话与持久化

- **会话归属**：收到的消息按发送方 peerId 归入对应会话（而非当前打开的会话）。
- **peers.json**（路径由 `oschat.peersFilePath` 配置，默认插件 globalStorage）：
  - 启动时加载，所有加载的 peer 初始为离线；
  - `updatePeer` 只在状态/地址/名称真正变化时标记写盘，`lastSeen` 仅内存更新；
  - 写盘 **2 秒防抖**合并（心跳高频更新不反复写盘）；插件停用时 `flush()` 落盘未保存更改。
- 聊天消息不持久化。

## 6. 配置项（`oschat.*`）

| 配置 | 默认 | 说明 |
|---|---|---|
| `port` | 8080 | UDP 主端口；KCP 业务端口（UDP）= 此值 + 1000 |
| `nickname` | — | 昵称，随发现/心跳广播 |
| `autoConnect` | false | 插件激活时自动启动网络服务 |
| `peersFilePath` | — | peers.json 所在目录（空则用插件存储目录） |
| `downloadPath` | — | 接收文件保存目录 |
| `theme` | — | 界面主题 |

命令：`myChat.startNetwork`（交互输入端口/昵称）、`myChat.stopNetwork`、`myChat.newChat`、`myChat.editPeers`、`myChat.openPeersFile`、`myChat.openSettings`。

## 7. 资源管理约定

- 重建 KcpTransport 前必须先 `removeAllListeners()` + `stop()`（历史上有事件监听泄漏 bug）。
- `NetworkService.start()` 失败时回滚已启动的部分（KCP 起来了但主 UDP 失败 → 先停 KCP 再抛错）。
- `stop()` 清理顺序：定时器 → KcpTransport（关闭所有会话）→ UDP 主 socket → 发现 socket，最后将所有 peer 置离线并广播 `peersUpdate`。

## 8. 安全考量与已知限制

- **无加密无认证**：协议明文 JSON，身份帧可伪造。设计前提是受信任的小型内网；不要在不可信网络使用。
- 接收文件名已做路径穿越防护（§4），这是唯一的输入硬化点之一；业务帧长度上限防止恶意超大帧。
- 文件分块经 base64 编码（约 +33% 体积），换取协议统一为 JSON 帧的简单性；内网带宽下可接受。
- 接收侧分块在内存中累积到收齐才写盘，超大文件会占用相应内存（与发送侧的流式读取不对称，已知权衡）。

## 9. 测试

- 单元/集成测试：`src/test/`，`npm run test`（@vscode/test-cli + mocha）。
- 端到端冒烟：`npm run compile-tests` 后 `node smoke-test.js`——同一台机器起两个 NetworkService 实例，验证发现、消息、分块文件、进度、离线检测，**不依赖 VS Code**。
