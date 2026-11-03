# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

"Oecophylla smaragdina"——一个用于小型局域网（内网）简单通信的 VS Code 插件，提供侧边栏聊天界面，支持点对点消息和文件传输。TypeScript 开发，esbuild 打包。界面文本、注释、提交信息均为中文。

## 关键命令

- `npm run watch` - 开发模式（并行运行 esbuild 打包和 tsc 类型检查监听）
- `npm run compile` - 完整编译（check-types + lint + esbuild）
- `npm run check-types` - 仅 TypeScript 类型检查（`tsc --noEmit`）
- `npm run lint` - ESLint 检查 src 目录（含类型感知规则 no-floating-promises）
- `npm run test:unit` - 单元测试（先 compile-tests，再用 mocha 跑 `out/test/unit/**`，**不启动 VS Code**，秒级反馈）；单个用例：`npx mocha --ui tdd out/test/unit/<文件>.test.js --grep "<用例名>"`
- `npm run test` - 集成测试（自动先执行 compile-tests、compile、lint），基于 @vscode/test-cli（mocha），需要 VS Code 环境（首次会下载 VS Code）；单个用例：`npm run compile-tests` 后 `npx vscode-test --grep "<用例名或套件名>"`
- `npm run package` - 生产打包
- 端到端冒烟：`npm run compile-tests` 后 `node smoke-test.js`（同机起两个实例互发消息/文件，不依赖 VS Code）

调试：在 VS Code 中按 F5 启动 Extension Development Host（`.vscode/launch.json` 已入库）。打包产物在 `dist/`（运行时）和 `out/`（测试编译输出）。

注意：`oecophylla-smaragdina-0.0.1.vsix` 被 git 跟踪，重新打包后会显示为已修改；按"只提交本次功能相关内容"的约定，除非任务就是发版，否则不要把它带进提交。

## 架构

### 双通道网络模型（核心设计）

- **UDP 通道**（`src/core/networkService.ts` + dgram）：仅用于发现与状态。
  - 主 socket（`oschat.port`，默认 8080）：收发心跳（heartbeat/heartbeat_ack）、发现应答与单播探测。
  - 共享发现 socket（固定端口 41320，reuseAddr）：所有实例共同绑定，接收广播 discovery_request——这样同一台机器上主端口不同的多个实例也能互相发现；应答单播回请求方主端口。
  - 发现：每 30 秒（启动后 1、3 秒快速补发）向**每块可用网卡的定向广播地址**（`ip | ~mask` 位运算）和 255.255.255.255 广播；另对**所有已知对端持续单播探测**（在线 30 秒心跳，离线 30/60 秒发现请求）。
- **KCP 业务通道**（专用 UDP 端口 = 主端口 + 1000，`src/core/kcpTransport.ts` + `src/core/kcp.ts`）：所有业务消息走这里——聊天消息和文件传输（64KB 分块流式读取、真实进度）。`kcp.ts` 是 ikcp.c 的纯 TypeScript 移植（ARQ，无 FEC，零原生依赖）。会话由 SYN/ACK/FIN/RST 控制报文握手建立（数据报首字节 0x01 控制/0x02 KCP），握手自带身份（实例 ID `iid`，旧版对端退回 `ip:端口`）与 `boot` 启动标识；同一发起方换 conv 或 boot 变化时直接替换旧会话，仅双向同时建连时才按 id 字典序仲裁；未知 conv 的包回 RST 让对端立刻销毁僵尸会话。KCP 可靠流之上保留 4 字节大端长度前缀 + JSON 帧。握手（5 秒超时）即在线检测；send 等待对端 KCP 确认，确认无进展 5 秒判定离线；会话失效类错误（`KcpError`）由 networkService 重建会话重发一次。MTU 1200。

`networkService` 是模块级单例（`export const networkService`），是一个 EventEmitter；KcpTransport 由它创建并持有。所有线上消息共用 `NetworkMessage` 接口（`type` 字段区分）。`NetworkService` 类本身也导出，测试和 `smoke-test.js` 直接 `new` 多个实例。事件：`peersUpdate` / `statusChange` / `message` / `transferTask*` / `networkError` / `networkResume`。

### 对端模型（PeerRegistry）

`src/core/peerRegistry.ts` 是对端的**唯一数据源**（`networkService.registry`），`PeersManager` 只是它的持久化与视图投影，不要再在别处保存对端状态。
- 身份是稳定的实例 ID（`iid` = `机器标识:主端口`）；IP 只是最近一次观察到的地址（取自 `rinfo`，不取对端自称）；历史 id 保留在 `aliases`，旧会话据此对应到同一联系人。换 IP 不产生新联系人。
- 在线三态由**往返确认**决定：online / oneway（能收到对方的包但无往返确认，多半是防火墙）/ offline；状态不写入 peers.json。
- 手工条目（`manual`）永不自动清理；自动发现的 30 天未见清理。

### 约定与易踩点

- `src/core/` 下的模块**不得 import `vscode`**——它们要能在 VS Code 之外运行（冒烟测试、`test:unit`）。日志一律走 `core/logger.ts` 的 `log` / `logError`（控制台 + 激活时注入的"OSChat 日志"输出通道）。
- **不得 `emit('error')`**（无监听者会直接抛出）：运行期 socket 错误走 `networkError` / `transportError`，经 `core/netErrors.ts` 分类并限流记录；**所有 UDP `send` 必须带回调**；socket 的 `error` 监听必须常驻，不用 `once`。
- KCP 端口默认按"主端口 + 1000"推算：对端 id 不在注册表时（如启动后才新增的聊天对象），`_resolvePeer` 按 `ip:端口` 即时补建，无需重启网络服务。
- peers.json 读不出可信内容时绝不写盘（`core/peerFileStore.ts`：路径不可用 / 文件损坏），写盘为原子替换。
- 所有设置都是 `machine` 级（不被 Settings Sync 同步）；端口范围 1024–64535（业务端口 = 主端口 + 1000）；启动入口统一为 `networkLauncher.startNetworkFromConfig`，读取最新设置，不要把临时参数写回用户设置。
- 常量：探测节奏在 `core/probeSchedule.ts`，在线超时 90 秒与宽限期在 `core/peerRegistry.ts`，发现间隔等在 `core/networkService.ts` 顶部；文件块 64KB（`FILE_CHUNK_SIZE`）。
- 传输任务事件：`transferTaskCreated` / `transferTaskUpdated` / `transferTaskCompleted` / `transferTaskFailed`，由 `ChatViewProvider` 订阅以刷新进度。

### 各模块职责

- `src/core/*` - 不依赖 vscode：networkService、kcp / kcpTransport、peerRegistry、netInterfaces（网卡与广播）、probeSchedule、netErrors、diagnostics、peerFileStore、logger、buildInfo
- `src/extension.ts` - 入口：装配各模块、注册命令（myChat.*）、按配置自动启动网络服务
- `src/networkLauncher.ts` - 启动/停止网络服务的统一入口，准备本机稳定标识与版本信息
- `src/peersManager.ts` - 联系人持久化（peers.json，路径由 `oschat.peersFilePath` 配置）与视图，数据来自 PeerRegistry
- `src/chatViewProvider.ts` - 侧边栏 Webview（视图 ID `OSChatView`）：会话/消息管理、文件分块收发与进度（TransferTask / IncomingFileTransfer）、未读提醒、HTML 界面内联生成
- `src/statusBar.ts` / `src/diagnose.ts` - 状态栏与标题栏启停切换；诊断报告（`myChat.diagnose`）与手动扫描网段（`myChat.scanSubnet`）
- `src/peersEditor.ts` / `src/settingsPanel.ts` - peers 编辑与设置的 Webview 面板（计划用原生设置替代）

更详细的协议与流程见 `docs/DESIGN.md`（权威设计文档，改动传输层/协议后需同步）；`docs/HEALTH-CHECK.md` 是体检报告与 M0–M4 改造清单（含实施进度）；`docs/DAEMON-DESIGN.md` 是"多窗口共享单实例守护进程"的**方案设计，尚未实现**（`src/` 下没有 daemon / ipc 代码），不要当作现状。

数据流：网络事件 → networkService / PeerRegistry（EventEmitter）→ ChatViewProvider / PeersManager / statusBar 的监听器 → webview postMessage、状态栏与 peers.json 更新。

## 代码风格

- TypeScript strict 模式；ES2022 目标，Node16 模块
- ESLint 规则（warn 级别）：必须分号、必须大括号（curly）、相等比较用 `===`、不留悬空 Promise（no-floating-promises，不需要等待的用 `void`）、不留未使用变量（`_` 前缀豁免）
- 注意传输层资源管理：重建 KcpTransport 前先 `removeAllListeners()` + `stop()`（历史上有事件监听泄漏 bug）
- 接收文件名必须经过 `path.basename` + 非法字符过滤（防路径穿越），同名文件加序号不覆盖

## Encoding

所有文本/文件编辑必须使用 UTF-8 编码，以正确处理注释和界面中的中文字符。

## Git 约定

注意：AGENTS.md 是给 RooCode 看的，其中的 `AI(DS4)` 前缀不适用于 Claude Code。

- 提交信息格式：`AI(CC)-提交内容分类：具体内容概括`，多内容时一句概述后换行用 1、2、3 列出
- 只 commit，不要 push
- 按功能颗粒度细一点提交，方便以后整体 revert
- 每次提交只包含本次功能修改相关内容，不是你改的不要提交
