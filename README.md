# cc-ys

`cc-ys` 是一个把 Feishu 机器人接到 Claude Agent SDK 和 Codex app-server 的本地控制服务。用户在飞书里发送消息，`cc-ys` 通过 WebSocket 长连接接收事件，把请求交给当前配置的智能体执行，再把结果回复到飞书。

当前主线能力包括：

- 支持 Claude 和 Codex 两个后端，可在飞书里切换。
- Codex 使用 `ai-sdk-provider-codex-app-server`，通过 app-server stdio 通讯。
- Codex runtime 长生命周期缓存，避免每轮请求都重启 app-server。
- Codex 执行中支持 `session.injectMessage(...)` 注入新指令。
- 每个飞书 `chat_id` 维护独立工作目录和智能体会话绑定。
- Windows 后台运行，包含 PID、日志、状态检查和隐藏控制台窗口处理。
- message-id 去重和短窗口 content 去重，避免飞书重复投递导致重复回复。

## 工作方式

```text
Feishu message
  -> WebSocket event im.message.receive_v1
  -> cc-ys daemon
  -> Claude Agent SDK or Codex app-server
  -> Feishu reply card
```

Claude 的上下文由 Claude SDK session 管理。Codex 的上下文由 Codex thread 管理。`cc-ys` 只保存飞书会话、本地工作目录、Claude session id 和 Codex thread id 的绑定关系。

## 环境要求

- Node.js >= 18
- npm
- 一个 Feishu/Lark 自建应用机器人
- Claude 或 Codex 所需认证环境变量

常见环境变量：

```sh
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=...
OPENAI_API_KEY=...
CODEX_...
```

后台服务会读取 `cc-ys` 写入的环境文件：

```text
%LOCALAPPDATA%\cc-ys\claude.env
```

虽然文件名保留为 `claude.env`，当前也会保存 `OPENAI_*` 和 `CODEX_*` 变量。

## 安装

```sh
npm install
npm run build
```

查看状态：

```sh
node dist/cli.js status
```

如果需要全局命令：

```sh
npm link
cc-ys status
```

## 初始化

```sh
cc-ys init
```

初始化会询问：

- Feishu/Lark domain
- agent backend: `claude` 或 `codex`
- App ID / App Secret
- Verification Token / Encrypt Key
- 默认工作目录
- Claude max turns / timeout
- Codex binary path，可留空使用 provider 默认
- 是否启动后台服务

配置文件路径：

```sh
cc-ys config path
```

查看配置：

```sh
cc-ys config list
```

## Feishu/Lark 配置要点

在开放平台创建自建应用后：

1. 启用机器人能力。
2. 开通发送消息和接收消息相关权限。
3. 在事件订阅里选择“使用长连接接收事件”。
4. 添加事件 `im.message.receive_v1`。
5. 发布或安装应用到企业/租户。
6. 把机器人加入目标私聊或群聊。

常见权限 scope 包括：

```text
im:message:send_as_bot
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message.group_msg
im:message:readonly
```

不同租户后台显示名称可能不同，以 Feishu/Lark 后台提示为准。

## 启动和日志

前台调试：

```sh
cc-ys start --foreground
```

后台运行：

```sh
cc-ys start
cc-ys stop
cc-ys status
```

查看日志：

```sh
cc-ys logs
cc-ys logs --follow
```

Windows 日志默认在：

```text
%LOCALAPPDATA%\cc-ys\cc-ys.log
%LOCALAPPDATA%\cc-ys\cc-ys.error.log
```

## 飞书命令

在飞书聊天里发送：

```text
/cc help
```

可用命令：

```text
/cc cd <path>              切换当前聊天的工作目录，并清理上下文
/cc pwd                    显示当前工作目录
/cc clear                  清理当前聊天的智能体会话
/cc status                 显示当前聊天状态
/cc agent                  显示当前智能体
/cc agent claude           切换到 Claude
/cc agent codex            切换到 Codex
/cc claude                 快捷切换到 Claude
/cc codex                  快捷切换到 Codex
/cc restart                重启当前聊天的 Codex runtime
```

`/cc cd <path>` 会创建新会话。这样可以避免切换目录后继续沿用旧项目上下文。

`/cc restart` 只释放当前聊天的 Codex app-server runtime；下一次 Codex 请求会重新启动 app-server，并继续使用保存的 Codex thread。需要完全新上下文时使用 `/cc clear`。

## Codex

Codex 当前通过：

```ts
createCodexAppServer(...)
streamText(...)
session.injectMessage(...)
```

运行方式是 provider 管理的 app-server over stdio。项目代码不直接手写 `spawn("codex", ...)` 作为业务调用方式。

默认模型：

```text
gpt-5.3-codex
```

修改 Codex 配置：

```sh
cc-ys config set agent.provider codex
cc-ys config set codex.model gpt-5.3-codex
cc-ys config set codex.reasoningEffort medium
cc-ys config set codex.timeoutMs 300000
cc-ys config set codex.networkAccessEnabled true
cc-ys config set codex.codexBin C:\path\to\codex.cmd
```

恢复默认 Codex binary：

```sh
cc-ys config set codex.codexBin default
```

Codex 执行中如果同一个飞书会话又收到新消息，`cc-ys` 会调用 `session.injectMessage(...)` 注入到当前运行中的 Codex turn，而不是新开第二个 Codex 执行。

## Claude

修改 Claude 配置：

```sh
cc-ys config set agent.provider claude
cc-ys config set claude.defaultWorkDir C:\repo\project
cc-ys config set claude.maxTurns 20
cc-ys config set claude.timeoutMs 300000
```

Claude 执行结果会保存 `claudeSessionId`，后续消息默认 resume 同一会话。

## Windows

Windows 下 `cc-ys start` 会启动一个后台 Node daemon，并将 PID 和日志写入 `%LOCALAPPDATA%\cc-ys`。

为了避免弹出控制台窗口：

- `cc-ys` daemon spawn 使用 `windowsHide: true`。
- Codex provider 的 app-server spawn 也通过 `scripts/patch-codex-provider.js` 补上 `windowsHide: true`。
- `postinstall` 会在 `npm install` 后重新应用这个 provider 补丁。

## 常见问题

### 飞书没有响应

先看日志是否收到消息：

```sh
cc-ys logs
```

如果没有 `[Message ...]`，优先检查 Feishu/Lark 事件订阅、权限、应用发布状态和机器人是否加入会话。

如果有 `[Message ...]` 但没有回复，查看错误日志：

```sh
cc-ys logs --follow
```

或直接查看：

```text
%LOCALAPPDATA%\cc-ys\cc-ys.error.log
```

### 连续两次相同消息没有响应

`cc-ys` 会按 message-id 去重，并对相同内容做 2 秒短窗口去重。正常人工连续发送同样内容，只要间隔超过 2 秒，不会被丢弃。

日志会区分：

```text
Duplicate message-id
Duplicate content
```

### Codex 状态异常

先在飞书里执行：

```text
/cc restart
```

如果需要完全新上下文：

```text
/cc clear
```

然后重新发送请求。

### 修改配置后没有生效

配置修改后建议重启服务：

```sh
cc-ys stop
cc-ys start
```

## 当前限制

- 飞书图片/截图消息还没有接入 Codex 图片输入。
- `codex app-server --listen stdio://` 由 provider 内部以 stdio pipe 方式实现；当前 provider 没有暴露额外 app-server 参数。
- `node_modules` 里的 Codex provider 隐藏窗口补丁依赖 `postinstall` 重新应用。

## 相关链接

- Feishu 开放平台：https://open.feishu.cn/app
- Feishu 接收消息事件：https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
- Feishu 回复消息 API：https://open.feishu.cn/document/server-docs/im-v1/message/reply
