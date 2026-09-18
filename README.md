# Telegram Codex Bridge

This bot receives text messages from Telegram, runs each one as a Codex CLI task
with `gpt-5.6-sol`, and sends the final Codex response back to Telegram. Tasks
are processed one at a time to keep memory use predictable on a 512 MB service.

## Requirements

- Node.js 24 or newer
- Codex CLI installed and available as `codex`
- A ChatGPT login already configured in Codex
- A Telegram bot token from BotFather

## Configuration

Copy the example file, then add the Telegram secret locally:

```bash
cp .env.example .env
```

`npm start` automatically loads `.env` from the repository root. Values already
exported in the shell take precedence. The `.env` file is ignored by Git and
must never be committed.

The bot invokes the installed Codex CLI directly and uses the ChatGPT
authentication already stored by Codex. An OpenAI API key is neither needed nor
passed to Codex. You can set `CODEX_WORKDIR` to choose the directory Codex works
in; it defaults to this repository. See `.env.example` for the complete list.

## Start

```bash
npm start
```

The bot uses Telegram long polling, so it does not need a public webhook URL.
Stop it with Ctrl+C. Nothing in this repository deploys or starts it as a
background service.

For a Render Web Service, use the default `npm install` build command and
`npm start` start command. Configure `TELEGRAM_BOT_TOKEN` as a secret environment
variable and make the existing Codex ChatGPT authentication available to the
service. Render supplies `PORT`; the service exposes `/` and `/healthz` there.

## Test

```bash
npm test
```

Codex runs with workspace-write sandboxing and can change files inside its
configured work directory. Each Telegram message starts an ephemeral Codex
session using `gpt-5.6-sol`, and only Codex's final response is returned to the
chat. Only one Codex process runs at a time to limit peak memory usage.
