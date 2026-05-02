# raven-ts

**Language:** English | [简体中文](README.zh-CN.md)

`raven-ts` is a local Feishu/Lark bot service for controlling Claude Agent SDK and Codex SDK from chat.

Users send messages in Feishu/Lark. `raven-ts` receives them through the bot WebSocket event stream, runs the configured agent backend, and replies with a message card.

## Features

- Claude and Codex backends.
- Runtime switching from chat with `/r claude` and `/r codex`.
- Codex through the official `@openai/codex-sdk` `runStreamed()` API.
- Codex streams text in real time and reads token usage from the final `turn.completed` event.
- Final reply cards include collapsed intermediate details for reasoning summaries, tool calls, and agent events.
- Claude unsafe Bash tool calls can be approved or denied from Feishu permission cards.
- Codex thread IDs are persisted per chat, so context is resumed across turns.
- Claude per-chat queueing, plus `!prompt` interrupt-and-run behavior inspired by `agent-feishu-channel`.
- `/r stop` to stop the active run and clear queued Claude prompts.
- Successful replies now include token usage at the bottom of the reply card, with input/output/total counts.
- Per-chat work directory and agent session binding.
- Windows background service with PID, logs, status, and hidden console windows.
- Duplicate Feishu/Lark event protection with message-id dedup and a short content dedup window.

## Message Flow

```text
Feishu/Lark message
  -> im.message.receive_v1 over WebSocket
  -> raven-ts daemon
  -> Claude Agent SDK or Codex SDK
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

`npm install` also runs the raven-ts postinstall hook. It patches the Codex SDK window behavior and installs the bundled `feishu-docx-bot` skill into:

```text
~/.claude/skills/feishu-docx-bot
~/.codex/skills/feishu-docx-bot
```

The skill teaches Claude/Codex how to create and update Feishu Docx documents through the raven-ts Feishu bot. It is used for workflows such as saving paper search results, research reports, and generated summaries into Feishu Docs.

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

The official Feishu/Lark "App configuration instructions" for card interactive bots are a useful reference:
https://open.feishu.cn/document/develop-a-card-interactive-bot/faqs

For `raven-ts`, configure the self-built app as follows in the Feishu/Lark developer console:

1. Create a self-built app, then copy its **App ID** and **App Secret** from **Basic information > Credentials & Basic Info** into `raven-ts init`.
2. In **App capabilities**, add the **Bot** capability. This is required before the app can receive messages or send replies as a bot.
3. In **Develop configuration > Permissions > API permissions**, add the application permissions needed for message receive/send.
4. Start `raven-ts` once so the app establishes a long connection:
   ```sh
   raven-ts start --foreground
   ```
5. In **Develop configuration > Events and callbacks > Event configuration**, set the subscription method to **Receive events through long connection** and save it while `raven-ts` is running.
6. Add the message event `im.message.receive_v1`. If you use Claude permission cards, also add the card action event `card.action.trigger`.
7. Publish a new app version, install or update it in the tenant, and add the bot to the target chat.

Add these API permissions as **application permissions**:

| Permission scope | Feishu/Lark console description | Required for |
| --- | --- | --- |
| `im:message:send_as_bot` | Send messages as the bot | Text replies, interactive reply cards, Claude permission cards, command responses |
| `im:message.p2p_msg:readonly` | Read direct messages sent to the bot | Direct chat messages and commands |
| `im:message.group_at_msg:readonly` | Read group messages that @mention the bot | Group chat usage where users @ the bot |
| `im:message.group_msg` | Read all messages in groups where the bot is present | Optional group mode if you want the bot to receive non-@ group messages |
| `im:message:readonly` | Read single-chat and group messages | Some tenants expose this as a broader or legacy alternative to the more specific read scopes |
| `im:resource` | Get and upload image or file resources | Downloading user-sent image/screenshot resources for Claude and Codex image input |
| `im:message:update` | Update messages sent by the app | Updating existing interactive cards, including final streaming-card refreshes and permission-card status updates |
| `cardkit:card:read` | Read CardKit card instances | Converting a reply message id to a CardKit card id for native streaming updates |
| `cardkit:card:write` | Update CardKit cards and elements | Native streaming updates for the live response card |

```text
im:message:send_as_bot
im:message.p2p_msg:readonly
im:message.group_at_msg:readonly
im:message.group_msg
im:message:readonly
im:resource
im:message:update
cardkit:card:read
cardkit:card:write
```

Image and screenshot messages are supported for both Claude and Codex. For this to work, the app must be able to receive the `image` message type and download message resources with `im:resource`; in group chats the bot also needs the relevant group-message receive permission for the messages you expect it to see.

Event subscriptions:

| Event | Required for |
| --- | --- |
| `im.message.receive_v1` | Receiving user messages over the long connection |
| `card.action.trigger` | Handling Allow/Deny clicks on Claude permission cards |
| `im.chat.access_event.bot_p2p_chat_entered_v1` | Optional; only needed if you add direct-chat entry handling |
| `im.message.message_read_v1` | Optional; currently registered as a no-op |

Exact names may differ by tenant and Feishu/Lark edition. If the developer console suggests a replacement permission for the same API, use the console suggestion. After changing permissions or events, publish a new app version and update the installed app in the tenant.

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
/r stop
/r status
/r agent
/r agent claude
/r agent codex
/r claude
/r codex
/r restart
/r auth [status|safe|ask|auto|accept-edits|deny|bypass]
/r sandbox [status|on|off]
/r image <prompt>
/r image-test
/r screenshot
```

Command behavior:

- `/r stop` stops the active run. For Claude it also clears queued prompts.
- `/r cd <path>` changes the work directory and clears the current agent context.
- `/r clear` clears the current chat's agent session while keeping the work directory.
- `/r restart` disposes the current chat's Codex runtime; the next Codex request starts a new SDK runner and resumes the saved thread.
- `/r auth status|safe|ask|auto|accept-edits|deny|bypass` shows or changes the Claude authorization mode. `on` maps to `auto`; `off` maps to `ask`.
- `/r sandbox status|on|off` shows or changes the Codex sandbox mode. `on` maps to `workspace-write`; `off` maps to `danger-full-access`.
- `/r image <prompt>` generates an image with the OpenAI Image API, uploads it to Feishu/Lark, and replies with an image message.
- `/r image-test` sends a built-in PNG through Feishu/Lark upload and image-message APIs to verify bot image delivery.
- `/r screenshot` captures the current Windows desktop and sends it as an image message.
- `/r claude` and `/r codex` switch the backend.
- `!your message` interrupts the current run and starts a fresh run with the new prompt.

## Image Generation

`/r image <prompt>` uses `OPENAI_API_KEY` from the raven-ts environment and the OpenAI Image API. The default image model is:

```text
gpt-image-1.5
```

Config examples:

```sh
raven-ts config set image.model gpt-image-1.5
raven-ts config set image.size 1024x1024
raven-ts config set image.quality medium
raven-ts config set image.outputFormat png
raven-ts config set image.timeoutMs 180000
```

The Feishu/Lark app needs `im:resource` to upload the generated image and `im:message:send_as_bot` to send it.

## Codex

Codex is called through:

```ts
const thread = codex.resumeThread(...)
const { events } = await thread.runStreamed(...)
// event.type === "turn.completed" contains event.usage
```

The application code uses the official Codex SDK and reads usage from the completed turn event.

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
raven-ts config set codex.sandboxMode workspace-write
raven-ts config set codex.codexBin C:\path\to\codex.cmd
```

Reset Codex binary to SDK default:

```sh
raven-ts config set codex.codexBin default
```

If a second message arrives in the same chat while Codex is still active, `raven-ts` replies that Codex is busy. Use `!your message` to interrupt the current turn and start a fresh run.

## Claude

Config examples:

```sh
raven-ts config set agent.provider claude
raven-ts config set claude.defaultWorkDir C:\repo\project
raven-ts config set claude.maxTurns 20
raven-ts config set claude.timeoutMs 300000
raven-ts config set claude.authMode safe
```

Claude responses store a `claudeSessionId` and later messages resume that SDK session.
If a second message arrives while Claude is still running, `raven-ts` queues it instead of starting a concurrent Claude turn.

Claude auth modes:

- `safe`: raven-ts default. Auto-allow read-only tools and safe Bash commands; request Feishu approval for other Bash commands.
- `ask`: request Feishu approval for write tools and Bash commands.
- `auto`: use Claude's automatic permission decisions.
- `accept-edits`: auto-accept edit operations while keeping raven-ts Bash checks.
- `deny`: deny non-preapproved operations instead of asking.
- `bypass`: skip Claude permission checks. Use only in an externally sandboxed environment.

## Windows Notes

`raven-ts start` runs a background Node daemon and stores runtime files in:

```text
%LOCALAPPDATA%\raven-ts
```

Console windows are hidden by:

- `windowsHide: true` for the raven-ts daemon.
- A postinstall patch for `@openai/codex-sdk`, adding `windowsHide: true` to Codex CLI spawn calls.

The patch script is:

```text
scripts/patch-codex-sdk.js
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

- File, audio, and video attachments are not yet passed to agent input.
- Official Codex SDK does not expose mid-turn instruction injection; use `!prompt` to interrupt and replace an active turn.
- The Codex SDK window-hiding patch is applied through `postinstall`, because the upstream SDK does not currently set `windowsHide`.
