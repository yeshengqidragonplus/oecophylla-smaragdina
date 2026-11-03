# OS Chat 体检报告与改造方案

> 基线：`master` @ d947fe7（2026-11-03）。范围：网络与协议、配置与工程、跨平台兼容（Mac ↔ Windows）、产品与界面、程序结构。
> 本文是**改造前的评审结论与实施清单**，不描述当前实现（当前实现见 [DESIGN.md](DESIGN.md)）。
> 编号规则：`N-` 网络与协议，`CFG-` 配置与工程，`PLT-` 跨平台兼容，`UX-` 产品与界面，`SEC-` 信任与隐私，`ARC-` 程序结构。

## 0. 一页摘要

**一句话判断**：这是一个"功能能跑通、但产品形态和工程结构都还停留在原型期"的插件。传输内核（KCP）本身思路正确，问题集中在四层：**发现不可靠、身份不稳定、界面以"会话"而非"人"为中心、代码结构让这些问题难以修**。

用户抱怨的两个症状，对应的根因：

| 症状 | 主要根因 |
|---|---|
| 内网经常找不到对方 | N-01 子网广播算错；N-02 探测半途停止；N-03/N-07 身份取错网卡且随 DHCP 变化；CFG-01 自启并不会自启；N-04 对端重启后单向不通 |
| 显示经常有问题 | UX-05 没有网络状态显示；N-08 在线状态含义错误；UX-07 一个人对应多个会话；UX-02/03 消息显示丢失；N-07/N-10 联系人重复与复活 |

**最该先做的 9 件事**（详见第 7 节）：

1. 声明 `onStartupFinished` 与 `extensionKind: ["ui"]`（CFG-01、CFG-02）
2. 修正子网广播计算，逐网卡发定向广播（N-01）
3. 对所有已知对端持续单播探测（N-02）
4. 用稳定实例 ID 取代 `ip:端口` 作为身份（N-03、N-07）
5. 修复 KCP 会话仲裁（N-04）
6. 在线状态改为"往返确认"三态，并显示网络状态（N-08、UX-05）
7. 中文输入法回车误发送、多行消息折叠、只发文件时气泡为空（UX-01/02/03）
8. 收到消息要有提示（UX-04）
9. 补齐网络错误处理，并把防火墙、本地网络权限等平台差异纳入诊断（PLT-01、PLT-09、PLT-10）

## 1. 评审依据与局限

**已核对**：`networkService.ts`、`kcpTransport.ts`、`peersManager.ts`、`chatViewProvider.ts`（含内联 HTML/CSS/脚本）、`settingsPanel.ts`、`peersEditor.ts`、`extension.ts`、`package.json`、构建与调试配置、已打包 vsix 的清单。

**用真实数据印证**（只读，未看聊天内容）：

| 数据 | 发现 |
|---|---|
| 本机 `en0 = 10.10.213.120/255.255.252.0` | /22 网段，代码算出的子网广播是 `10.10.255.255`，正确值是 `10.10.215.255` |
| 本机 `utun1500 = 198.18.0.1` | Clash/Surge 的 TUN 地址，也是"非回环 IPv4"，会被当成身份候选 |
| `chatSessions.json` | 同一对端 `10.10.214.233:6688` 有 5 个会话；另有一个会话的对端 id 是 `198.18.0.1:6688`（8 条消息，名字显示成原始 id） |
| `peers.json` | 同一台 Windows（`DESKTOP-OF5OG27`）出现 3 个 IP；还有冒烟测试遗留的 `18080/18090` 条目 |
| VS Code 设置 | `autoConnect=false`，`theme=light`（无效），`peersFilePath`/`downloadPath` 在外接卷 `/Volumes/workspace` |
| vsix 清单 | `Publisher="undefined"`，`ExtensionKind="workspace"` |

**未做 / 未验证**：

- 没有登录 Windows 端，其防火墙状态、选用的 IP 均为推断。
- 没有在真实 VS Code 里渲染界面，界面评审来自 HTML/CSS/脚本源码；个别视觉问题（如窄侧栏的拥挤程度）需实机确认。
- 没有两端联调。所有"可能"类结论都标明了，诊断命令（M1）上线后即可坐实。

## 2. 产品与界面评审

### 2.1 产品定位与核心场景

**建议定位**：内网版 AirDrop + 轻聊天，住在 VS Code 侧边栏里。三个卖点：零配置发现、点对点不经服务器、对开发者友好（代码、选中内容、文件、截图）。

| 核心场景 | 现状 | 评级 | 主要缺口 |
|---|---|---|---|
| 打开 VS Code 就在线，一眼看到谁在线 | 不自启；无运行状态；在线点藏在下拉里 | 🔴 | CFG-01、UX-05、UX-06 |
| 发现同事 | 广播有缺陷，联系人重复 | 🔴 | N-01～N-03、N-07 |
| 发文字 | 能发；回车误发、折行丢失、会话混乱 | 🟠 | UX-01、UX-02、UX-07 |
| 发代码片段 | 折行丢失，无代码块，无"发送选中内容" | 🔴 | UX-02、CAP-01 |
| 发文件 | 能传；无进度、无取消、发送后看不到文件 | 🟠 | UX-03、UX-10 |
| 收到消息/文件被提醒 | 文本无任何提示；文件只有一个 toast | 🔴 | UX-04 |
| 找回收到的文件 | 只有一行路径文本 | 🔴 | UX-10 |
| 查看历史 | 有，但混乱且每次整份重写 | 🟠 | UX-07、ARC-06 |
| 出问题自助排查 | 只有一个日志通道，无诊断 | 🔴 | CAP-05 |
| 隐私与安全 | 办公室内网里"所有装了的人"互相可见，文件自动接收 | 🔴 | SEC-01～03 |

### 2.2 现状界面

单栏堆叠：`最近对话`（≤200px，含构建指纹徽标与"查看全部"）→ 聊天区 → 输入区（目标下拉 + 附件区 + 文本框 + 📎 ➤）。标题栏 5 个图标：新建会话、启动网络服务、设置、编辑聊天对象、打开 peers.json。另有两个独立的自制 webview：设置面板（450 行）和联系人表格编辑器（650 行）。

### 2.3 界面与交互问题

**P0（用户必然感知）**

| 编号 | 问题 | 位置 |
|---|---|---|
| UX-01 | 中文输入法候选确认时按 Enter 会直接发送消息：键盘处理没有 `isComposing` 判断 | chatViewProvider.ts 的 `keydown` 处理 |
| UX-02 | 多行消息折叠成一行：只有 system 气泡有 `white-space: pre-wrap`，用户与对方的气泡没有，代码、日志的换行全部丢失 | chatViewProvider.ts:1030-1055 |
| UX-03 | 只发文件时用户气泡是空的，文件不出现在聊天里：`userMessage` 从不设置 `attachment` | chatViewProvider.ts:651-657 |
| UX-04 | 收到文本消息没有任何提示：无活动栏徽标、无状态栏、无通知；只有文件接收完成有 toast | chatViewProvider.ts:326 |
| UX-05 | 网络没有可见状态与开关：webview 里的 ▶️/⚙️ 被 `.header { display: none }` 隐藏；标题栏 ▶ 永远显示，每次点击弹两个输入框并**重启服务**；停止只能走命令面板 | chatViewProvider.ts:880、package.json |
| UX-06 | 在线状态位置与语义错误：🟢/⚪ 只出现在发送目标下拉里；"最近对话"里的圆点是传输状态，且**传输中与失败同为红色** | chatViewProvider.ts:944-965 |

**P1（体验明显不佳）**

| 编号 | 问题 |
|---|---|
| UX-07 | 以"会话"而非"人"为中心：先新建会话，再在输入区下拉选目标；选目标会把当前会话改绑到该联系人，导致一个人对应多个会话（你的数据里有 5 个），收发还落在不同会话里。IM 的心智模型是"点人 → 聊天" |
| UX-08 | 窄侧栏（约 300px）里堆叠 6 个区域，缺少"列表页 ↔ 会话页"的主从切换 |
| UX-09 | 系统事件（"正在建立连接…""已成功发送"）以聊天行出现，噪声大；没有时间戳、送达状态、失败重试 |
| UX-10 | 文件收发没有卡片：进度条样式存在但 `updateTransferProgress` 只 `console.log`；无取消；接收后只有一行路径，没有"打开/在文件夹中显示"；图片无预览 |
| UX-11 | AI 聊天模板的遗留：`assistant` 消息类型、"📨 来自 X:" 文字前缀、`/peers` `/help` 斜杠命令、"最近对话/查看全部"措辞 |
| UX-12 | 首次使用无引导：空状态只说"点击配置 peers.json"；添加联系人强制填"主机名*"与端口；没有"复制我的地址"，手工互加很难 |
| UX-13 | 标题栏 5 个图标（`新建会话`与`编辑聊天对象`同为 `$(edit)`）；"打开 peers.json"是开发者动作却占据主导航；命令没有统一分类 |
| UX-14 | 每次更新全量 `innerHTML` 重绘并滚到底，读历史时被拉回；草稿、滚动位置不保存 |
| UX-15 | 删除会话无确认，且删除按钮 hover 才出现（`opacity: 0`） |
| UX-16 | 图标全用 emoji（🐜⚙️▶️📎➤🟢⚪），跨平台渲染不一致；无 aria 标签；状态色硬编码，不跟随主题 |

**P2**

| 编号 | 问题 |
|---|---|
| UX-17 | 自制设置面板与联系人表格重复造了原生设置 UI 的轮子，且各有 bug（见 CFG-08） |
| UX-18 | 命名不统一：OS Chat / OSChat / Oecophylla smaragdina / Oecophy Smaragdina Chat；命令前缀 `myChat.*`，配置前缀 `oschat.*` |
| UX-19 | 构建指纹徽标占用列表标题行，对普通用户是噪声，应移到"关于/诊断" |

### 2.4 缺失的关键能力

| 编号 | 能力 | 说明 |
|---|---|---|
| CAP-01 | 发送选中代码 / 当前文件 | 编辑器右键 `OS Chat: 发送选中内容给…`，QuickPick 选联系人，对方收到带语言标记的代码块 |
| CAP-02 | 资源管理器右键发送 | 文件或多选文件 → `发送到…` |
| CAP-03 | 拖拽与粘贴截图 | 拖文件到聊天区；粘贴剪贴板图片直接发送（开发者高频需求） |
| CAP-04 | 代码块渲染与复制 | 等宽字体、一键复制、对方点击可在编辑器打开 |
| CAP-05 | 自助诊断 | 网卡、广播地址、端口绑定、收发计数、每个对端的往返/单向状态、Windows 放行端口命令 |
| CAP-06 | 离线待发队列 | 对方离线时"上线后自动发送"（可选） |
| CAP-07 | 接收策略 | 总是询问 / 自动接收已知联系人 / 大小上限 |

### 2.5 信任与隐私

| 编号 | 问题 |
|---|---|
| SEC-01 | 办公室内网里所有装了插件的人会被自动发现、**永久写入 peers.json**，没有分组/房间概念 |
| SEC-02 | 任何局域网主机都能向你磁盘写文件，无确认、无大小上限；`totalChunks`/`size` 无上限校验，可被用来撑爆内存 |
| SEC-03 | 明文、无认证，昵称可随意冒充。受信任小内网可接受，但应至少提供"房间口令"选项 |

## 3. 程序结构评审

| 编号 | 问题 | 后果 |
|---|---|---|
| ARC-01 | `chatViewProvider.ts` 1930 行"神类"：会话存储、文件接收协议、传输编排、斜杠命令、约 1100 行内联 HTML/CSS/JS 全在一起；内联脚本是模板字符串，需要转义反引号和 `${`；含 45 处 `[DEBUG]` 的 `console.log` | webview 脚本无法 lint、无类型检查、无法测试；改一处牵动全局 |
| ARC-02 | 对端状态有三份：`networkService._peers`、`PeersManager._peers`、webview 的 `allPeers`；两处各自读取同一个 peers.json；靠整份拷贝事件同步 | 状态漂移，是"显示有问题"和"删除后复活"的结构性原因 |
| ARC-03 | `networkService.ts`（837 行）同时负责发现、心跳、对端表、文件分块发送、传输任务、本机 IP 探测、peers.json 读取，且是模块级全局单例 | 职责过载，难以单测 |
| ARC-04 | 协议层：一个宽泛的 `NetworkMessage`（所有字段可选），无协议版本、无消息 ID、无应用层 ACK；文件协议的发送端在 `networkService`、接收端在 view，两处没有共享定义 | 难以演进与兼容；发送成功只代表"对端 KCP 确认"，不代表"对端处理成功" |
| ARC-05 | 事件总线是字符串事件、无类型；`extension.ts` 里做业务桥接（把 `peersUpdate` 写入 `PeersManager`）——入口文件里有业务逻辑 | 事件名拼错无编译期保护，胶水逻辑难以复用 |
| ARC-06 | 持久化全是同步 I/O（`writeFileSync`）、整文件重写、非原子、无 schema 版本；每收一块文件都重写整份会话；多窗口互相覆盖 | 大文件传输时阻塞扩展宿主；数据易损坏 |
| ARC-07 | 两个自制 webview 表单（共 1100 行）与原生 Settings UI 重复 | 缺校验、缺 scope、有注入风险 |
| ARC-08 | 测试：多为对象字面量断言，几乎不测行为；`kcp.ts`（714 行 ARQ 实现）零单测；`npm test` 必须下载并启动 VS Code，反馈慢；扩展 id 写错，测试从未真正激活扩展 | 改动没有安全网 |
| ARC-09 | 死代码与泄漏：`transfer-progress` 样式未用、被隐藏的 header、`/peers` 命令、仅被测试用到的 `formatPeerList`/`getOnlinePeers`；`_transferTasks` 只增不删；使用已弃用的 `substr` | 维护噪声 |

**好的一面**：传输核心（`kcp.ts`/`kcpTransport.ts`）与 `vscode` 解耦，可在 VS Code 外运行；资源管理有回滚；日志体系已有雏形；文件名路径穿越防护与分块解码 bug 已修；有端到端冒烟测试。

## 4. 网络与协议问题

| 编号 | 问题 | 位置 | 现象 |
|---|---|---|---|
| N-01 | 子网广播按字节粗算，非 /24 全错；只取第一块网卡 | networkService.ts:257 | 你的 /22 网络上定向广播发错地址；多网卡（TUN/Docker/虚拟机）时可能发进黑洞 |
| N-02 | 只向"在线或 lastSeen 不足 180 秒"的对端发心跳，之后不再探测；启动后首个心跳要等 30 秒 | networkService.ts:371 | 手工配置的对端、跨网段对端，失联 3 分钟后再也找不回 |
| N-03 | 本机身份取"第一块非回环网卡"的 `ip:端口` 并写入 KCP 握手 | networkService.ts:803、810 | 对端把 `198.18.0.1:6688` 当身份，消息落进陌生会话；网卡顺序随 VPN/TUN 开关变化 |
| N-04 | SYN 仲裁 `existing.initiator <= peerId` 在"同发起方、不同 conv"时恒为真 | kcpTransport.ts:345 | 对端重启/崩溃/睡眠唤醒后的新 SYN 被忽略，最长 10 分钟"对方能发给你、你发不回去" |
| N-05 | 未知 conv 的 KCP 包被静默丢弃，`send` 复用僵尸会话 | kcpTransport.ts:397 | 对端重启后我方第一次发送必定卡 5 秒后失败 |
| N-06 | 并发 `connect` 不去重 | kcpTransport.ts:172 | 快速连发时竞态，报"没有到 xx 的连接" |
| N-07 | `peerId = ip:端口`，无稳定实例 ID，peers 永不合并 | 全局 | DHCP 换 IP 后同一台机器出现多个联系人 |
| N-08 | "在线"= 收到过对方任意 UDP 包 | networkService.ts:308 | 对方能找到你、你到对方被防火墙拦，也显示在线，发送时才超时 |
| N-09 | 本机 IP 集合只在 `start` 时取一次 | networkService.ts:108 | 中途开关 VPN/TUN 后，自己的广播不再被识别，自己出现在对端列表 |
| N-10 | 发现的所有 peer 全量写盘；联系人编辑器删除不通知 `networkService` | extension.ts:53、peersEditor.ts:114 | 删掉的对端下个心跳就复活；旧 IP 永久堆积；冒烟测试实例被持久化 |
| N-11 | 接收端分块全驻留内存；每块同步重写整份 `chatSessions.json` | chatViewProvider.ts:437 | 大文件占内存、阻塞扩展宿主，ACK 延迟超 5 秒被发送端判离线 |
| N-12 | 接收 key 是 `peer:文件名`；半途失败的残留不清理；0 字节文件被 `!msg.file.data` 吞掉 | chatViewProvider.ts:393、397 | 同名重发混块；0 字节文件发送端报成功、接收端无文件 |
| N-13 | 每块停等 ACK，吞吐 ≈ 64KB/RTT；base64 多 33% | kcpTransport.ts:257 | 大文件偏慢 |
| N-14 | 同机第二个窗口 KCP 端口 EADDRINUSE；`chatSessions.json` 多窗口互相覆盖 | networkService.ts:119 | 守护进程方案已设计，本轮不做 |
| N-15 | `_transferTasks` 只增不删 | networkService.ts | 长期运行内存缓慢增长 |

另有一个**未验证的假设**：Clash/Surge 的 TUN 模式接管默认路由后，`255.255.255.255` 可能被送进 TUN 而不是局域网。逐网卡发定向广播可规避，诊断命令可确认。

## 5. 配置、工程与跨平台兼容问题

### 5.1 配置与工程（CFG）

| 编号 | 问题 | 证据 / 影响 |
|---|---|---|
| CFG-01 | `autoConnect` 并不会"开机自启" | `activationEvents` 只有 `onView`/`onCommand`，无 `onStartupFinished`；自启逻辑在 `activate()` 里，用户不点开侧栏就不入网 |
| CFG-02 | 扩展默认在**远端宿主**运行 | vsix 清单 `ExtensionKind=workspace`；WSL/SSH/容器窗口里 UDP 绑在远端，WSL2 是 NAT，广播出不去。应声明 `["ui"]` |
| CFG-03 | 改端口、昵称、自启后不生效 | 配置监听只处理 `peersFilePath`（extension.ts:132） |
| CFG-04 | 启动入口不统一 | 命令面板用激活时缓存的旧值做默认并**写回用户设置**；侧栏按钮读最新配置、不弹框 |
| CFG-05 | `oschat.theme` 是死配置 | 全项目只有设置面板读写，界面始终跟随 VS Code 主题 |
| CFG-06 | 端口校验不一致 | 面板允许 1–65535，实际上限 64535（业务端口 = 主端口 + 1000）；非法输入静默变成 8080 |
| CFG-07 | 未声明 `scope` | Settings Sync 会把 Mac 的 `/Volumes/...` 同步到 Windows；任何仓库的 `.vscode/settings.json` 能覆盖 `downloadPath` |
| CFG-08 | 设置面板：显示的 peers.json 路径是错的（显示工作区目录，实际用扩展存储目录）；端口说明不准确；昵称未转义拼入 HTML；每次重新可见都重绘丢未保存输入 | settingsPanel.ts:141、329、343 |
| CFG-09 | `peersFilePath` 指向外接卷的边界风险 | 启动时卷未挂载→内存为空；之后挂载并写盘，会用只含新发现对端的列表覆盖原文件（按代码推出，未实际发生） |
| CFG-10 | 缺 `publisher` | vsix `Publisher="undefined"`，存储目录 `undefined_publisher.*`；测试里 `getExtension('oecophylla-smaragdina')` 查不到并被 `if (ext)` 吞掉 |
| CFG-11 | 命令无 `category`、图标重复 | 面板里是裸的"设置""新建会话" |
| CFG-12 | `.gitignore` 忽略整个 `.vscode` | `launch.json`/`tasks.json` 未入库，新克隆的仓库不能 F5 |
| CFG-13 | vsix 里的 README 有死链 | 链接 `docs/DESIGN.md`、`CLAUDE.md`，二者被 `.vscodeignore` 排除 |
| CFG-14 | ESLint 只有 4 条基础规则 | 无 `no-floating-promises` 等，而项目有大量异步事件处理 |
| CFG-15 | `@types/node` 为 22.x | VS Code 1.92 内置 Node 20 系，类型可能允许运行时没有的 API |
| CFG-16 | 未声明 `capabilities.untrustedWorkspaces` | 按 VS Code 默认规则，带代码且未声明的扩展在受限模式下会被禁用（未实测）；声明前必须先完成 CFG-07 |

### 5.2 跨平台兼容（Mac ↔ Windows，PLT）

**先说结论**：全项目没有任何平台分支（没有 `process.platform` / `os.platform`）。两端现在能通，靠的是"传输内核恰好与平台无关"；差异主要出在三处：**网络环境**（防火墙、网卡、睡眠唤醒）、**文件系统**（文件名规则、默认目录）、**错误处理**（各系统 socket 错误码不同，而代码没处理）。

**已核实的平台无关设计（好的一面）**

- 无原生依赖（纯 TS 的 KCP），Apple Silicon、Intel、Windows x64/ARM 用同一份产物。
- 字节序显式：KCP 头 `writeUInt32LE`，业务帧长度 `writeUInt32BE`，跨架构一致。
- 文本走 UTF-8 JSON；文件按二进制分块再 base64，没有换行转换。
- 构建脚本没有 shell 专属命令。
- 接收文件名经 `path.basename` 并过滤非法字符，防路径穿越。

**已在代码与数据中核实的问题**

| 编号 | 问题 | 证据 / 位置 | 影响 |
|---|---|---|---|
| PLT-01 | 网络错误处理缺失，且各系统错误码不同 | `kcpTransport.ts:113` 用 `once('error')`，第一次错误后监听即被移除；`networkService.ts:165`、`kcpTransport.ts:118` 把错误转发为 `emit('error')`，但全项目没有任何 `error` 监听；所有 UDP `send` 都不带回调（`networkService.ts:238/247/776`、`kcpTransport.ts:457/504`），失败会作为 socket 的 `error` 事件抛出 | 网络切换、睡眠唤醒、网卡被禁用、macOS 无"本地网络"权限时，发送失败变成未处理的 `error` 事件（`ERR_UNHANDLED_ERROR`）：轻则刷未捕获异常，重则传输层停摆；用户只看到"没反应" |
| PLT-02 | 网卡过滤没有平台词表 | 虚拟网卡命名各系统不同，且中文 Windows 的网卡名是本地化的（"以太网""WLAN"） | 只按英文关键词过滤在中文 Windows 上失效，TUN、Docker、WSL 网卡会被当成真网卡；应按"地址段 + 掩码 + MAC 厂商前缀 + 多语言名称"组合判断 |
| PLT-03 | 接收文件名清理不够 | `chatViewProvider.ts:548` 只替换 `\ / : * ? " < > \|`；缺 Windows 保留名（`CON` `PRN` `AUX` `NUL` `COM1-9` `LPT1-9`，含带扩展名）、末尾空格与点、控制字符、单名 255 与整体路径 260 的长度限制、macOS NFD 与 NFC 不一致 | Mac → Windows 发 `CON.txt`、`报告.`、超长文件名会写入失败，报"文件接收失败"；Windows → Mac 时 NFC 与 Mac 本地 NFD 的同名文件检测不到 |
| PLT-04 | 默认下载目录是扩展存储目录 | `chatViewProvider.ts:545`：Mac 是 `~/Library/Application Support/Code/User/globalStorage/…`，Windows 是 `%APPDATA%\Code\User\globalStorage\…` | 路径隐蔽，用户找不到收到的文件；两台机器路径还各不相同 |
| PLT-05 | 主机名未归一化，也不知道对端是什么系统 | `networkService.ts:94` 直接用 `os.hostname()`；你的 `peers.json` 里有 `yesheng.local`（Mac 常带 `.local`），Windows 是 `DESKTOP-OF5OG27` | 显示名不统一；排查"为什么这台不通"时看不到对端系统与版本 |
| PLT-06 | 测试硬编码 `/tmp`，无换行与 CI 约束 | `src/test/extension.test.ts:24、303`；仓库没有 `.gitattributes`、`.editorconfig`、CI | Windows 检出可能被转成 CRLF；单测从未在多个系统上跑过 |
| PLT-07 | 网卡地址族严格比较字符串 | `networkService.ts:263、819` 用 `family === 'IPv4'` | Node 18.0–18.3 曾返回数字 4；`engines ^1.92` 对应 Node 20，目前安全，低优先级 |
| PLT-08 | KCP MTU 用默认 1400，从未调整 | `kcp.ts` 默认 1400，`kcpTransport.ts` 没调用 `setMtu` | 加 1 字节前缀与 28 字节 IP/UDP 头共 1429，VPN/TUN（常见 1280–1380）下会 IP 分片，部分防火墙与企业网络会丢分片 |

**平台已知行为（需实机确认）**

| 编号 | 问题 | 说明 |
|---|---|---|
| PLT-09 | Windows 防火墙按网络配置文件放行 | 首次监听时系统弹窗让勾"专用/公用"。企业网络、"未识别网络"常被归为"公用"，只放行了专用则入站 UDP 被丢弃，表现为单向可达（对方能看到你，你看不到对方）。组策略禁用弹窗时是静默拦截 |
| PLT-10 | macOS 防火墙与本地网络权限 | ① 应用防火墙对 VS Code 扩展宿主进程（通常是 `Code Helper (Plugin)`）弹"允许传入连接"，选了拒绝或开了"阻止所有传入连接"则入站失败；② macOS 15 起新增"本地网络"隐私权限，未授权时发往局域网的 UDP 会失败（你当前是 Darwin 22.2，即 macOS 13，暂不涉及，升级后会出现） |
| PLT-11 | 睡眠唤醒与后台节流 | macOS 的 App Nap、Windows 的现代待机会让定时器和 socket 在休眠期间停摆，唤醒后 IP 常变。后台节流还可能让心跳漏发，被对端误判离线 |
| PLT-12 | 输入法事件顺序不同 | Mac 与 Windows 的输入法对回车的事件顺序不同；Chromium 下要同时判断 `isComposing` 与 `keyCode === 229`，并配合 `compositionstart/end` 标志位（UX-01 的修复必须覆盖两端） |
| PLT-13 | 文件系统差异 | Windows 下被其他程序独占的文件（如已打开的 Excel）发送端 `open` 会失败（`EBUSY`/`EPERM`），现有提示不友好；不保留修改时间与可执行位（Windows → Mac 的脚本会丢 `+x`） |
| PLT-14 | 仅支持 IPv4 | 全部使用 `udp4`，纯 IPv6 网络不可用；写入已知限制 |
| PLT-15 | 广播被过滤的网络 | 部分企业 Wi-Fi 过滤广播但放行组播（mDNS 类），Mac 与 Windows 10+ 都支持；可作为二级发现通道 |
| PLT-16 | 两台机器 VS Code / Electron / Node 版本可能不同 | `engines ^1.92` 只保证最低版本；协议需带版本与平台信息，避免使用新 API，并在最低版本上持续测试 |

## 6. 目标设计

### 6.1 信息架构（侧边栏主从两页）

**页面一：联系人页（默认）**

```
┌────────────────────────────────┐
│ ● Arthur-Mac  10.10.213.120:6688│  状态条：我 · 地址 · [⏸ 停止]
│   在线 2 人                      │
├────────────────────────────────┤
│ 搜索联系人                       │
│ 在线 (2)                        │
│  [A] Arthur-Win        12:03 ②  │  名称 · 最后消息时间 · 未读数
│      收到，我看一下…             │
│  [Z] 张三              昨天      │
│      [文件] report.xlsx          │
│ 单向可达 (1)                     │
│  [L] 李四   ⚠ 对方能看到你，但   │
│      你到对方可能被防火墙拦截     │
│ 离线 (3) ▸                      │
├────────────────────────────────┤
│ ＋ 添加联系人        ⋯ 诊断/设置 │
└────────────────────────────────┘
```

**页面二：会话页（点联系人进入，一人一会话）**

```
┌────────────────────────────────┐
│ ← Arthur-Win ● 在线          ⋯ │  返回 · 名称 · 状态 · 更多
├────────────────────────────────┤
│         ── 今天 12:01 ──         │
│              你好，文件在这 ┐     │
│                     ✓ 已送达     │
│ ┌ report.xlsx  2.3 MB ───────┐  │  文件卡片
│ │ ████████░░ 82%  取消        │  │
│ └────────────────────────────┘  │
│ ┌ 收到，我看一下               │  │
│ │ ts                [复制]     │  │  代码块
│ │ const a = 1;                 │  │
├────────────────────────────────┤
│ 输入消息…（Enter 发送）   📎  ➤  │
└────────────────────────────────┘
```

**其他入口**

- **标题栏**精简为 3 个：`＋ 添加联系人`、`启动/停止`（图标随状态切换，用 `setContext` 控制 `when`）、`⋯`（设置、诊断、日志、复制我的地址）。
- **状态栏**：`$(broadcast) OS Chat 3`，点击打开视图；异常（端口被占、未入网）显示警告背景。
- **活动栏**：未读徽标（`WebviewView.badge`）。
- **通知**：文本消息带"回复"；文件带"打开""在文件夹中显示"。
- **右键菜单**：编辑器 `发送选中内容给…`/`发送当前文件给…`；资源管理器 `发送到…`。
- **设置**：用原生 Settings UI，删除自制设置面板；联系人管理（重命名、复制地址、删除）并入列表的右键/`⋯`，删除表格编辑器；`peers.json` 降级为高级选项，可导入导出。
- **空状态引导**：未入网 → 大按钮"启动"；已入网无人 → "正在发现… / 手动添加 / 运行诊断"。

### 6.2 状态机

| 对象 | 状态 |
|---|---|
| 对端在线 | 🟢 在线（收到 ack / discovery_response，或 KCP 握手成功）→ 🟡 单向可达（只收到对方的包）→ ⚪ 离线（超时） |
| 消息 | 发送中 → 已送达（对端 KCP 确认）→ 失败（可重试） |
| 文件传输 | 排队 → 传输中（含进度、速度）→ 完成 / 失败 / 已取消 |
| 网络服务 | 已停止 → 启动中 → 运行中 / 启动失败（带原因：端口被占、绑定失败） |

### 6.3 目标架构

```
src/
  extension.ts            仅装配与生命周期，不含业务逻辑
  core/                   不依赖 vscode，可被 mocha 直接测试
    protocol.ts           消息类型、协议版本、编解码（带类型）
    typedEmitter.ts       类型安全的事件
    netInterfaces.ts      网卡枚举、过滤虚拟网卡、广播地址计算
    discovery.ts          UDP 发现与心跳
    kcp.ts, kcpTransport.ts
    peerRegistry.ts       对端唯一数据源：身份、地址、在线三态、持久化
    messaging.ts          文本与文件的发送任务 / 接收器
    fileReceiver.ts       流式落盘、transferId、校验、上限
    chatStore.ts          一人一会话、增量异步原子存储
    logger.ts
  vscode/                 适配层（薄）
    chatView.ts           WebviewView，只做桥接
    statusBar.ts, commands.ts, notifications.ts, contextMenus.ts
  webview/                独立打包的前端（TypeScript + 外置 CSS）
    main.ts, chat.css
```

- webview 用 esbuild 打包进 `dist/`，与扩展侧共享**类型化的消息协议**；加载后先发 `ready`，后端回推状态；用 `getState/setState` 保存草稿与滚动位置。
- 图标改用 codicon，状态色用主题色变量。
- 前端框架：**推荐 Preact（约 3KB）**，避免全量 `innerHTML` 重绘与滚动跳动；备选为原生 TS。

### 6.4 协议 v2 要点

- 所有 UDP 与 KCP 握手消息携带：`proto`（协议版本）、`instanceId`（稳定实例 ID）、`bootId`（进程启动随机数，变化即表示对端重启）。
- 业务消息带 `id`（UUID）；文件消息带 `transferId`，结尾带 `size` 校验。
- 发现与握手附带 `meta`：`os`、`arch`、插件版本、构建指纹、VS Code 版本。用于联系人详情展示、排查与按版本做兼容分支；展示名去掉 Mac 主机名的 `.local` 后缀。
- KCP 默认 MTU 降到 1200，避免 VPN/TUN 下分片。
- 对端按 `instanceId` 建索引，地址取自 `rinfo`（观察值），不取对端自称；手工条目（只有 ip/port）首次应答后自动绑定实例 ID。
- **兼容旧版**：对端没带 `instanceId` 时退回 `ip:端口` 作为 ID。

### 6.5 设置项（新 schema）

| 配置 | 类型 | 默认 | scope | 说明 |
|---|---|---|---|---|
| `oschat.port` | integer，1024–64535 | 8080 | machine | 主端口；业务端口 = +1000；需放行 UDP 主端口、+1000、41320 |
| `oschat.nickname` | string | "" | machine | 昵称，空则用主机名 |
| `oschat.autoConnect` | boolean | true（待定） | machine | 配合 `onStartupFinished` |
| `oschat.downloadPath` | string | "" | machine | 接收文件目录 |
| `oschat.peersFilePath` | string | "" | machine | 高级：联系人文件目录 |
| `oschat.advertiseInterface` | string | "" | machine | 可选：指定使用的网卡 |
| `oschat.theme` | — | — | — | **删除**（死配置） |
| `oschat.room` / `oschat.roomKey` | string | "" | machine | M4：房间与口令 |
| `oschat.receivePolicy` / `oschat.maxFileSizeMB` | enum / integer | 待定 | machine | M4：接收策略 |

## 7. 实施计划

原则：每个提交只做一件事，便于单独回滚；纯逻辑先写单测；旧数据（`peers.json`、`chatSessions.json`）迁移前先备份。

### M0 配置与清单（小、低风险）

| 编号 | 内容 | 解决 |
|---|---|---|
| 0.1 | manifest：`onStartupFinished`、`extensionKind: ["ui"]`、命令 `category`、换掉重复图标、统一对外名称（命令 id 不改，避免破坏用户已有快捷键） | CFG-01/02/11、UX-18 |
| 0.2 | 配置 schema 重定义：integer + 范围 + scope + `markdownDescription`；删除 `theme` | CFG-05/06/07 |
| 0.3 | 配置变更生效（运行中提示重启服务）；启动入口统一，读最新配置，不再写回用户设置 | CFG-03/04 |
| 0.4 | peers 文件写保护：路径不可用或加载失败时不写盘；写盘改"临时文件 + 重命名" | CFG-09、ARC-06 |
| 0.5 | 工程配置：`.vscode` 入库、修正测试扩展 id、补 ESLint 规则、`@types/node` 降到 20.x、README 文档链接改绝对地址；新增 `.gitattributes`（统一 LF）与 `.editorconfig`；测试里的 `/tmp` 改 `os.tmpdir()` | CFG-12～15、PLT-06 |
| 0.6 | 补 `publisher`，附存储目录一次性迁移（待定） | CFG-10 |

> 设置面板与联系人编辑器的 bug（CFG-08、UX-17）**不单独修**，M3 用原生设置替代后整体删除。

### M1 找得到、连得上（核心网络）

| 编号 | 内容 | 解决 |
|---|---|---|
| 1.1 | `netInterfaces.ts`：网卡枚举与过滤（回环、`169.254`、`198.18.0.0/15`、`100.64.0.0/10`）、位运算算广播、主 IP 选择。虚拟网卡按"地址段 + 掩码 + MAC 厂商前缀（VMware `00:50:56`/`00:0c:29`、VirtualBox `08:00:27`、Hyper-V/WSL `00:15:5d`）+ 多语言接口名词表"组合判断，覆盖 Mac（`utun` `awdl` `llw` `bridge` `vmnet`）、Windows（`vEthernet` `VMware` `VirtualBox` `TAP` `Wintun` `Clash`）、Linux（`docker` `veth` `br-` `virbr` `wg` `tailscale`）；地址族兼容数字 4。单测用各系统的 `os.networkInterfaces()` 夹具（含你这台 Mac 的真实输出、中文 Windows 的典型输出），断言 `10.10.213.120/255.255.252.0 → 10.10.215.255`、`198.18.0.1` 必须被排除 | N-01、N-03、PLT-02、PLT-07 |
| 1.2 | 发现重构：逐网卡定向广播 + `255.255.255.255`；启动后快速三连发，之后每 30 秒；每轮刷新本机 IP 集合 | N-01、N-09 |
| 1.3 | 持续单播探测：对所有已知与已配置对端，无论 `lastSeen` 都周期探测（在线 30 秒，离线退避到 60 秒），启动立即一次 | N-02 |
| 1.4 | KCP 修复：仲裁改"同发起方换 conv 一律替换"；未知 conv 回 `rst`（限速）；`send` 遇失效会话自动重建重试一次；同对端并发 `connect` 去重；含丢包环回单测 | N-04/05/06 |
| 1.5 | 协议 v2：`proto`/`instanceId`/`bootId`；`bootId` 变化立即销毁旧会话；兼容旧版回退 | N-03、N-05、N-07 |
| 1.6 | `PeerRegistry`：对端唯一数据源，按 `instanceId` 合并换 IP 的重复项，自动发现条目 30 天未见清理，手工条目不自动删，删除同步，状态不落盘 | N-07/10、ARC-02 |
| 1.7 | 在线三态（🟢/🟡/⚪） | N-08 |
| 1.8 | `statusChange` 事件与 `getStatus()`（运行/失败原因/本机地址） | UX-05 铺垫 |
| 1.9 | `myChat.diagnose` 诊断命令（可复制报告）；可选 `scanSubnet`。报告含平台段：系统/架构、VS Code 与 Node 版本、按系统给出防火墙与本地网络权限提示（Windows 给出 `netsh advfirewall firewall add rule … protocol=UDP localport=主端口,主端口+1000,41320 profile=any`，需管理员；macOS 给出设置路径）、"只收不发"的单向可达检测 | CAP-05、PLT-09/10 |
| 1.10 | 旧界面止血（M3 会整体替换，只做以下 5 项）：IME 回车（同时判断 `isComposing` 与 `keyCode 229`，配合 `compositionstart/end`，兼容 Mac 与 Windows 输入法）、`pre-wrap`、只发文件的气泡、收消息通知与活动栏徽标、标题栏启动/停止随状态切换并显示运行状态 | UX-01～05、PLT-12 |
| 1.11 | 网络错误健壮性：所有 socket 挂常驻 `error` 监听；所有 `send` 带回调；不再裸 `emit('error')`；错误码分类（`EHOSTUNREACH` `ENETUNREACH` `EADDRNOTAVAIL` `EPERM` `EACCES` `ECONNRESET` `EADDRINUSE`）转成用户可读原因，并在网卡变化时自动重建 socket | PLT-01 |
| 1.12 | 唤醒与网络变化：用"两次定时间隔 > 2 倍周期"的时间跳变检测睡眠唤醒，并检测网卡指纹变化；触发时重新枚举网卡、立即重发发现、销毁旧 KCP 会话；判离线前先做一次按需探测，避免后台节流造成误判 | PLT-11、N-09 |
| 1.13 | 协议 `meta`（系统/架构/插件版本/构建指纹/VS Code 版本）随发现与握手携带；展示名去 `.local`；KCP 默认 MTU 降到 1200 | PLT-05/08/16 |

### M2 结构整理（为 M3 铺路）

| 编号 | 内容 | 解决 |
|---|---|---|
| 2.1 | `protocol.ts` 类型化 + 版本；`typedEmitter` | ARC-04/05 |
| 2.2 | `fileReceiver` 迁入 core：`.part` 临时文件流式落盘、`transferId`、0 字节、`totalChunks`/`size` 上限校验；发送端 8 块流水线；去掉逐块同步写会话；`_transferTasks` 清理。文件名清理升级（Windows 保留名、末尾空格与点、控制字符、单名 255 与整体路径长度、NFC 归一化）；默认下载目录改为 `~/Downloads/OS Chat`，启动时校验可写并回退；发送端对被占用文件（`EBUSY`/`EPERM`）给出友好提示 | N-11/12/13/15、SEC-02、ARC-01、PLT-03/04/13 |
| 2.3 | `chatStore`：一人一会话；启动时合并旧会话（备份在先）；异步、增量、原子存储；消息 ID 与状态机；history 上限 | UX-07、ARC-06 |
| 2.4 | `messaging` 服务：发送任务、失败重试、取消（预留 outbox 接口） | ARC-03 |
| 2.5 | webview 构建管线：esbuild 打包 + 外置 CSS + codicon + 类型化消息 + `ready` 握手 + `getState/setState` | ARC-01、UX-14 |
| 2.6 | 清除 45 处 `[DEBUG]`，统一走 logger；清理死代码 | ARC-09 |
| 2.7 | 测试体系：`test:unit`（纯 mocha，不启动 VS Code）覆盖 kcp、registry、discovery、仲裁、fileReceiver；`test:vscode` 保留集成测试。CI（若仓库托管在 GitHub）用 macOS/Windows/Ubuntu 三平台矩阵跑 `test:unit`，`test:vscode` 跑最低支持版本 1.92 与 stable | ARC-08、PLT-06/16 |

### M3 产品体验重做

| 编号 | 内容 | 解决 |
|---|---|---|
| 3.1 | 新 webview：联系人页 + 会话页 + 空状态与引导 | UX-07/08/12 |
| 3.2 | 气泡、时间分隔、送达状态、失败重试；文件卡片（进度/速度/取消/打开/在文件夹中显示/图片预览）；代码块（复制）；系统事件弱化 | UX-09/10/11、CAP-04 |
| 3.3 | 状态栏项、活动栏徽标、通知（回复/打开/定位） | UX-04/05/06 |
| 3.4 | 标题栏精简、命令分类、状态随 `setContext` 切换 | UX-13 |
| 3.5 | 编辑器与资源管理器右键发送 | CAP-01/02 |
| 3.6 | 原生设置替代设置面板；联系人管理并入列表；**删除 `settingsPanel.ts`、`peersEditor.ts`**；构建指纹移到"关于/诊断" | UX-17/19、CFG-08 |
| 3.7 | 拖拽与粘贴截图 | CAP-03 |
| 3.8 | 联系人详情显示对端系统与版本（如"Windows · v0.1.0 · 构建 a1b2c3d4"）；快捷键用 `key`/`mac` 区分 Ctrl 与 Cmd | PLT-05/16 |

### M4 信任与增强（可选）

| 编号 | 内容 |
|---|---|
| 4.1 | 房间/口令：发现与握手带 HMAC，只显示同房间对端（SEC-01） |
| 4.2 | 接收策略：询问 / 自动接收已知联系人 / 大小上限（SEC-02、CAP-07） |
| 4.3 | 离线待发队列（CAP-06） |
| 4.4 | 文件夹发送（压缩）、传输取消续传 |
| 4.5 | 载荷加密（AES-GCM，SEC-03） |
| 4.6 | 多窗口守护进程（沿用 [DAEMON-DESIGN.md](DAEMON-DESIGN.md)，N-14） |

### 验收标准

| 项 | 标准 |
|---|---|
| 发现 | 两台机器在 /22 网络启动后 10 秒内互相显示在线；广播被过滤时靠单播探测 30 秒内找到已配置对端 |
| 重启恢复 | 对端重启、睡眠唤醒后 3 秒内可再次发送，无需用户重试 |
| 换 IP | DHCP 换 IP 后 1 分钟内同一联系人地址自动更新，无重复条目 |
| 状态 | 服务启停、启动失败、端口被占都有明确可见的状态与原因；单向可达显示 🟡 并给出提示 |
| 文件 | 接收 1GB 文件内存峰值 < 100MB，期间 UI 不卡顿；0 字节、同名并发、中途失败重发均正确 |
| 输入 | 输入法组合期间 Enter 不发送；多行消息与代码保留换行 |
| 提醒 | 收到文本/文件时有徽标与通知，通知可直达会话或文件 |
| 测试 | `test:unit` 无需 VS Code，覆盖广播计算、网卡过滤（含各系统夹具）、仲裁、peers 合并、状态机、fileReceiver（含 Windows 保留名等文件名用例）、kcp 丢包环回；三平台 CI 全绿 |
| 跨平台 | Mac ↔ Windows、Windows ↔ Windows、Mac ↔ Mac 均可互相发现，收发文本与文件；睡眠唤醒、换 IP、对端重启后自动恢复；网络错误不再产生未处理的 `error` 事件 |

### 跨平台验收矩阵

每个里程碑联调时，按下表挑选组合验证；M1、M2 结束时必须覆盖"系统组合"的全部三种。

| 维度 | 取值 |
|---|---|
| 系统组合 | Mac ↔ Windows、Windows ↔ Windows、Mac ↔ Mac |
| 系统语言 | 中文 Windows（网卡名本地化）、英文 Windows、macOS |
| 网络 | 有线、Wi-Fi；代理 TUN 开/关；/24 与 /22 网段 |
| 防火墙 | Windows 公用/专用网络配置文件；macOS 应用防火墙开/关；macOS 15 起的本地网络权限允许/拒绝 |
| 生命周期 | 睡眠唤醒、DHCP 换 IP、切换 Wi-Fi、对端重启 |
| 文件名 | 中日韩文、emoji、NFD 与 NFC 同名、`CON.txt`、末尾为点或空格、超长名（>200 字符）、0 字节 |
| 文件内容 | 二进制、>1GB、被其他程序占用的文件（如已打开的 Excel） |
| 文本 | 多行、CRLF 与 LF、含代码块、中文输入法回车 |
| VS Code | 最低支持版本 1.92 与最新稳定版混搭 |

### 风险与回滚

| 风险 | 对策 |
|---|---|
| 协议升级与旧版不兼容 | 保留旧版回退（6.4）；先升一端验证再升另一端 |
| 旧数据迁移出错 | 迁移前自动备份 `peers.json`、`chatSessions.json`；迁移可重复执行 |
| M3 界面重写工作量大 | M2 先把核心与前端管线拆好；M1.10 先止血，保证 M3 期间旧界面可用 |
| 补 `publisher` 导致存储目录变化 | 一次性迁移，保留旧目录一个版本周期 |
| 在线三态依赖对端也升级 | 旧版对端按 🟢/⚪ 两态显示 |
| 两端 VS Code / Node / 系统版本不一致 | 最低支持 1.92 持续测试；协议带版本与 `meta`；不使用高于最低版本的 API |
| 平台行为（防火墙、本地网络权限、睡眠）只能实机验证 | M1 的诊断命令先上线，两端各跑一次，用报告确认后再下结论 |

## 8. 待决策

| # | 议题 | 建议 |
|---|---|---|
| 1 | 实施范围与顺序 | M0 → M1 → M2 → M3，M4 视需求；每个里程碑做完联调一次再进下一个 |
| 2 | webview 前端技术 | Preact（推荐）或原生 TS |
| 3 | `oschat.theme` | 删除 |
| 4 | 补 `publisher` 及其名称 | 需要你给名称；暂不发布则只修测试里的 id |
| 5 | `autoConnect` 默认值 | 改为 `true`（配合 `onStartupFinished`） |
| 6 | `scanSubnet` 扫描网段 | 做成手动命令，不自动跑（避免触发入侵检测） |
| 7 | 协议兼容旧版 | 保留回退 |
| 8 | 命令 id（`myChat.*`）与配置前缀（`oschat.*`） | 保持不变，只改标题、分类与对外名称 |
| 9 | 房间口令、接收策略是否进本轮 | 放 M4，按需 |
| 10 | 本文档是否入库 | 建议入库作为实施清单，完成后归档 |
| 11 | 默认下载目录 | 改为 `~/Downloads/OS Chat`（Mac 与 Windows 都有 Downloads），启动时校验可写 |
| 12 | 是否引入三平台 CI | 建议引入（需仓库托管在 GitHub；当前 `repository` 是占位地址） |
| 13 | KCP 默认 MTU | 1200，牺牲一点吞吐换取 VPN/TUN 下的稳定 |
| 14 | 组播二级发现 | 放 M4，先用诊断命令确认你们的网络是否真的过滤广播 |
