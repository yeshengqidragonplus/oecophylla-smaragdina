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
- 身份标识是稳定的**实例 ID**（`iid` = `机器标识:主UDP端口`，机器标识首次运行时生成并保存在全局状态里，之后不变）。IP 只是"最近一次观察到的地址"：DHCP 换 IP 只更新地址，不会出现同一台机器的多个联系人。旧版对端没有 `iid`，退回使用 `ip:端口`。
- KCP 端口通过 UDP 消息的 `transferPort` 字段告知对端（默认为主端口 + 1000）。

> 历史决策：早期版本使用 kcpjs 库承载业务消息，但 kcpjs 依赖原生模块（需要 C++ 工具链编译），一度替换为 Node 内置 `net`（TCP）。现按 UDP+KCP 的预期架构回归，KCP 协议改为项目内纯 TypeScript 实现（`src/kcp.ts`，零原生依赖），不再有编译问题。

### 2.2 模块与数据流

```
        不依赖 vscode 的 core 层                          vscode 适配层
 ┌──────────────────────────────────────┐
 │ networkService（单例，EventEmitter）    │──peersUpdate / statusChange / message / transferTask*──┐
 │   ├ KcpTransport（业务通道）            │                                                        ▼
 │   ├ PeerRegistry（对端唯一数据源）       │◄──读写──  PeersManager（peers.json 持久化、联系人视图） ──► ChatViewProvider ──► Webview
 │   ├ netInterfaces（网卡与广播）          │                                                        ▲
 │   └ probeSchedule / netErrors           │            extension.ts（装配）· networkLauncher · statusBar · diagnose
 └──────────────────────────────────────┘
```

`src/core/` 下的模块**不得 import `vscode`**，可在 VS Code 之外运行与测试（`smoke-test.js`、`npm run test:unit`）。

| 模块 | 职责 |
|---|---|
| `core/networkService.ts` | 模块级单例（`export const networkService`），EventEmitter。UDP 发现/探测、传输任务（TransferTask）编排、文件分块发送、运行状态（`statusChange`）、唤醒与网卡变化检测、手动扫描网段 |
| `core/peerRegistry.ts` | **对端唯一数据源**：身份（iid / 别名）、地址、在线三态、合并与清理；`peers.json` 的内存模型 |
| `core/netInterfaces.ts` | 网卡枚举与过滤（硬排除 / 虚拟网卡降级）、按掩码位运算算广播地址、网卡指纹 |
| `core/probeSchedule.ts` | 对端探测节奏与睡眠唤醒判定（纯函数） |
| `core/netErrors.ts` | socket 错误分类（按系统给出建议）与日志限流 |
| `core/diagnostics.ts` | 诊断报告与初步判断规则 |
| `core/protocol.ts` | 线上协议：消息类型（判别联合）、协议版本、**输入校验**（类型、长度、范围，totalChunks 必须与文件大小一致……），校验不通过的数据直接丢弃 |
| `core/typedEmitter.ts` | 类型安全的 EventEmitter（NetworkService、KcpTransport 的事件表在编译期检查） |
| `core/fileReceiver.ts` / `core/fileReceiveService.ts` | 流式文件接收（`.part` 临时文件按偏移写盘）与接收侧粘合层（交给接收器、回 `file_ack`） |
| `core/safeFileName.ts` / `core/downloadDir.ts` | 接收文件名清理（Mac / Windows / Linux 通用）与保存目录解析（下载文件夹、可写校验、回退） |
| `core/chatStore.ts` / `core/messaging.ts` | 聊天记录（一人一会话、异步原子增量存储、旧数据迁移）与消息服务（发送、取消、重试、接收入库） |
| `core/kcp.ts` | KCP 协议核心（ikcp.c 纯 TS 移植，ARQ，无 FEC，零依赖） |
| `core/kcpTransport.ts` | KCP 业务通道：专用 UDP socket、SYN/ACK/FIN/RST 控制报文、会话仲裁、conv 路由、帧编解码、会话表 |
| `core/peerFileStore.ts` | `peers.json` 读写：读不出可信内容时不写盘，原子写盘 |
| `core/logger.ts` / `core/buildInfo.ts` | 日志与构建指纹 |
| `src/extension.ts` | 插件入口：注册命令、装配各模块、按 `oschat.autoConnect` 自动启动 |
| `src/networkLauncher.ts` | 启动/停止网络服务的统一入口（命令面板、侧边栏、自动启动共用），负责本机标识与版本信息 |
| `src/peersManager.ts` | 联系人持久化与视图：把 `PeerRegistry` 投影成界面用的联系人列表，防抖写 `peers.json` |
| `src/chatViewProvider.ts` | 侧边栏 Webview（视图 ID `OSChatView`）：只做 webview 桥接、当前会话与文件选择、未读提醒；业务状态全部在 ChatStore / MessagingService / PeerRegistry |
| `src/legacyChatHtml.ts` / `src/legacyChatAdapter.ts` | 旧界面的 HTML/CSS/脚本与会话投影（M3 用新界面整体替换后删除） |
| `src/receiveDir.ts` | 接收目录解析（读设置、回退时提示一次原因） |
| `src/shared/` | 扩展 ↔ 新界面的类型化消息协议与界面状态归约（纯函数，有单测） |
| `src/webview/` + `src/webviewHtml.ts` / `src/webviewHost.ts` | 新界面前端（TypeScript + Preact + 外置 CSS，独立打包到 `dist/webview`）与加载它的 HTML 外壳（脚本带 nonce、无内联脚本）。**管线已就绪，M3 接入侧边栏** |
| `src/statusBar.ts` / `src/diagnose.ts` | 状态栏与标题栏启停切换；诊断与扫描网段命令 |
| `src/peersEditor.ts` / `src/settingsPanel.ts` | 联系人编辑、设置的独立 Webview 面板（计划用原生设置替代） |

## 3. 线上协议

所有线上消息（裸 UDP 与 KCP）共用 `NetworkMessage` 接口，JSON 编码，`type` 字段区分：

| type | 通道 | 用途 |
|---|---|---|
| `discovery_request` | UDP 广播 → 41320；或单播 → 对端主端口 | 发现请求（携带本端 hostname/nickname/transferPort 与身份字段） |
| `discovery_response` | UDP 单播 → 请求方主端口 | 发现应答（往返确认） |
| `heartbeat` / `heartbeat_ack` | UDP 单播 | 心跳与确认，维护在线状态 |
| `message` | KCP | 聊天文本（`content` 字段，`id` 用于去重） |
| `file` | KCP | 文件分块（`file.{name,size,chunkIndex,totalChunks,data(base64),chunkSize,transferId}`） |
| `file_end` | KCP | 发送方声明"该文件已全部发出"（`transferId,name,size,totalChunks`） |
| `file_ack` | KCP | 接收方对落盘结果的确认（`transferId,ok,reason`） |

所有入站消息（UDP 与 KCP）先经 `core/protocol.ts` 校验再处理：类型、长度、范围不合法的直接丢弃并按来源限流记一条日志；下游拿到的一定结构合法、大小受限（`totalChunks` 必须等于 `ceil(size / chunkSize)`，`chunkIndex` 不得越界，`size` 不超过 4GB，文本不超过 100 万字符）。

**协议 v2 的新增字段**（旧字段不变，旧版对端忽略未知字段，两端不必同时升级）：

| 字段 | 含义 |
|---|---|
| `proto` | 协议版本，当前为 2 |
| `iid` | 发送方实例 ID（`机器标识:主端口`），对端据此识别"还是同一台机器" |
| `boot` | 发送方本次启动的随机标识；变化说明对端重启过，旧的 KCP 会话立即作废 |
| `meta` | 系统、架构、Node、插件版本、构建指纹、VS Code 版本，用于联系人详情与排查 |
| `id`（业务消息） | 消息 ID，接收端保留最近 512 个做去重（会话重建后的重发不会重复显示） |

**协议 v3**（文件传输）：每个文件带 `transferId` 与 `chunkSize`；发送方在全部分块被传输层确认后发 `file_end`，接收方落盘成功（或失败）后回 `file_ack`，发送方据此判定成败。旧版对端（协议 < 3）没有这两个消息，发送方按对端的 `proto` 判断，保持原行为，**两端不必同时升级**。

地址取自接收到的 UDP 包的来源地址（`rinfo`），**不取对端自称的 `from`**。

### 3.1 自动发现

1. 启动时立即广播一次，启动后 1 秒、3 秒各快速补发一次，之后每 **30 秒**一轮。每轮先刷新网卡信息，然后从 UDP 主 socket 向**每块可用局域网网卡的定向广播地址**和 `255.255.255.255` 的 41320 端口发送 `discovery_request`（广播地址按 `ip | ~mask` 位运算计算，/22 等非 /24 网段也正确）。源端口即本端主端口，对方据此知道往哪回复。
2. 可用网卡 = 排除回环、`169.254` 链路本地、`198.18.0.0/15`（Clash/Surge 的 TUN）、`/31` `/32` 点对点链路、多播后的 IPv4 网卡；名称或 MAC 像虚拟网卡（Docker、WSL、VMware、VPN 等）的只降级、排在后面，不剔除——Hyper-V 外部交换机下真实网段就挂在 vEthernet 上。
3. 所有实例都以 `reuseAddr` 共同绑定固定发现端口 **41320**——广播包会投递给同一端口的所有绑定者，因此**同一台机器上主端口不同的多个实例也能互相发现**（绑定失败不致命，只是无法被广播发现）。
4. 收到请求方单播 `discovery_response` 回请求方主端口，双方据此互相登记/刷新对端。
5. **持续单播探测**：对所有已知对端（含 `peers.json` 里手工配置的）持续探测，不看 `lastSeen`——有联系的发心跳，离线的发单播发现请求（前 3 次 30 秒一次，之后 60 秒一次）。这是广播到不了（跨网段、广播被过滤）时找回对端的唯一途径。
6. **手动扫描网段**（`myChat.scanSubnet`，需确认）：向真实网卡所在网段（主机数 ≤ 1022，即 /22 及更小）的每个地址单播一个发现请求，分批发送。

自消息过滤：先看消息里的实例 ID，再比较 **IP + 端口**（`_isSelf`）；只比较 IP 会误杀同机其他实例。

### 3.2 在线判定（三态）

在线状态由"**往返确认**"决定，而不是"收到过任意包"：

| 状态 | 条件 | 含义 |
|---|---|---|
| online（🟢） | 90 秒内收到过往返确认（对方应答了我们的探测，或 KCP 握手成功）；或刚收到对方入站包、尚在 20 秒宽限期内 | 双向可达 |
| oneway（🟡） | 90 秒内收到过对方的包，但宽限期后仍无往返确认 | 对方能找到我们，我们到对方可能被防火墙拦截 |
| offline（⚪） | 90 秒内什么都没收到 | 离线 |

- 每 **5 秒**一个维护节拍：重新计算状态、探测到期的对端（在线 30 秒一次心跳）。
- **睡眠唤醒与网卡变化**：两次节拍间隔超过 10 秒（进程被挂起过）或网卡指纹变化时，销毁旧 KCP 会话、清空探测状态、立即重新广播并探测全部对端；该节拍不做离线判定，避免唤醒后一瞬间把所有对端误判为离线。
- 在线状态**不写入 `peers.json`**，每次启动都从全部离线开始。

### 3.3 KCP 会话与帧协议

- **数据报分型**：KCP 专用 UDP 端口上的每个数据报以 1 字节前缀区分——`0x01` 控制报文（JSON：`syn`/`ack`/`fin`/`rst`），`0x02` KCP 报文（按 conv 路由到会话）。
- **握手即身份**：发起方选随机 32 位 conv，发送 `{"t":"syn","conv":N,"id":"<旧版 peerId>","iid":"<实例 ID>","boot":"<启动标识>","mp":<主端口>}`，每 500ms 重发直至收到 `ack`（默认 5 秒超时）。会话以实例 ID 为键，旧版对端没有 `iid` 时用 `id`。同一对端的并发 `connect` 共用一次握手。
- **会话仲裁**（同一对端出现第二个 SYN 时）：
  - 同一发起方换了 conv，或对端 `boot` 变了（进程重启过）→ 旧会话已无意义，**直接替换**；
  - 双向同时建连（我们先发起、对端也发起）→ 发起方 id 字典序较小的会话胜出；此时若已有会话已建立，发一个长度为 0 的保活帧探测——对端若单边丢了会话会回 `rst`，销毁后对端的下一次 SYN 重发即可建连。
- **RST**：收到未知 conv 的 KCP 报文时回复 `rst`（按来源与 conv 限流），发送方立即销毁僵尸会话并以 `SESSION_CLOSED` 快速失败，不再干等 5 秒确认超时。
- **帧格式**：KCP 可靠字节流之上，4 字节大端长度前缀 + JSON 负载。接收侧按前缀拆帧；单帧上限 64 MB，超限直接断会话防内存攻击；长度为 0 的帧是保活，直接丢弃。
- **发送确认**：与 TCP 不同，KCP 入队即"成功"，因此 `send()` 等待发送队列被对端 ACK 清空才完成；确认无进展超过 5 秒 → 判定对端离线，发 FIN、销毁会话并报错（快速失败）。另有在途段数背压上限与 KCP 死链（单段重传 20 次）检测。
- **错误与重试**：传输层错误统一为带错误码的 `KcpError`（`NO_SESSION` / `SESSION_CLOSED` / `ACK_TIMEOUT` / `SEND_FAILED` / `CONNECT_TIMEOUT`）。会话失效类错误时，`networkService` 销毁旧会话、重建并重发一次，用户不必手动点第二次。
- **在线检测即握手**：发送前不做额外探测，握手（5 秒超时）失败即视为对方不在线。
- **KCP 参数**：极速模式（nodelay=1、10ms 时钟、快速重传阈值 2、关闭拥塞控制——内网场景），收发窗口 256，**MTU 1200**（VPN/TUN 下不被 IP 分片）。空闲超过 10 分钟的会话自动回收。

## 4. 文件传输

### 发送侧（networkService）

1. UI 发起 → `MessagingService.send()`：文本与**每个文件各自独立**成一条消息、各创建一个 TransferTask（状态机：`pending → connecting → transferring → completed / failed / timeout / cancelled`），各有各的状态，一个失败不影响其他，失败的可重试、进行中的可取消。
2. `executeTransferTask()`：先确保 KCP 会话，再发送。
3. 分块：**64 KB** 原始字节/块，`fs.promises.open` + 按偏移读取——**流式读盘，整个文件不驻留内存**；每块转 base64 放入 `file` 消息。**滑动窗口并发发送（8 块在途）**，不再逐块等 ACK（原先吞吐约等于 64KB/RTT）；进度按真实已确认字节计算。
4. 协议 v3 对端：全部分块被传输层确认后发 `file_end`，等待接收端的 `file_ack`（最长 30 秒）——传输层确认只说明对端收到了，`file_ack` 才说明对端**存下来了**。接收端写盘失败、从未收到数据（如重启过）时发送方立即失败并拿到原因。
5. 待发送文件被占用（Windows 下已打开的 Excel 等）或被删除时给出可读提示；已结束超过 10 分钟的任务自动清理。

### 接收侧（core/fileReceiver）

1. 以 `对端 + transferId` 区分传输（旧版发送方退化为 对端+文件名+大小+块数）：同名文件并发、失败后重发互不混淆。
2. 每块校验长度后按偏移直接写入 `.part` 临时文件，**内存里只有当前块**；分块可乱序、可重复；0 字节文件正常落盘。
3. 收齐后校验总长，用硬链接放到最终位置（目标已存在时原子失败并换序号；FAT/exFAT 等不支持硬链接的外接盘退回 rename），同名加序号不覆盖。
4. 失败（磁盘已满、没有权限、块长度不符）或 2 分钟没有数据时清理 `.part` 并发出 `failed`；启动时清理上次崩溃遗留的临时文件；同时进行的接收上限 16 个。
5. **保存目录**：`oschat.downloadPath` → 系统"下载"文件夹下的 `OS Chat` → 扩展全局存储下的 `downloads` → 临时目录；目录不可用（如外接卷未挂载）时回退并提示一次，而不是让接收失败。
6. **文件名安全**（硬性约定，`core/safeFileName.ts`）：同时按 `/` 和 `\` 取最后一段（防路径穿越，与接收端系统无关）、NFD 归一化为 NFC、删除控制字符并替换 `< > : " | ? *`、去掉末尾的点和空格、Windows 保留设备名（`CON`、`con.txt`、`COM1.log`……）加前缀、按 UTF-8 字节截断（保留扩展名、不切断多字节字符）、Windows 完整路径过长时缩短主名。

## 5. 会话与持久化

- **会话归属**：收到的消息按发送方联系人的规范 id 归入对应会话（旧会话里保存的 `ip:端口` 等别名地址会自动对应到同一个联系人）。
- **peers.json**（路径由 `oschat.peersFilePath` 配置，默认插件 globalStorage）：
  - 内存模型是 `PeerRegistry`，`PeersManager` 负责读写；记录含 `iid`、`aliases`（历史 id）、`manual`、`lastSeen`，**不含在线状态**；
  - 启动时加载，所有对端初始为离线；旧格式文件（含 `status`、没有 `manual`/`iid`）兼容读取，旧条目视为手工添加；
  - 自动发现的对端 30 天未见则清理，手工添加或编辑过的永不自动清理；
  - **读不出可信内容时绝不写盘**：路径不可用（外接卷未挂载）期间不写，路径恢复后与文件内容合并再写；文件损坏时先备份为 `.corrupt-时间戳`，修复前不写；
  - 写盘为"临时文件 + 重命名"的原子写，2 秒防抖；没有实质变化（只有在线状态、lastSeen 在变）时不写盘，`lastSeen` 在实质变化与插件停用时落盘。
- **聊天记录**（`core/chatStore.ts`，全局存储目录下的 `chats/`）：
  - **一个联系人对应一个会话**，按联系人的规范 id 归并，旧版 `ip:端口` 与换 IP 前的地址等别名自动对应到同一个会话；
  - 消息模型：`direction`（in / out / system）+ `status`（sending / delivered / failed）+ 可选文件信息（进度、状态、保存路径）；
  - 每个会话一个文件，只写有变化的会话，1 秒防抖、异步、原子写；文件进度这类高频瞬时状态只更新内存，不触发写盘；每个会话最多 2000 条；损坏的文件挪到一边保留；
  - 首次启动自动迁移旧的 `chatSessions.json`：同一联系人的多个旧会话合并、消息按时间排序并按 id 去重，原文件改名为 `.migrated-时间戳` 保留作为备份。

## 6. 配置项（`oschat.*`）

所有设置都是 `machine` 级：不被 Settings Sync 同步到另一台机器，也不能被工作区设置覆盖。

| 配置 | 默认 | 说明 |
|---|---|---|
| `port` | 8080 | UDP 主端口（1024–64535）；KCP 业务端口（UDP）= 此值 + 1000；另需放行固定的发现端口 41320。修改后需重启网络服务 |
| `nickname` | — | 昵称，随发现/心跳广播；留空则使用计算机名。修改后需重启网络服务 |
| `autoConnect` | true | VS Code 启动后自动启动网络服务（配合 `onStartupFinished` 激活） |
| `peersFilePath` | — | peers.json 所在目录（空则用插件存储目录） |
| `downloadPath` | — | 接收文件保存目录；留空则为系统"下载"文件夹下的 `OS Chat`，目录不可用时自动回退 |

命令（category 均为 "OS Chat"）：`myChat.startNetwork`（读取最新设置，运行中再次执行即重启）、`myChat.stopNetwork`、`myChat.newChat`、`myChat.editPeers`、`myChat.openPeersFile`、`myChat.openSettings`、`myChat.showLogs`、`myChat.diagnose`（诊断报告）、`myChat.scanSubnet`（手动扫描网段）。

扩展声明 `extensionKind: ["ui"]`：在 WSL / SSH / 容器等远程窗口里也在本机运行，网络行为与本机窗口一致。

## 7. 资源管理约定

- 重建 KcpTransport 前必须先 `removeAllListeners()` + `stop()`（历史上有事件监听泄漏 bug）。
- `NetworkService.start()` 失败时回滚已启动的部分（KCP 起来了但主 UDP 失败 → 先停 KCP 再抛错）。
- `stop()` 清理顺序：定时器 → KcpTransport（关闭所有会话）→ UDP 主 socket → 发现 socket，最后将所有 peer 置离线并广播 `peersUpdate`。
- **不得 `emit('error')`**：EventEmitter 对没有监听者的 `error` 事件会直接抛出。运行期 socket 错误一律走 `networkError` / `transportError` 事件，并经 `netErrors` 分类、限流记录。
- **所有 UDP `send` 必须带回调**（含同步抛出的参数错误）；不带回调的发送失败会变成 socket 的未处理 `error` 事件。
- socket 的 `error` 监听必须常驻（不用 `once`）。

## 8. 安全考量与已知限制

- **无加密无认证**：协议明文 JSON，身份帧可伪造。设计前提是受信任的小型内网；不要在不可信网络使用。
- 接收文件名已做路径穿越防护（§4），这是唯一的输入硬化点之一；业务帧长度上限防止恶意超大帧。
- 文件分块经 base64 编码（约 +33% 体积），换取协议统一为 JSON 帧的简单性；内网带宽下可接受。
- 一帧最多 128 个 KCP 分片（约 150KB，已有测试固化），超长的单条文本消息会发送失败；文件按 64KB 分块（帧约 88KB）不受影响。
- 仅支持 IPv4；同机第二个 VS Code 窗口会因 KCP 端口被占用而启动失败（守护进程方案见 DAEMON-DESIGN.md，尚未实现）。

## 9. 测试

- **单元测试**（不启动 VS Code，反馈快）：`npm run test:unit`，位于 `src/test/unit/`，覆盖网卡与广播计算（含 Mac / 中文 Windows / Linux 夹具）、探测节奏与唤醒检测、PeerRegistry、协议校验、错误分类、诊断报告、peers.json 读写保护、文件名清理与下载目录、FileReceiver、ChatStore 与旧数据迁移、界面状态归约，**KCP 协议层的丢包/乱序/重复/延迟测试**，以及基于环回的 KcpTransport / NetworkService / MessagingService 集成用例（重启恢复、RST、并发建连、自动重试、单播探测、状态事件、流水线文件传输与落盘确认、取消、重试）。依赖本机有局域网网卡的用例在没有网卡的环境里自动跳过。
- **持续集成**：`.github/workflows/ci.yml` 在 macOS / Windows / Ubuntu 三平台跑类型检查、lint、单元测试与打包。
- **集成测试**：`src/test/extension.test.ts`，`npm run test`（@vscode/test-cli + mocha，需要下载并启动 VS Code）。
- **端到端冒烟**：`npm run compile-tests` 后 `node smoke-test.js`——同一台机器起两个 NetworkService 实例，验证发现、稳定身份、消息、分块文件、进度、离线检测，**不依赖 VS Code**。
