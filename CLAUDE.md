# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

"Oecophylla smaragdina"——一个用于小型局域网（内网）简单通信的 VS Code 插件，提供侧边栏聊天界面，支持点对点消息和文件传输。TypeScript 开发，esbuild 打包。界面文本、注释、提交信息均为中文。

## 关键命令

- `npm run watch` - 开发模式（并行运行 esbuild 打包和 tsc 类型检查监听）
- `npm run compile` - 完整编译（check-types + lint + esbuild）
- `npm run check-types` - 仅 TypeScript 类型检查（`tsc --noEmit`）
- `npm run lint` - ESLint 检查 src 目录
- `npm run test` - 运行测试（自动先执行 compile-tests、compile、lint），基于 @vscode/test-cli（mocha）
- `npm run package` - 生产打包
- 单测试运行：`npm run compile-tests` 后在 VS Code 中使用测试面板；测试文件在 `src/test/`

调试：在 VS Code 中按 F5 启动 Extension Development Host。打包产物在 `dist/`（运行时）和 `out/`（测试编译输出）。

## 架构

### 双通道网络模型（核心设计）

- **UDP 通道**（`src/networkService.ts` + dgram）：仅用于发现与状态。
  - 主 socket（`oschat.port`，默认 8080）：收发心跳（heartbeat/heartbeat_ack，维护在线/离线）、接收发现应答；peerId 即 `ip:主端口`。
  - 共享发现 socket（固定端口 41320，reuseAddr）：所有实例共同绑定，接收广播 discovery_request——这样同一台机器上主端口不同的多个实例也能互相发现；应答单播回请求方主端口。
- **KCP 业务通道**（专用 UDP 端口 = 主端口 + 1000，`src/kcpTransport.ts` + `src/kcp.ts`）：所有业务消息走这里——聊天消息和文件传输（64KB 分块流式读取、真实进度）。`src/kcp.ts` 是 ikcp.c 的纯 TypeScript 移植（ARQ，无 FEC，零原生依赖）。会话由 SYN/ACK 控制报文握手建立（数据报首字节 0x01 控制/0x02 KCP），握手自带身份（peerId）；双向同时建连时由发起方 peerId 字典序小的会话胜出。KCP 可靠流之上保留 4 字节大端长度前缀 + JSON 帧。KCP 端口通过 UDP 消息的 `transferPort` 字段告知对端。握手（5 秒超时）即在线检测；send 等待对端 KCP 确认，确认无进展 5 秒判定离线快速失败。

`networkService` 是模块级单例（`export const networkService`），是一个 EventEmitter；KcpTransport 由它创建并持有。所有线上消息共用 `NetworkMessage` 接口（`type` 字段区分）。

端到端验证：`npm run compile-tests` 后 `node smoke-test.js`（同机起两个实例互发消息/文件，不依赖 VS Code）。

### 各模块职责

- `src/extension.ts` - 入口：注册命令（myChat.*）、连接 networkService 事件到 PeersManager/ChatViewProvider、按配置自动启动网络服务
- `src/chatViewProvider.ts` - 侧边栏 Webview（视图 ID `OSChatView`）：会话/消息管理、文件分块收发与进度（TransferTask / IncomingFileTransfer）、HTML 界面内联生成
- `src/peersManager.ts` - 聊天对象持久化（peers.json，路径由 `oschat.peersFilePath` 配置）
- `src/peersEditor.ts` / `src/settingsPanel.ts` - peers 编辑与设置的 Webview 面板

数据流：网络事件 → networkService（EventEmitter）→ extension.ts 中的监听器 → PeersManager 更新 + ChatViewProvider.refresh() → webview postMessage。

## 代码风格

- TypeScript strict 模式；ES2022 目标，Node16 模块
- ESLint 规则（warn 级别）：必须分号、必须大括号（curly）、相等比较用 `===`
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
