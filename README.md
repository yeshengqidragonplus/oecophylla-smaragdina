# Oecophylla smaragdina

一个用于小型局域网（内网）简单通信的 VS Code 插件：侧边栏聊天界面，支持点对点文本消息与文件传输，自动发现同网段的其他实例，无需任何中心服务器。

## 功能特性

- 在 VS Code 侧边栏提供聊天界面
- 局域网内自动发现其他实例（含同一台机器上的多个 VS Code 实例）
- 点对点文本消息与文件传输（文件分块发送，实时进度）
- 在线/离线状态实时显示（心跳检测）
- 可配置聊天对象（peers.json，可手工维护）
- 自定义主题（跟随 VS Code 主题/浅色/深色）

## 使用方法

1. 安装插件后，点击活动栏的机器人图标打开聊天视图。
2. 执行 **启动网络服务** 命令（或开启 `oschat.autoConnect` 自动启动），输入监听端口和昵称。
3. 同一局域网内启动了本插件的其他机器会自动出现在列表中；也可通过 **编辑聊天对象** 手工添加。
4. 选择聊天对象即可发送消息或文件；接收的文件保存到 `oschat.downloadPath` 配置的目录。

### 主要命令

- **启动网络服务** / **停止网络服务** - 启停局域网通信服务
- **新建会话** - 创建新的聊天会话
- **编辑聊天对象** - 管理聊天联系人（也可直接 **打开 peers.json 文件** 编辑）
- **设置** - 配置插件参数

## 网络与防火墙要求

插件使用以下端口（详细协议设计见[设计文档](docs/DESIGN.md)）：

| 端口 | 协议 | 用途 |
|------|------|------|
| `oschat.port`（默认 8080） | UDP | 发现应答与心跳 |
| 41320（固定，所有实例共享） | UDP | 接收广播发现请求 |
| `oschat.port` + 1000（默认 9080） | TCP | 聊天消息与文件传输 |

如果对方一直显示离线或发现不到，请确认防火墙放行了上述端口，且双方在同一网段（依赖 UDP 广播）。

## 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `oschat.port` | 网络服务监听端口（UDP；TCP 业务端口为此值 + 1000） | 8080 |
| `oschat.nickname` | 你的昵称（可选） | "" |
| `oschat.autoConnect` | 启动时自动启动网络服务 | false |
| `oschat.peersFilePath` | peers.json 保存的文件夹路径，留空使用扩展全局存储目录 | "" |
| `oschat.downloadPath` | 接收文件保存的文件夹路径，留空使用默认位置 | "" |
| `oschat.theme` | 聊天界面主题（default/light/dark） | default |

peers.json 格式示例：

```json
[{ "ip": "192.168.1.100", "port": 8080, "nickname": "用户A", "hostname": "PC-A" }]
```

## 已知限制

- 协议不加密、无身份认证，仅适用于受信任的小型内网环境
- 聊天消息不持久化，仅保留在当次会话中
- 不支持群聊和跨网段（NAT）通信

如有问题请在 GitHub 提交 Issue。

## 开发

- `npm run watch` - 开发模式（F5 启动 Extension Development Host 调试）
- `npm run compile` - 类型检查 + lint + 打包
- `npm run test` - 运行测试
- `npm run compile-tests && node smoke-test.js` - 端到端冒烟测试（同机双实例互发消息/文件，不依赖 VS Code）

架构与协议设计详见 [docs/DESIGN.md](docs/DESIGN.md)，开发约定见 [CLAUDE.md](CLAUDE.md)。

## 版本说明

见 [CHANGELOG.md](CHANGELOG.md)。
