# Telegram Codex Bridge

This bot receives text messages from Telegram, runs each one as a Codex CLI task
with `gpt-5.6-sol`, and sends the final Codex response back to Telegram. Tasks
from the same Telegram chat run in order; separate chats can run concurrently.

## Requirements

- Node.js 18 or newer
- Codex CLI installed and available as `codex`
- A Telegram bot token from BotFather
- An OmniRoute API key with access to GPT-5.6 Sol

## Configuration

Copy the example file, then add the two required secrets locally:

```bash
cp .env.example .env
```

`npm start` automatically loads `.env` from the repository root. Values already
exported in the shell take precedence. The `.env` file is ignored by Git and
must never be committed.

The bridge defaults to the local OmniRoute gateway at
`http://127.0.0.1:20128/v1`. Start OmniRoute before the bridge. If you use a
remote OmniRoute instance, set `OMNIROUTE_BASE_URL` to its OpenAI-compatible
endpoint. You can also set `CODEX_WORKDIR` to choose the directory Codex works
in; it defaults to this repository.

See `.env.example` for the complete list.

## Start

```bash
npm start
```

The bot uses Telegram long polling, so it does not need a public webhook URL.
Stop it with Ctrl+C. Nothing in this repository deploys or starts it as a
background service.

## Test

```bash
npm test
```

Codex runs with workspace-write sandboxing and can change files inside its
configured work directory. Each Telegram message starts an ephemeral Codex
session, and only Codex's final response is returned to the chat.
