# 守护进程方案设计（多 VS Code 窗口共享单实例）

## 1. 背景与目标

VS Code 每个窗口是独立的 extension host 进程，插件会在每个窗口各激活一次。当前网络模型（`networkService.ts`）在激活时直接绑定对外端口：

- 主 UDP 端口（`oschat.port`，默认 8080）——发现/心跳
- KCP 端口（主端口 + 1000）——业务消息/文件
- 共享发现端口 41320（reuseAddr，可共存）

多开窗口会导致：主端口 / KCP 端口 `EADDRINUSE`、`peerId = ip:主端口` 身份分裂、在线状态与会话各窗口割裂。

**目标**：一台电脑、同一配置端口下，对外只呈现**一个**账户/实例；任意数量 VS Code 窗口共享它；关掉单个窗口不影响其它窗口；提供逃生舱命令兜底。

**已确定的取舍**（讨论结论）：

| 议题 | 决定 |
|---|---|
| 总体架构 | 独立常驻**守护进程（daemon）**，所有窗口均为 IPC 客户端 |
| 选主/独占 | bind 派生 IPC 端口抢锁，保证全机最多一个 daemon |
| 生命周期 | refcount：窗口注册 +1 / 注销 -1 |
| 引用归零 | **进入休眠态**（停止对外收发，进程保留），不退出 |
| 崩溃残留 | 接受。最多残留一个；休眠态不干扰网络；靠强杀命令兜底 |
| 版本对齐 | 注册时版本握手，不符则替换 daemon |
| IPC 鉴权 | 握手 token（当前用户私有文件） |
| 逃生舱 | PID 文件 + `status` / `kill` / `restart` 三命令 |

---

## 2. 进程拓扑

```
            ┌─────────────────────────────────────────────┐
            │              daemon (常驻 Node 进程)          │
            │  ┌───────────────────────────────────────┐  │
            │  │ NetworkEngine（现 NetworkService 逻辑）│  │
            │  │  UDP 发现/心跳 + KCP 业务/文件          │  │
            │  └───────────────────────────────────────┘  │
            │  IpcServer (127.0.0.1:IPC_PORT)              │
            │  refcount / 休眠态 / 版本 / token            │
            └───────▲───────────────▲───────────────▲─────┘
                    │ IPC 长连接     │                │
        ┌───────────┴──┐   ┌────────┴─────┐   ┌──────┴───────┐
        │ VS Code 窗口1│   │ VS Code 窗口2│   │ VS Code 窗口3│
        │ FollowerProxy│   │ FollowerProxy│   │ FollowerProxy│
        │ (同形接口)   │   │              │   │              │
        └──────────────┘   └──────────────┘   └──────────────┘
```

- **daemon**：承载真实网络引擎 + IPC server，是唯一对外收发的进程。
- **窗口侧 FollowerProxy**：实现与现 `NetworkService` **完全同形**的接口（方法签名 + 事件），把方法调用转成 IPC 请求、把 daemon 推来的事件在本地重放。`extension.ts` / `chatViewProvider.ts` **无需改动**。

### 端口分配

| 用途 | 端口 |
|---|---|
| 对外主 UDP（发现/心跳） | `oschat.port`（默认 8080） |
| 对外 KCP | 主端口 + 1000 |
| 共享发现 | 41320（不变） |
| **IPC（窗口↔daemon）** | **主端口 + 2000**（如 10080），仅 bind `127.0.0.1` |

IPC 端口从主端口派生 → "配置不同端口 = 不同账户"时各自独立选主，语义自洽。

---

## 3. 关键文件落点

| 文件 | 角色 |
|---|---|
| `src/daemon/engine.ts` | 由现 `networkService.ts` 的 `NetworkService` 类**改名 `NetworkEngine`**（网络逻辑不动） |
| `src/daemon/daemonMain.ts` | daemon 进程入口：起 NetworkEngine + IpcServer + 写 PID 文件 + refcount/休眠态 |
| `src/daemon/ipcServer.ts` | daemon 侧：接受连接、鉴权、版本握手、方法路由、事件广播、引用计数 |
| `src/ipc/protocol.ts` | IPC 帧编解码（4 字节大端长度前缀 + JSON）+ 消息类型定义（窗口与 daemon 共用） |
| `src/ipc/followerProxy.ts` | 窗口侧：与 NetworkService 同形接口；连接/重连/版本握手/方法转发/事件重放 |
| `src/ipc/daemonLauncher.ts` | 窗口侧：探测 daemon → 抢锁 → spawn（detached，跨平台）→ 拉起新版替换旧版 |
| `src/ipc/paths.ts` | 统一管理 `~/.oschat/` 下 PID 文件、token 文件路径 |
| `src/networkService.ts` | 改为**门面**：导出的单例仍叫 `networkService`，内部持有一个 FollowerProxy；保持现有 import 不变 |
| `extension.ts` / `chatViewProvider.ts` | **不动**（接口同形）；仅 `extension.ts` 注册新增的 3 个排障命令 |
| `smoke-test.js` | 增加：多客户端注册/转发、选主竞态、休眠态、版本不符替换、强杀重启用例 |

---

## 4. IPC 协议

传输：Node `net` loopback TCP 长连接。帧 = `4 字节大端长度` + `JSON`（复用 KCP 之上的同款分帧约定）。

### 4.1 消息类型

```ts
// 窗口 → daemon：请求
type IpcRequest =
  | { kind: 'hello';     reqId: string; token: string; clientVersion: string; windowId: string }
  | { kind: 'register';  reqId: string }                 // ref+1
  | { kind: 'unregister';reqId: string }                 // ref-1（优雅关闭）
  | { kind: 'call';      reqId: string; method: EngineMethod; args: unknown[] }
  | { kind: 'shutdown';  reqId: string }                 // 强杀命令用：请求 daemon 退出
  | { kind: 'status';    reqId: string };                // 诊断

// daemon → 窗口：响应 + 事件推送
type IpcResponse =
  | { kind: 'helloOk';   reqId: string; daemonVersion: string; pid: number }
  | { kind: 'versionMismatch'; reqId: string; daemonVersion: string }  // 触发替换流程
  | { kind: 'result';    reqId: string; ok: true;  value: unknown }
  | { kind: 'result';    reqId: string; ok: false; error: string }
  | { kind: 'statusInfo';reqId: string; info: DaemonStatus }
  | { kind: 'event';     event: EngineEvent; payload: unknown };       // 主动广播
```

### 4.2 被代理的方法 / 事件（与现 NetworkService 一致）

- **方法 `EngineMethod`**：`start` `stop` `isRunning` `getPeers` `getLocalIp` `sendToPeer` `createTransferTask` `executeTransferTask` `getTransferTasks` `getTransferTask`
- **事件 `EngineEvent`**：`peersUpdate` `message` `transferTaskCreated` `transferTaskUpdated` `transferTaskCompleted` `transferTaskFailed` `error`

> FollowerProxy 必须严格对齐 Promise 语义与抛错时机：`call` 失败时把 `error` 字符串还原成本地 `Error` 抛出，保证 UI 行为不漂移。用一份共享 TS 接口 `INetworkService` 同时约束 NetworkEngine 与 FollowerProxy。

### 4.3 文件传输不经 IPC 传数据（关键）

窗口调 `createTransferTask(peerId, messages, files:[{name,path,size}])` 时，IPC 只发**任务元数据**（含磁盘 `path`）。文件 path 在同机，**daemon 自己从磁盘分块读取并通过 KCP 发送**（现有 `_sendFileChunked` 不动）。进度通过 `transferTaskUpdated` 事件经 IPC 推回所有窗口 → 进度条照常工作。**IPC 上不传 base64 文件内容。**

接收文件落盘目录需为约定的公共位置（非某个窗口的临时态），daemon 决定落盘路径后通过事件告知窗口。

---

## 5. 鉴权与文件

`~/.oschat/`（仅当前用户可读，权限 0600）：

- `daemon-<IPCPORT>.pid` —— daemon 启动写入 `{ pid, version, ipcPort, mainPort, token }`；正常退出删除。
- token：随机生成，写入 PID 文件；窗口 `hello` 时携带，daemon 校验。防止本机其它进程蹭收发能力。

---

## 6. 核心时序

### 6.1 窗口启动 / 注册

```
窗口 activate:
  launcher.ensureDaemon():
    读 PID 文件 → 尝试连 IPC 端口
    ┌ 连上:
    │   发 hello{token, clientVersion}
    │     helloOk            → 发 register(ref+1)，FollowerProxy 就绪
    │     versionMismatch    → 走 6.4 版本替换
    │     token 错           → 报错（异常情况，提示用 kill 命令）
    └ 连不上:
        抢锁 bind(127.0.0.1, IPC_PORT)
          抢到 → spawn daemon(detached) → 轮询重连(退避 100ms×N) → hello/register
          抢不到(EADDRINUSE，别的窗口正在拉起) → 退避重试连接
```

### 6.2 窗口关闭

```
优雅关闭(deactivate): 发 unregister(ref-1) → 关 IPC 连接
崩溃/强杀: 发不出 unregister → IPC 连接断开 → daemon 收到 socket close
           （是否据此 -1 见 6.3 说明）
```

### 6.3 daemon 引用计数与休眠态

```
daemon 维护 refcount（仅由 register/unregister 增减）。
注意：socket 断开不直接 -1（崩溃路径下 unregister 发不出，会虚高——这是已接受的取舍）。
      → 故采用“显式 unregister 减一”为主；崩溃导致的虚高靠强杀命令兜底。

refcount 到 0:
  进入【休眠态】:
    - NetworkEngine.stop()：停心跳/发现广播/KCP，释放“对外活动”但进程保留
    - 不再对端报在线 → 避免“人走了还显示在线”
    - 保留 IpcServer 监听，等待下一次 register
refcount 由 0 回升(新窗口 register):
    - NetworkEngine.start(port, ...) 恢复对外收发
```

> 休眠态只停"对外网络活动"，不退进程、不关 IPC。这样既不误报在线，又省去重启开销。

### 6.4 版本不符替换

```
窗口 hello → daemon 回 versionMismatch{daemonVersion}:
  窗口发 shutdown 请求旧 daemon 退出（旧 daemon 删 PID、close 端口、exit）
  窗口轮询等待 IPC/主/KCP 端口释放（bind 探测，超时重试若干次）
  端口释放后 → 抢锁 → spawn 新版 daemon → hello/register
（若旧 daemon 不响应 shutdown → 提示用户执行 myChat.killDaemon）
```

### 6.5 逃生舱命令

新增 3 个命令（`package.json` contributes.commands + extension.ts 注册）：

| 命令 | 行为 |
|---|---|
| `myChat.daemonStatus` | 连 IPC 取 `DaemonStatus`：pid / version / refcount / 休眠态 / peers / 在线数；连不上则读 PID 文件报告"疑似僵死，PID=xx" |
| `myChat.killDaemon` | ① 发 `shutdown`；② 若无响应，读 PID 文件 `kill`（win: `taskkill /PID xx /F`；mac/linux: `process.kill(pid,'SIGKILL')`）；③ bind 探测确认端口释放；④ 删残留 PID 文件；⑤ 反馈结果 |
| `myChat.restartDaemon` | = killDaemon + 重新 `ensureDaemon` 拉起当前版本 |

PID 文件是逃生舱基础：即使 IPC 完全失联、daemon 僵死，只要 PID 文件在就能直接杀。

---

## 7. 跨平台注意

- **spawn**：`child_process.spawn(process.execPath, [daemonScript], { detached:true, stdio:'ignore', windowsHide:true }).unref()`。runtime 用 VS Code 自带的 `process.execPath`（Electron 的 node，`ELECTRON_RUN_AS_NODE=1`）。
- **Windows**：`windowsHide:true` 避免黑框；强杀用 `taskkill /PID /F /T`。
- **端口释放延迟**：强杀（kill -9）后 OS 可能短时间不放 UDP 端口，新 daemon bind 需重试（退避若干次）。
- **日志**：daemon 独立进程，日志落 `~/.oschat/daemon.log`；窗口侧仍用"OSChat 日志"输出通道，必要时通过 IPC 拉取 daemon 近期日志。

---

## 8. 残留弊端清单（已接受 / 已缓解）

| 弊端 | 状态 |
|---|---|
| 关全部窗口后进程仍在 | 接受（休眠态、不扰网络、最多一个） |
| 崩溃致 refcount 虚高、永不归零 | 接受；`killDaemon` 兜底 |
| 版本对齐 | 已设计版本握手 + 替换流程 |
| 启动竞态 | 抢锁解决 |
| IPC 被本机他进程蹭用 | token 鉴权 |
| 跨平台 spawn/杀进程 | 分平台处理 |
| 调试链路变长 | 独立日志 + status 命令 |

---

## 9. 落地顺序（分功能颗粒度提交，便于回滚）

1. `src/ipc/protocol.ts` + `paths.ts`：协议帧与文件路径底座（含单测）。
2. `src/daemon/engine.ts`：NetworkService → NetworkEngine 改名，抽出 `INetworkService` 接口。
3. `src/daemon/daemonMain.ts` + `ipcServer.ts`：daemon 进程（refcount/休眠态/版本/token/PID）。
4. `src/ipc/daemonLauncher.ts` + `followerProxy.ts`：窗口侧探测/抢锁/spawn/代理。
5. `src/networkService.ts` 门面改造（保持 `networkService` 单例 import 不变）。
6. 3 个逃生舱命令 + `package.json` 注册。
7. `smoke-test.js`：多客户端、竞态、休眠、版本替换、强杀重启端到端验证。
8. 文档与 README 更新（说明常驻进程行为与排障命令）。
