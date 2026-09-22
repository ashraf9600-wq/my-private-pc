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

Authenticated private-chat users can send JPG, JPEG, PNG, WEBP, PDF, DOC, DOCX,
ODT, RTF, TXT, MD, XLS, XLSX, CSV, ODS, PPT, PPTX and ODP files. Files are validated,
size-limited, processed as
untrusted data, and retained only temporarily in `/tmp/ashraf-ai` for follow-up
questions. Set `MAX_UPLOAD_MB` to change the limit (maximum 50 MB). Scanned PDFs
are rendered as page images when readable text is unavailable.

Those formats plus ZIP are monitored silently in observed Telegram groups. Local text
extraction is searched first; actual image inputs are sent to the installed Codex
CLI only for images, scanned PDF pages and image-heavy presentations. A definite
or possible owner-name match forwards/copies the original Telegram message to the
configured owner and sends a private Malay summary. The bot never replies publicly
to a group file. Detection metadata (not the large original) is stored in
`document-detections.json` under `ASHRAF_AI_DATA_DIR`, keyed for deduplication by
group chat ID and message ID.

ZIP input is untrusted: traversal, nested archives, executable/script and
macro-enabled entries, excessive file counts and excessive expanded size are
rejected. Supported inner files are inspected without executing macros, formulas,
scripts, links or embedded commands. Downloads, rendered pages and extracted ZIP
content are deleted after each job. Group-file work uses its own serial queue so a
failed or slow document does not stop polling or ordinary assistant jobs.

Per-format defaults are `MAX_IMAGE_MB=10`, `MAX_PDF_MB=20`,
`MAX_DOCUMENT_MB=15`, `MAX_SPREADSHEET_MB=15`,
`MAX_PRESENTATION_MB=20`, and `MAX_ARCHIVE_MB=20`. Vision defaults are three PDF
pages and three presentation visuals. ZIP defaults are 50 entries and 50 MB total
expanded data. See `.env.example` for every optional setting.

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

## Render production

`render.yaml` describes one paid Web Service with a persistent disk, `npm ci`
build and `npm start`. Apply its settings to the existing service; do not deploy
a second service using the same bot token. A Git push alone does not apply this
Blueprint to a manually configured service.

Render must run the service continuously. Free Web Services sleep after 15 minutes
without inbound traffic; outbound Telegram polling does not prevent this.
Use a paid instance for unattended operation. Closing Codespaces, browsers or
phones then has no effect on the Render process. See
[Render free service limits](https://render.com/docs/free).

Mount a disk at `/var/data`, set `ASHRAF_AI_DATA_DIR=/var/data/memory` and
`CODEX_HOME=/var/data/codex`. Missing memory files are seeded from the repository
once, without replacing existing memory. Preserve any newer memory from your old
runtime when migrating. A disk also makes Render stop the old instance before
starting the new one, avoiding overlapping polling during deployment. See
[Render disk lifecycle](https://render.com/docs/disks).

Keep the existing ChatGPT login in the writable `$CODEX_HOME/auth.json` on Render.
Alternatively, supply that existing login as a Render Secret File named
`auth.json`, and set `CODEX_AUTH_FILE=/etc/secrets/auth.json`. Startup copies this
file only if the persistent auth file is missing, so refreshed credentials survive
redeploys. Never commit or print this file. Login on Codespaces alone does not
provide login to Render; credentials must be available on the Render service.
Expired/revoked ChatGPT login may require signing in again. No API key or proxy
provider is used; every invocation specifies `gpt-5.6-sol` and explicit stdin `-`.

Required secrets: `TELEGRAM_BOT_TOKEN`, `BOT_PASSWORD`. Optional restriction:
`ALLOWED_TELEGRAM_USER_ID`. Render supplies `PORT`. `CODEX_JOB_TIMEOUT_MS` defaults
to 180000 and is capped at 900000; `MAX_UPLOAD_MB` and `CODEX_WORKDIR` keep their
existing behavior. Leave any API-key/provider routing variables unset.

HTTP and Telegram polling run in the same Node process, bound to `0.0.0.0:$PORT`.
`GET /healthz` returns `{ "status": "ok", "telegram": "running", "service":
"ashraf-ai-assistant" }` while polling. It reports `degraded` with `recovering`,
`conflict`, `unauthorized`, or `stopped` as appropriate. HTTP 200 is deliberately a
process-liveness check, not a guarantee of Telegram/Codex availability: permanent
configuration faults must not cause Render restart storms. Monitor the JSON status
and logs for operational faults.

Only one local process per bot token can acquire the Linux kernel polling lock;
the lock is released automatically even after a crash. It cannot coordinate
separate hosts: stop all Codespaces/local/other Render copies using the same token.
A Telegram 409 suspends polling without retrying. Stop the competing instance
(or remove an existing webhook), then restart the intended Render service.
Network/server failures retry at 3, 6, 12, 24, 48, then 60 seconds; rate limits
respect Telegram's `retry_after` up to 5 minutes. Successful polls reset backoff.

Codex jobs are serialized while polling continues independently. Every job has a
timeout, SIGTERM followed by SIGKILL for its process group, bounded output, and
safe failure messages. Queued jobs continue after a failed job. SIGTERM/SIGINT
stop accepting work, abort polling and active network/Codex requests, skip pending
jobs, clean temporary files, and close HTTP and the local lock (20-second shutdown
limit). Already accepted in-memory jobs are not a durable queue and can be lost
on restart. Global recoverable network errors are logged safely; unexpected
uncaught errors trigger controlled shutdown so Render can restart a clean process.

After pushing, Render deploys automatically only if auto-deploy for `main` is
enabled. Otherwise use **Manual Deploy → Deploy latest commit**. Repository tests
use fake Telegram/Codex processes and do not validate live Render secrets or login.

## Owner chat in Telegram groups

Set `ALLOWED_TELEGRAM_USER_ID` to the owner's numeric Telegram user ID. In any group or supergroup where the bot receives messages, the owner can mention `@Ashraf8765_bot <question>` or reply to a message sent by the bot. Replies are public in that same group. Set `TELEGRAM_BOT_USERNAME` if the bot has a different username. Group access uses the owner's Telegram identity; never send the private-chat password in a group. Missing owner configuration disables group activation.

Other members' mentions, replies, commands, and questions are stored only as group data and receive no response. Ordinary owner messages also do not invoke Codex. Anonymous administrator messages cannot activate the assistant.

Each group has separate persistent storage under `ASHRAF_AI_DATA_DIR/groups/`: the last 60 received messages and eight owner/assistant conversation turns, with each stored text capped at 2,500 characters. Summaries cover only this retained history. Public prompts never load private memory, profiles, projects, attachments, or private conversation history. Requests for private information are redirected to private chat. Other groups are never loaded; for a cross-group question, supply the information that is safe to share in the current group.

Public Codex jobs use a temporary empty working directory, read-only sandbox, disabled shell/browser/image/connector/subagent tools, disabled memories and project instructions. These controls follow the [Codex configuration reference](https://developers.openai.com/codex/config-reference). Private assistant jobs retain their existing behavior.

Telegram must deliver ordinary messages for group summaries to include them: configure the bot's group privacy settings accordingly. Only received messages can be stored; the bot cannot retrieve earlier Telegram group history.

## Persistent group registry

The registry is an atomic JSON file at `ASHRAF_AI_DATA_DIR/group-registry.json` (Render: `/var/data/memory/group-registry.json`). Entries are keyed by chat ID and record title, type, first/last observation, last message ID, observed message count and active status. Renames update the same entry. `my_chat_member` updates mark removals inactive and re-additions active; membership events and edits do not increment the message count. A stored update ID prevents replayed updates from inflating counts. Existing group message files remain unchanged.

In the owner's password-authenticated private chat, `/groups` lists active observed groups directly without Codex. Natural questions about groups, activity, work or deadlines receive current registry data and relevant retained group messages. Message activity uses `last_message_at`; `last_seen_at` can also reflect membership updates. “Most active” means the highest total observed message count, not an activity rate. The registry starts collecting when this feature is deployed; it does not invent titles, counts or membership for historical files.

Only `ALLOWED_TELEGRAM_USER_ID` can access the full registry. It must be configured on Render; when unset, private assistant processing fails closed. Public group `/groups` requests redirect the owner to private chat, and group AI receives only that group's registry entry. Non-owners remain silent in groups. Registry and message data are ignored by Git.

The registry describes groups actually observed through Telegram updates, not all groups the bot might belong to. The existing poller now requests `message`, `edited_message` and `my_chat_member` updates using the [Telegram Bot API update mechanism](https://core.telegram.org/bots/api#update). No extra polling process or authentication method is introduced.
