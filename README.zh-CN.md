# raven-ts

**语言：** [English](README.md) | 简体中文

`raven-ts` 是一个本地飞书/Lark 机器人服务，可以在聊天中控制 Claude Agent SDK 和 Codex app-server。

用户在飞书/Lark 中发送消息，`raven-ts` 通过机器人 WebSocket 事件流接收消息，调用当前配置的 Agent 后端，然后用消息卡片回复。

## 功能特性

- 支持 Claude 和 Codex 两种后端。
- 支持在聊天中通过 `/r claude` 和 `/r codex` 动态切换运行后端。
- 通过 `ai-sdk-provider-codex-app-server` 调用 Codex app-server。
- Codex app-server 使用 provider 托管的 stdio 通道运行。
- 长生命周期的 Codex runtime 缓存，避免每轮对话都重启 Codex。
- 支持通过 `session.injectMessage(...)` 向正在运行的 Codex 会话注入新指令。
- 按聊天维护工作目录和 Agent 会话绑定。
- 支持 Windows 后台服务，包含 PID、日志、状态检查和隐藏控制台窗口。
- 支持飞书/Lark 事件去重，包括 message-id 去重和短时间内容去重。

## 消息流程

```text
飞书/Lark 消息
  -> 通过 WebSocket 接收 im.message.receive_v1
  -> raven-ts daemon
  -> Claude Agent SDK 或 Codex app-server
  -> 飞书/Lark 消息卡片回复
```

Claude 上下文由 Claude SDK session 管理。Codex 上下文由 Codex thread 管理。`raven-ts` 只保存本地元数据：chat id、工作目录、Claude session id 和 Codex thread id。

## 环境要求

- Node.js >= 18
- npm
- 一个飞书/Lark 自建机器人应用
- Claude 或 Codex 所需的认证环境变量

常见变量：

```sh
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=...
OPENAI_API_KEY=...
CODEX_...
```

后台服务会从以下文件导入环境变量：

```text
%LOCALAPPDATA%\raven-ts\claude.env
```

文件名为了兼容历史版本仍保留为 `claude.env`，但其中可以放置 `ANTHROPIC_*`、`OPENAI_*` 和 `CODEX_*`。

## 安装

```sh
npm install
npm run build
```

本地运行 CLI：

```sh
node dist/cli.js status
```

可选的全局链接：

```sh
npm link
raven-ts status
```

## 初始化

```sh
raven-ts init
```

初始化命令会询问：

- 飞书/Lark 域名
- Agent 后端：`claude` 或 `codex`
- App ID 和 App Secret
- 可选的 Verification Token 和 Encrypt Key
- 默认工作目录
- Claude 最大轮数和超时时间
- 可选的 Codex binary 路径
- 是否启动后台服务

查看配置：

```sh
raven-ts config list
raven-ts config path
```

## 飞书/Lark 配置

在飞书/Lark 开发者后台中：

1. 创建自建应用。
2. 启用机器人能力。
3. 启用接收和发送消息所需权限。
4. 启用长连接事件订阅。
5. 添加 `im.message.receive_v1` 事件。
6. 发布或安装应用。
7. 将机器人添加到目标聊天。

常见权限范围包括：

```text
im:message:send_as_bot
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message.group_msg
im:message:readonly
```

不同租户中的权限名称可能略有差异。添加 `im.message.receive_v1` 时，以开发者后台提示为准。

## 启动和日志

前台模式：

```sh
raven-ts start --foreground
```

后台服务：

```sh
raven-ts start
raven-ts stop
raven-ts status
```

日志：

```sh
raven-ts logs
raven-ts logs --follow
```

Windows 日志路径：

```text
%LOCALAPPDATA%\raven-ts\raven-ts.log
%LOCALAPPDATA%\raven-ts\raven-ts.error.log
```

## 聊天命令

在飞书/Lark 中发送命令：

```text
/r help
/r cd <path>
/r pwd
/r clear
/r status
/r agent
/r agent claude
/r agent codex
/r claude
/r codex
/r restart
```

命令行为：

- `/r cd <path>` 修改工作目录，并清空当前 Agent 上下文。
- `/r clear` 清空当前聊天的 Agent 会话，同时保留工作目录。
- `/r restart` 释放当前聊天的 Codex runtime；下一次 Codex 请求会启动新的 app-server，并恢复已保存的 thread。
- `/r claude` 和 `/r codex` 切换 Agent 后端。

## Codex

Codex 通过以下 API 调用：

```ts
createCodexAppServer(...)
streamText(...)
session.injectMessage(...)
```

应用代码不会手动实现 Codex JSON-RPC。provider 会负责本地 app-server 进程和 stdio 传输。

默认模型：

```text
gpt-5.3-codex
```

配置示例：

```sh
raven-ts config set agent.provider codex
raven-ts config set codex.model gpt-5.3-codex
raven-ts config set codex.reasoningEffort medium
raven-ts config set codex.timeoutMs 300000
raven-ts config set codex.networkAccessEnabled true
raven-ts config set codex.codexBin C:\path\to\codex.cmd
```

将 Codex binary 重置为 provider 默认值：

```sh
raven-ts config set codex.codexBin default
```

如果同一个聊天中 Codex 仍在运行时收到了第二条消息，`raven-ts` 会把新指令注入到当前活跃的 Codex session，而不是再启动一个新的运行任务。

## Claude

配置示例：

```sh
raven-ts config set agent.provider claude
raven-ts config set claude.defaultWorkDir C:\repo\project
raven-ts config set claude.maxTurns 20
raven-ts config set claude.timeoutMs 300000
```

Claude 回复会保存 `claudeSessionId`，后续消息会恢复该 SDK session。

## Windows 说明

`raven-ts start` 会运行后台 Node daemon，并将运行时文件保存到：

```text
%LOCALAPPDATA%\raven-ts
```

控制台窗口通过以下方式隐藏：

- 对 raven-ts daemon 使用 `windowsHide: true`。
- 通过 postinstall patch 为 `ai-sdk-provider-codex-app-server` 的 Codex app-server spawn 调用添加 `windowsHide: true`。

patch 脚本：

```text
scripts/patch-codex-provider.js
```

## 从 raven 或 cc-ys 迁移

`raven-ts` 可以迁移已有的 `raven` 和 `cc-ys` 本地数据：

- 旧 `raven` 或 `cc-ys` Conf project 中的配置。
- `~/.raven/sessions` 或 `~/.cc-ys/sessions` 中的会话。
- `%LOCALAPPDATA%\raven\claude.env` 或 `%LOCALAPPDATA%\cc-ys\claude.env` 中的运行时认证环境变量。

迁移完成后，新的运行时文件会使用 `raven-ts` 路径。

聊天命令前缀已变更：

```text
/cc -> /r
```

调试环境变量现在为 `RAVEN_TS_DEBUG_EVENTS`；`RAVEN_DEBUG_EVENTS` 和 `CC_YS_DEBUG_EVENTS` 会继续兼容。

## 故障排查

如果飞书/Lark 没有回复，先检查服务是否收到消息：

```sh
raven-ts logs
```

如果日志中没有 `[Message ...]` 行，请检查机器人权限、事件订阅、应用发布/安装状态，以及机器人是否已经加入目标聊天。

如果 Codex 看起来卡住：

```text
/r restart
```

如果需要清空上下文：

```text
/r clear
```

如果配置变更没有生效：

```sh
raven-ts stop
raven-ts start
```

## 当前限制

- 飞书/Lark 图片和截图消息暂未传递给 Codex image input。
- 当前 provider 未暴露显式的 `codex app-server --listen stdio://`。provider 会在内部通过 stdio pipe 启动 Codex app-server。
- 由于上游 provider 当前没有设置 `windowsHide`，窗口隐藏逻辑通过 `postinstall` patch 应用。
