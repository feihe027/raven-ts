# raven-ts

**Language:** English | [简体中文](README.zh-CN.md)

`raven-ts` is a local Feishu/Lark bot service for controlling Claude Agent SDK and Codex app-server from chat.

Users send messages in Feishu/Lark. `raven-ts` receives them through the bot WebSocket event stream, runs the configured agent backend, and replies with a message card.

## Features

- Claude and Codex backends.
- Runtime switching from chat with `/r claude` and `/r codex`.
- Codex app-server through `ai-sdk-provider-codex-app-server`.
- Codex app-server runs over provider-managed stdio.
- Long-lived Codex runtime cache, so Codex is not restarted after every turn.
- Mid-run Codex instruction injection through `session.injectMessage(...)`.
- Per-chat work directory and agent session binding.
- Windows background service with PID, logs, status, and hidden console windows.
- Duplicate Feishu/Lark event protection with message-id dedup and a short content dedup window.

## Message Flow

```text
Feishu/Lark message
  -> im.message.receive_v1 over WebSocket
  -> raven-ts daemon
  -> Claude Agent SDK or Codex app-server
  -> Feishu/Lark reply card
```

Claude context is managed by Claude SDK sessions. Codex context is managed by Codex threads. `raven-ts` stores only local metadata: chat id, work directory, Claude session id, and Codex thread id.

## Requirements

- Node.js >= 18
- npm
- A Feishu/Lark self-built bot app
- Auth environment variables required by Claude and/or Codex

Common variables:

```sh
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=...
OPENAI_API_KEY=...
CODEX_...
```

The background service imports variables from:

```text
%LOCALAPPDATA%\raven-ts\claude.env
```

The file name is kept for compatibility, but it can contain `ANTHROPIC_*`, `OPENAI_*`, and `CODEX_*`.

## Install

```sh
npm install
npm run build
```

Run the CLI locally:

```sh
node dist/cli.js status
```

Optional global link:

```sh
npm link
raven-ts status
```

## Initialize

```sh
raven-ts init
```

The init command asks for:

- Feishu/Lark domain
- agent backend: `claude` or `codex`
- App ID and App Secret
- optional Verification Token and Encrypt Key
- default work directory
- Claude max turns and timeout
- optional Codex binary path
- whether to start the background service

Show config:

```sh
raven-ts config list
raven-ts config path
```

## Feishu/Lark Setup

In the Feishu/Lark developer console:

1. Create a self-built app.
2. Enable bot capability.
3. Enable permissions for receiving and sending messages.
4. Enable event subscription through long connection.
5. Add `im.message.receive_v1`.
6. Publish or install the app.
7. Add the bot to the target chat.

Common permission scopes include:

```text
im:message:send_as_bot
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message.group_msg
im:message:readonly
```

Exact names may differ by tenant. Follow the developer console prompts when adding `im.message.receive_v1`.

## Start And Logs

Foreground mode:

```sh
raven-ts start --foreground
```

Background service:

```sh
raven-ts start
raven-ts stop
raven-ts status
```

Logs:

```sh
raven-ts logs
raven-ts logs --follow
```

Windows log paths:

```text
%LOCALAPPDATA%\raven-ts\raven-ts.log
%LOCALAPPDATA%\raven-ts\raven-ts.error.log
```

## Chat Commands

Send commands in Feishu/Lark:

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

Command behavior:

- `/r cd <path>` changes the work directory and clears the current agent context.
- `/r clear` clears the current chat's agent session while keeping the work directory.
- `/r restart` disposes the current chat's Codex runtime; the next Codex request starts a new app-server and resumes the saved thread.
- `/r claude` and `/r codex` switch the backend.

## Codex

Codex is called through:

```ts
createCodexAppServer(...)
streamText(...)
session.injectMessage(...)
```

The application code does not manually implement Codex JSON-RPC. The provider manages the local app-server process and stdio transport.

Default model:

```text
gpt-5.3-codex
```

Config examples:

```sh
raven-ts config set agent.provider codex
raven-ts config set codex.model gpt-5.3-codex
raven-ts config set codex.reasoningEffort medium
raven-ts config set codex.timeoutMs 300000
raven-ts config set codex.networkAccessEnabled true
raven-ts config set codex.codexBin C:\path\to\codex.cmd
```

Reset Codex binary to provider default:

```sh
raven-ts config set codex.codexBin default
```

If a second message arrives in the same chat while Codex is still active, `raven-ts` injects the new instruction into the active Codex session instead of starting another run.

## Claude

Config examples:

```sh
raven-ts config set agent.provider claude
raven-ts config set claude.defaultWorkDir C:\repo\project
raven-ts config set claude.maxTurns 20
raven-ts config set claude.timeoutMs 300000
```

Claude responses store a `claudeSessionId` and later messages resume that SDK session.

## Windows Notes

`raven-ts start` runs a background Node daemon and stores runtime files in:

```text
%LOCALAPPDATA%\raven-ts
```

Console windows are hidden by:

- `windowsHide: true` for the raven-ts daemon.
- A postinstall patch for `ai-sdk-provider-codex-app-server`, adding `windowsHide: true` to Codex app-server spawn calls.

The patch script is:

```text
scripts/patch-codex-provider.js
```

## Migration From raven Or cc-ys

`raven-ts` can migrate existing `raven` and `cc-ys` local data:

- config from the old `raven` or `cc-ys` Conf project
- sessions from `~/.raven/sessions` or `~/.cc-ys/sessions`
- runtime auth env from `%LOCALAPPDATA%\raven\claude.env` or `%LOCALAPPDATA%\cc-ys\claude.env`

After migration, new runtime files use the `raven-ts` paths.

The chat command prefix changed:

```text
/cc -> /r
```

The debug environment variable is now `RAVEN_TS_DEBUG_EVENTS`; `RAVEN_DEBUG_EVENTS` and `CC_YS_DEBUG_EVENTS` remain supported for compatibility.

## Troubleshooting

If Feishu/Lark does not reply, check whether messages are received:

```sh
raven-ts logs
```

If there is no `[Message ...]` line, check bot permissions, event subscription, app publish/install state, and whether the bot is in the chat.

If Codex looks stuck:

```text
/r restart
```

If you need a clean context:

```text
/r clear
```

If config changes do not take effect:

```sh
raven-ts stop
raven-ts start
```

## Current Limits

- Feishu/Lark image and screenshot messages are not yet passed to Codex image input.
- Explicit `codex app-server --listen stdio://` is not exposed by the current provider. The provider starts Codex app-server with stdio pipes internally.
- The provider window-hiding patch is applied through `postinstall`, because the upstream provider does not currently set `windowsHide`.
