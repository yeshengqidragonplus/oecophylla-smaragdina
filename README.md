# Oecophylla smaragdina

一个用于小型内网简单通信的 VS Code 插件。

## 功能特性

- 在 VS Code 侧边栏提供聊天界面
- 支持局域网内简单通信
- 可配置聊天对象（peers）
- 支持文件传输
- 自定义主题（跟随 VS Code 主题/浅色/深色）

## 使用方法

安装插件后，点击活动栏的机器人图标打开聊天视图。

### 主要命令

- **设置** - 配置插件参数
- **新建会话** - 创建新的聊天会话
- **启动网络服务** - 启动局域网通信服务
- **停止网络服务** - 停止通信服务
- **编辑聊天对象** - 管理聊天联系人

## 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `oschat.port` | 网络服务监听端口 | 8080 |
| `oschat.nickname` | 你的昵称（可选） | "" |
| `oschat.autoConnect` | 启动时自动启动网络服务 | false |
| `oschat.peersFilePath` | 聊天对象 JSON 文件保存的文件夹路径 | 当前工作目录 |
| `oschat.downloadPath` | 接收文件保存的文件夹路径 | 默认位置 |
| `oschat.theme` | 聊天界面主题（default/light/dark） | default |

## 已知问题

如有问题请在 GitHub 提交 Issue。

## 版本说明

### 0.0.1

初始版本
