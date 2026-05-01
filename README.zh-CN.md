# raven-ts

**语言：** [English](README.md) | 简体中文

`raven-ts` 是一个本地飞书/Lark 机器人服务，可以在聊天中控制 Claude Agent SDK 和 Codex SDK。

用户在飞书/Lark 中发送消息，`raven-ts` 通过机器人 WebSocket 事件流接收消息，调用当前配置的 Agent 后端，然后用消息卡片回复。

## 功能特性

- 支持 Claude 和 Codex 两种后端。
- 支持在聊天中通过 `/r claude` 和 `/r codex` 动态切换运行后端。
- 通过官方 `@openai/codex-sdk` 的 `runStreamed()` API 调用 Codex。
- Codex 实时流式输出文本，并从最终 `turn.completed` 事件读取 token usage。
- 最终回复卡片会默认折叠展示推理摘要、工具调用和中间事件详情。
- Claude 的高风险 Bash 工具调用可以通过飞书授权卡片允许或拒绝。
- Codex thread id 按聊天持久化保存，后续 turn 会恢复上下文。
- 按聊天维护工作目录和 Agent 会话绑定。
- 支持 Windows 后台服务，包含 PID、日志、状态检查和隐藏控制台窗口。
- 支持飞书/Lark 事件去重，包括 message-id 去重和短时间内容去重。

## 消息流程

```text
飞书/Lark 消息
  -> 通过 WebSocket 接收 im.message.receive_v1
  -> raven-ts daemon
  -> Claude Agent SDK 或 Codex SDK
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

`npm install` 也会执行 raven-ts 的 postinstall 钩子。它会修补 Codex SDK 的窗口行为，并把内置的 `feishu-docx-bot` skill 安装到：

```text
~/.claude/skills/feishu-docx-bot
~/.codex/skills/feishu-docx-bot
```

这个 skill 会告诉 Claude/Codex 如何通过 raven-ts 飞书机器人创建和更新飞书新版文档。它用于把论文检索结果、研究报告和生成的摘要保存到飞书文档中。

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

飞书官方的「应用配置说明」可作为参考：
https://open.feishu.cn/document/develop-a-card-interactive-bot/faqs

对 `raven-ts` 来说，在飞书/Lark 开发者后台按以下方式配置自建应用：

1. 创建自建应用，然后在 **基础信息 > 凭证与基础信息** 中复制 **App ID** 和 **App Secret**，填入 `raven-ts init`。
2. 在 **应用能力** 中添加 **机器人** 能力。没有机器人能力时，应用不能接收消息，也不能以机器人身份回复。
3. 在 **开发配置 > 权限管理 > API 权限** 中申请接收和发送消息所需的应用身份权限。
4. 先启动一次 `raven-ts`，让应用建立长连接：
   ```sh
   raven-ts start --foreground
   ```
5. 在 **开发配置 > 事件与回调 > 事件配置** 中，将订阅方式设置为 **使用长连接接收事件**，并在 `raven-ts` 正在运行时保存。
6. 添加消息事件 `im.message.receive_v1`。如果使用 Claude 授权卡片，还需要添加卡片交互事件 `card.action.trigger`。
7. 创建并发布新的应用版本，在租户中安装或更新应用，然后将机器人添加到目标聊天。

在 **API 权限** 中按 **应用身份权限** 添加以下权限：

| 权限范围 | 飞书/Lark 后台描述 | raven-ts 用途 |
| --- | --- | --- |
| `im:message:send_as_bot` | 以机器人身份发送消息 | 文本回复、交互式回复卡片、Claude 授权卡片、命令响应 |
| `im:message.p2p_msg:readonly` | 获取用户发给机器人的单聊消息 | 接收单聊消息和命令 |
| `im:message.group_at_msg:readonly` | 获取用户在群组中 @ 机器人的消息 | 群聊中通过 @ 机器人使用 |
| `im:message.group_msg` | 获取机器人所在群组中的所有消息 | 可选；需要接收非 @ 群消息时启用 |
| `im:message:readonly` | 获取单聊、群组消息 | 部分租户会把它作为更宽泛或历史版本的消息读取权限 |
| `im:message:update` | 更新应用发送的消息 | 更新已有交互卡片，包括流式回复最终刷新和授权卡片状态更新 |
| `cardkit:card:read` | 读取 CardKit 卡片实例 | 将回复消息 id 转换为 CardKit card id，用于原生流式更新 |
| `cardkit:card:write` | 更新 CardKit 卡片和卡片元素 | 对实时回复卡片做原生流式更新 |

```text
im:message:send_as_bot
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message.group_msg
im:message:readonly
im:message:update
cardkit:card:read
cardkit:card:write
```

事件订阅：

| 事件 | raven-ts 用途 |
| --- | --- |
| `im.message.receive_v1` | 通过长连接接收用户消息 |
| `card.action.trigger` | 接收 Claude 授权卡片上 Allow/Deny 按钮点击 |
| `im.chat.access_event.bot_p2p_chat_entered_v1` | 可选；只有扩展单聊进入事件处理时需要 |
| `im.message.message_read_v1` | 可选；当前代码中注册但不处理 |

不同租户和飞书/Lark 版本中的权限名称可能略有差异。如果开发者后台针对同一个 API 提示了替代权限，以后台提示为准。修改权限或事件后，需要创建并发布新的应用版本，并在租户中更新已安装应用。

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
/r auth [status|safe|ask|auto|accept-edits|deny|bypass]
/r sandbox [status|on|off]
```

命令行为：

- `/r cd <path>` 修改工作目录，并清空当前 Agent 上下文。
- `/r clear` 清空当前聊天的 Agent 会话，同时保留工作目录。
- `/r restart` 释放当前聊天的 Codex runtime；下一次 Codex 请求会启动新的 SDK runner，并恢复已保存的 thread。
- `/r auth status|safe|ask|auto|accept-edits|deny|bypass` 查看或修改 Claude 授权模式。`on` 对应 `auto`，`off` 对应 `ask`。
- `/r sandbox status|on|off` 查看或修改 Codex 沙箱模式。`on` 对应 `workspace-write`，`off` 对应 `danger-full-access`。
- `/r claude` 和 `/r codex` 切换 Agent 后端。

## Codex

Codex 通过以下 API 调用：

```ts
const thread = codex.resumeThread(...)
const { events } = await thread.runStreamed(...)
// event.type === "turn.completed" 中包含 event.usage
```

应用代码使用官方 Codex SDK，并从 turn 完成事件中读取 usage。

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
raven-ts config set codex.sandboxMode workspace-write
raven-ts config set codex.codexBin C:\path\to\codex.cmd
```

将 Codex binary 重置为 SDK 默认值：

```sh
raven-ts config set codex.codexBin default
```

如果同一个聊天中 Codex 仍在运行时收到了第二条普通消息，`raven-ts` 会提示 Codex 正忙。使用 `!你的消息` 可以中断当前 turn 并启动新的运行任务。

## Claude

配置示例：

```sh
raven-ts config set agent.provider claude
raven-ts config set claude.defaultWorkDir C:\repo\project
raven-ts config set claude.maxTurns 20
raven-ts config set claude.timeoutMs 300000
raven-ts config set claude.authMode safe
```

Claude 回复会保存 `claudeSessionId`，后续消息会恢复该 SDK session。

Claude 授权模式：

- `safe`：raven-ts 默认策略。自动允许只读工具和安全 Bash 命令，其他 Bash 命令弹出飞书授权按钮。
- `ask`：写入类工具和 Bash 命令都弹出飞书授权按钮。
- `auto`：使用 Claude 自身的自动权限判断。
- `accept-edits`：自动接受编辑操作，同时保留 raven-ts 的 Bash 检查。
- `deny`：未预授权的操作直接拒绝，不弹授权按钮。
- `bypass`：跳过 Claude 权限检查。只建议在外部已有沙箱保护时使用。

## Windows 说明

`raven-ts start` 会运行后台 Node daemon，并将运行时文件保存到：

```text
%LOCALAPPDATA%\raven-ts
```

控制台窗口通过以下方式隐藏：

- 对 raven-ts daemon 使用 `windowsHide: true`。
- 通过 postinstall patch 为 `@openai/codex-sdk` 的 Codex CLI spawn 调用添加 `windowsHide: true`。

patch 脚本：

```text
scripts/patch-codex-sdk.js
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
- 官方 Codex SDK 不提供 mid-turn 指令注入；需要使用 `!prompt` 中断并替换当前 turn。
- 由于上游 Codex SDK 当前没有设置 `windowsHide`，窗口隐藏逻辑通过 `postinstall` patch 应用。
