# ASHRAF AI

ASHRAF AI is a persistent personal Telegram assistant for Mohamad Ashraf bin
Jamaluddin. It runs requests through Codex CLI with `gpt-5.6-sol`, keeps compact
local JSON memory, and processes tasks one at a time for a 512 MB service.

## Requirements

- Node.js 24 or newer
- Codex CLI installed and available as `codex`
- A ChatGPT login already configured in Codex
- A Telegram bot token from BotFather
- A strong bot password stored in `BOT_PASSWORD`

## Configuration

Copy the example file, then add the Telegram secret locally:

```bash
cp .env.example .env
```

`npm start` automatically loads `.env` from the repository root. Values already
exported in the shell take precedence. The `.env` file is ignored by Git and
must never be committed.

Set `BOT_PASSWORD` in Render. Optionally set `ALLOWED_TELEGRAM_USER_ID` to the
owner's numeric Telegram user ID; when present, every other account is rejected
before password checking. Sessions lock after 15 minutes without activity, and
`/lock` or `/logout` locks immediately. Password messages are deleted when the
Telegram API permits it and are never stored in assistant memory.

The bot invokes the installed Codex CLI directly and uses the ChatGPT
authentication already stored by Codex. An OpenAI API key is neither needed nor
passed to Codex. You can set `CODEX_WORKDIR` to choose the directory Codex works
in; it defaults to this repository. See `.env.example` for the complete list.

Assistant memory is stored in `data/`. Set `ASHRAF_AI_DATA_DIR` to a mounted
persistent Render disk path if memory must survive redeploys. Memory contains no
credentials. Recent conversation is bounded, and only memory relevant to the
current request is included in a Codex prompt.

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

Useful messages include `ingat saya guna iPad`, `apa yang awak ingat pasal
saya?`, `tambah projek dashboard kehadiran`, `projek saya apa`, and `buat RPH
Sains 5 USM`. A generated RPH remains `planned` until confirmed with a message
such as `RPH tadi dah ajar`; postponed lessons can be marked with `kelas tadi tak
jadi`.
