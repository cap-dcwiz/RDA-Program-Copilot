# PM Copilot agent

Reads meeting notes from **Granola**, asks **Claude** what should change in **Jira**, and puts
each change on the dashboard's **Meeting To-dos** page. Nothing is written to Jira until an
**admin** approves it there.

```
Granola notes ──► PM Copilot agent ──► Claude (summary + suggestions)
                        │
                        ▼
              Dashboard: Meeting To-dos / Meeting History
                        │  admin approves
                        ▼
                      Jira  (comment · due date · new ticket)
```

## What it does

| Step | Detail |
|---|---|
| Ingest | Polls Granola every `GRANOLA_SYNC_MINUTES` (or **Sync Granola now** on the dashboard). Minutes Granola did not capture (Feishu, Teams) can be pasted on **Meeting History → Import minutes**. |
| Analyse | One Claude call per meeting with the notes and the open Jira tickets. Returns a summary and suggestions of three kinds: `comment` on an existing ticket, `due_date` change, `new_ticket`. Each carries a verbatim quote from the notes and a stated/inferred flag. Keys Claude makes up are turned into new-ticket suggestions; nothing is written yet. |
| Review | The dashboard lists pending suggestions per meeting. Admins can edit, approve or reject; viewers can read. |
| Write | Approve → Jira REST v3. New tickets go to project `BA`, issue type 任务, with the Client field set so they appear in the portfolio JQL. Every action is in the decision log. |

## Setup

```bash
cd pm-copilot-agent
cp .env.example .env        # fill in the keys below
npm run add-user -- "Sherry Liu" admin sherry.liu@rda.ai
npm run add-user -- "Selena Zhang" viewer selena.zhang@rda.ai
npm start                   # http://<host>:8790
```

Node 18+, no npm dependencies.

| `.env` | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. Server only — never put it in the HTML. |
| `GRANOLA_API_KEY` | Granola desktop → Settings → Connectors → API keys (Business/Enterprise plan). Optional `GRANOLA_FOLDER_ID` limits it to one folder. |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | A Jira service account and an API token from id.atlassian.com → Security → API tokens. Needs browse, comment, edit and create in `BA`. |
| `JIRA_DRY_RUN` | Starts as `true`: approvals are recorded and the exact Jira request is shown, but nothing is sent. Set `false` once you have checked a few. |
| `ALLOWED_ORIGINS` | The dashboard origin, e.g. `http://34.177.94.143:8083`. |

On the dashboard: **All projects → Meeting To-dos**, paste the agent URL and your token, **Sign in**.

## Roles

| Role | Can |
|---|---|
| `admin` | sync Granola, import minutes, re-analyse, edit, approve (writes to Jira), reject |
| `viewer` | read meetings, suggestions and the decision log |

Tokens are stored only as SHA-256 hashes in `data/users.json`. Re-running `add-user` for the same
name issues a new token and invalidates the old one. Roles are enforced by the agent, not the page.

## API

See the header of `src/server.js`. All routes except `/api/health` need `Authorization: Bearer <token>`.

## Files

```
src/granola.js   Granola public API (list + get note with transcript)
src/claude.js    Prompt, tool schema and guard rails for one meeting
src/jira.js      Open-ticket read (live or data/jira.snapshot.json) and approved writes
src/agent.js     ingest → analyse → store; approve / reject / edit
src/auth.js      token users and roles
src/store.js     JSON file store (data/store.json, git-ignored)
src/server.js    HTTP routes
```

## Not done yet

- Status transitions are posted as comments; moving a ticket's workflow status needs the BA
  workflow's transition ids.
- An approved write to Jira cannot be withdrawn from the dashboard; fix it in Jira.
- Sign-in is a per-person token. Swap `auth.js` for SSO when the dashboard moves behind it.
