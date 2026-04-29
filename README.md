# cc-ys

`cc-ys` 是一个基于 Claude Agent SDK 的飞书控制服务。它通过飞书自建应用机器人的 WebSocket 长连接接收消息，把普通文本请求交给 Claude Agent SDK 执行，再把结果回复到飞书。

它适合把一个长期运行的 Claude Code/Agent 服务接到飞书私聊或群聊中，用飞书消息触发代码阅读、文件编辑、测试运行、联网查询等任务。

## 核心功能

- 使用飞书WebSocket 长连接接收事件，不需要公网 Webhook。
- 支持飞书文本消息和富文本 `post` 消息解析。
- 普通消息直接发送给 Claude Agent SDK。
- 每个飞书 `chat_id` 维护独立 Claude SDK `session_id`，支持多轮上下文。
- 支持 `/cc help`、`/cc cd`、`/cc pwd`、`/cc clear`、`/cc status`。
- 自动接受 Claude 文件编辑权限。
- `WebSearch` 和 `WebFetch` 默认允许，用于联网查询。
- Bash 走本地白名单，危险命令默认拒绝。
- 支持前台调试、Linux user systemd 后台服务、macOS LaunchAgent。

## 工作方式

```text
飞书用户发消息
  -> 飞书开放平台 im.message.receive_v1
  -> cc-ys WebSocket listener
  -> Claude Agent SDK query()
  -> 飞书消息回复或卡片回复
```

`cc-ys` 不拼接历史消息。长期上下文由 Claude Agent SDK 的 session 管理，`cc-ys` 只保存飞书会话和 Claude session 的绑定关系。

## 环境要求

- Node.js `>=18`
- npm
- 可以创建飞书自建应用的账号
- 可用的 Claude/Anthropic 认证环境变量，例如：

```sh
export ANTHROPIC_AUTH_TOKEN="your-token"
export ANTHROPIC_API_KEY="your-api-key"
export ANTHROPIC_BASE_URL="your-base-url"
```

实际需要哪些变量取决于你的 Claude Agent SDK 认证方式。`cc-ys init` 会把当前 shell 中存在的 `ANTHROPIC_*` 写入 systemd 环境文件。

## 安装

```sh
cd /home/michael/download/cc-ys
npm install
npm run build
```

本地运行 CLI：

```sh
node dist/cli.js status
```

如果希望直接使用 `cc-ys` 命令：

```sh
npm link
cc-ys status
```

## 连接飞书

### 1. 创建飞书自建应用

进入对应开放平台：

- 飞书中国区：`https://open.feishu.cn/app`

创建一个企业自建应用。进入应用详情后，在“凭证与基础信息”页面记录：

- `App ID`
- `App Secret`

`cc-ys init` 会用这两个值创建飞书 SDK client 和 WebSocket client。

### 2. 启用机器人能力

在应用后台找到“应用能力”或“功能”中的“机器人”，启用机器人能力。

建议同时设置机器人名称和头像，方便在飞书里识别。

### 3. 配置权限

进入“权限管理”，开通消息接收和消息发送相关权限。

最小配置通常需要：

- 以机器人身份发送消息。
- 读取用户发给机器人的单聊消息。
- 接收群聊中 @ 机器人的消息，或读取群聊消息。

不同租户后台显示名称可能略有差异。配置 `im.message.receive_v1` 事件时，飞书后台通常会提示需要补充哪些权限；按提示开通即可。

常见权限 scope 名称包括：

```text
im:message:send_as_bot
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message.group_msg
im:message:readonly
```

如果只需要私聊机器人，优先保证单聊消息读取和机器人发消息权限。如果需要群聊，必须把机器人加入群，并开通群聊相关权限。

### 4. 配置事件订阅

进入“事件与回调”或“事件订阅”页面。

选择：

```text
使用长连接接收事件
```

然后添加事件：

```text
im.message.receive_v1
```


如果后台要求 `Verification Token` 或 `Encrypt Key`，可以记录下来，后续在 `cc-ys init` 中填写；如果没有启用加密或没有要求，可以留空。

### 5. 发布或安装应用

权限和事件订阅修改后，需要发布新版本或安装应用到企业/租户，否则配置可能不会生效。

完成后，把机器人添加到目标私聊或群聊中。

## 初始化 cc-ys

先确保 Claude 认证环境变量已经在当前 shell 中：

```sh
env | grep '^ANTHROPIC_'
```

然后执行：

```sh
cc-ys init
```

交互过程中填写：

```text
Select Feishu domain: feishu 
App ID: 飞书应用的 App ID
App Secret: 飞书应用的 App Secret
Verification Token: 可选
Encrypt Key: 可选
Default working directory for Claude Agent SDK: 默认工作目录
Claude SDK max turns: 默认 20
Claude SDK timeout in milliseconds: 默认 300000
Start as background service?: 是否立即启动后台服务
```

配置文件位置可用下面命令查看：

```sh
cc-ys config path
```

Claude 环境变量会写入：

```text
~/.config/cc-ys/claude.env
```

该文件权限为 `0600`。Linux systemd 服务会通过 `EnvironmentFile` 读取它。

## 启动和验证

### 前台调试

第一次连接飞书时建议前台启动：

```sh
cd /home/michael/download/cc-ys
unset CC_YS_DEBUG_EVENTS
cc-ys start --foreground
```

连接成功时通常会看到类似日志：

```text
[info]: [ '[ws]', 'ws client ready' ]
Connected! Bot ID: ...
cc-ys is running
```

然后在飞书私聊机器人或群里 @ 机器人发送：

```text
hi
```

正常日志类似：

```text
[Message] ou_xxx: hi
[Execute] Running Claude Agent SDK in /path/to/workdir (resume: new)...
[Execute] Completed in 3000ms, sending reply...
[Reply] Sent successfully
```

飞书端应该收到一条卡片回复。

### 后台运行

启动后台服务：

```sh
cc-ys start
```

停止后台服务：

```sh
cc-ys stop
```

查看状态：

```sh
cc-ys status
```

查看日志：

```sh
cc-ys logs
cc-ys logs --follow
```

日志文件：

```text
/tmp/cc-ys.log
/tmp/cc-ys.error.log
```

## Linux systemd

`cc-ys start` 会安装 user systemd 服务：

```text
~/.config/systemd/user/cc-ys.service
```

手动管理：

```sh
systemctl --user daemon-reload
systemctl --user start cc-ys
systemctl --user status cc-ys
systemctl --user stop cc-ys
```

服务文件中会包含：

```ini
EnvironmentFile=/home/michael/.config/cc-ys/claude.env
StandardOutput=file:/tmp/cc-ys.log
StandardError=file:/tmp/cc-ys.error.log
```

如果你修改了 `~/.config/cc-ys/claude.env`，需要重启服务：

```sh
cc-ys stop
cc-ys start
```

## macOS LaunchAgent

macOS 下会使用 LaunchAgent：

```text
~/Library/LaunchAgents/com.cc-ys.plist
```

常用命令仍然是：

```sh
cc-ys start
cc-ys stop
cc-ys status
```

## 飞书聊天命令

在飞书里发送：

```text
/cc help
```

可查看可用命令。

### 切换工作目录

```text
/cc cd /home/michael/work/test
```

之后这个飞书会话里的普通消息都会在该目录下执行。

查看当前工作目录：

```text
/cc pwd
```

### 开始新会话

清除当前飞书 chat 绑定的 Claude SDK session：

```text
/cc clear
```

下一条普通消息会创建新的 Claude SDK session，但保留当前工作目录。

### 查看状态

```text
/cc status
```

会返回：

- 当前工作目录
- Claude SDK 是否可用
- Claude SDK session id
- 本地 session id
- daemon 状态
- 最近执行时间

## 普通消息用法

直接发送自然语言即可：

```text
总结这个项目的结构
```

```text
查询武汉天气
```

```text
运行测试并修复失败
```

```text
阅读 README，告诉我如何启动服务
```

Claude Agent SDK 会在当前飞书会话对应的 `workDir` 中运行。

## 会话数据

本地会话 metadata 存放在：

```text
~/.cc-ys/sessions
```

保存内容包括：

- 飞书 `chatId`
- 当前 `workDir`
- Claude SDK `claudeSessionId`
- 创建时间和更新时间

示例：

```json
{
  "id": "local-session-id",
  "chatId": "oc_xxx",
  "workDir": "/home/michael/work/test",
  "claudeSessionId": "claude-sdk-session-id",
  "createdAt": 1777450000000,
  "updatedAt": 1777450000000
}
```

## Claude 工具权限

### 自动允许

`cc-ys` 默认允许：

```text
WebSearch
WebFetch
```

这用于天气、新闻、网页内容等联网查询。

文件编辑权限使用：

```text
permissionMode: acceptEdits
```

也就是 Claude 可以自动接受编辑类操作。

### Bash 白名单

Bash 命令只允许常见只读、构建和测试命令：

```text
pwd
ls
find
cat
head
tail
grep
rg
sed -n
git status
git diff
git log
git show
npm test
npm run test
npm run build
pnpm test
pnpm build
yarn test
yarn build
```

非白名单命令会被拒绝，例如：

```text
rm -rf
curl
wget
sudo
chmod
mv
cp
```

联网查询应走 `WebSearch` / `WebFetch`，不要走 Bash 的 `curl` 或 Python HTTP 脚本。

## CLI 命令

```sh
cc-ys init
cc-ys start --foreground
cc-ys start
cc-ys stop
cc-ys status
cc-ys logs
cc-ys logs --follow
cc-ys config list
cc-ys config path
```

修改配置：

```sh
cc-ys config set feishu.appId cli_xxx
cc-ys config set feishu.appSecret your-secret
cc-ys config set feishu.domain feishu
cc-ys config set claude.defaultWorkDir /home/michael/work/test
cc-ys config set claude.maxTurns 20
cc-ys config set claude.timeoutMs 300000
```

修改配置后建议重启服务。

## 调试

默认不会打印完整飞书事件 JSON。如果需要查看原始事件：

```sh
CC_YS_DEBUG_EVENTS=1 cc-ys start --foreground
```

关闭调试：

```sh
unset CC_YS_DEBUG_EVENTS
cc-ys start --foreground
```

如果使用 systemd，确认 `~/.config/cc-ys/claude.env` 中没有不需要的调试变量。

## 常见问题

### `cc-ys status` 显示未配置

执行：

```sh
cc-ys init
```

或查看配置路径：

```sh
cc-ys config path
```

### 前台显示 `ws client ready` 但飞书没有回复

按顺序检查：

1. 机器人是否已经添加到私聊或群聊。
2. 群聊中是否需要 @ 机器人才能触发事件。
3. 事件订阅是否选择“使用长连接接收事件”。
4. 是否添加了 `im.message.receive_v1`。
5. 权限是否已经开通，并且应用是否重新发布/安装。
6. `App ID`、`App Secret`、`domain` 是否和当前租户匹配。
7. 前台日志是否出现 `[Message] ...`。

如果没有 `[Message]`，说明飞书事件还没有推到本地，优先排查飞书后台事件订阅和权限。

### 飞书后台显示“未建立长连接”

确认 `cc-ys start --foreground` 正在运行，并检查：

- `domain` 是否选对：飞书中国区用 `feishu`。
- App ID 和 App Secret 是否来自同一个应用。
- 网络是否允许主动连接飞书开放平台。
- 应用是否为自建应用，并已启用机器人能力。

### 收到重复事件

飞书可能重投同一条消息。`cc-ys` 会按 `message_id` 去重，日志中出现下面内容是正常的：

```text
[Skip] Duplicate message: om_xxx
```

### Claude 环境变量在后台服务中无效

检查：

```sh
cat ~/.config/cc-ys/claude.env
```

如果缺少 `ANTHROPIC_*`，重新导出变量并执行：

```sh
cc-ys init
cc-ys stop
cc-ys start
```

### Claude native binary not found

在部分 Linux 发行版上，SDK 可能误选 musl binary。`cc-ys` 会优先选择可运行的 glibc binary，也可以显式指定：

```sh
export CC_YS_CLAUDE_CODE_PATH="/home/michael/download/cc-ys/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
```

systemd 使用时，把该变量写入：

```text
~/.config/cc-ys/claude.env
```

然后重启服务。

### WebSearch 或 WebFetch 不能联网

先确认已经重启到最新构建：

```sh
npm run build
cc-ys stop
cc-ys start
```

再在飞书中执行：

```text
/cc clear
查询武汉天气
```

旧 Claude session 可能记住了之前的工具失败上下文，`/cc clear` 可以新开一个干净 session。

## 相关官方文档

- 飞书开放平台：`https://open.feishu.cn/app`
- 飞书接收消息事件 `im.message.receive_v1`：`https://open.feishu.cn/document/server-docs/im-v1/message/events/receive`
- 飞书回复消息 API：`https://open.feishu.cn/document/server-docs/im-v1/message/reply`
- 飞书发送消息 API：`https://open.feishu.cn/document/server-docs/im-v1/message/create`
