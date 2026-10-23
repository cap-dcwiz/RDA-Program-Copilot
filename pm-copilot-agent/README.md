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
| Review | The dashboard lists pending suggestions per meeting. Roles with `approve` can edit, approve or reject; others can read. |
| Write | Approve → Jira REST v3. New tickets go to project `BA`, issue type 任务, with the Client field set so they appear in the portfolio JQL. Every action is in the decision log. |

## Setup

```bash
cd pm-copilot-agent
cp .env.example .env        # fill in the keys below
npm start                   # dashboard + API on http://<host>:8790
```

Node 18+, no npm dependencies. Sign in with your **AI-factory Product Center** account — this
agent stores no passwords and creates no accounts (see below). On first start it writes the
default role matrix and access mapping to `data/`; a Product Center admin lands on **Roles &
Access** and maps everyone else from there.

| `.env` | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. Server only — never put it in the HTML. |
| `GRANOLA_API_KEY` | Granola desktop → Settings → Connectors → API keys (Business/Enterprise plan). Optional `GRANOLA_FOLDER_ID` limits it to one folder. |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | A Jira service account and an API token from id.atlassian.com → Security → API tokens. Needs browse, comment, edit and create in `BA`. |
| `JIRA_DRY_RUN` | Starts as `true`: approvals are recorded and the exact Jira request is shown, but nothing is sent. Set `false` once you have checked a few. |
| `PRODUCT_CENTER_URL` | Where sign-in goes. Origin only. Default `http://127.0.0.1` — the Product Center's own nginx on this VM, which a host process reaches without joining `ai-factory-net`. |
| `PRODUCT_CENTER_CACHE_SECONDS` | How long a verified token is trusted before re-checking (default 60). It is also how long someone keeps access here after being disabled there. |
| `ALLOWED_ORIGINS` | Other origins allowed to call the API, if the dashboard is not served by the agent. |

## Sign-in, roles and permissions

Everything sits behind sign-in, and sign-in is the **AI-factory Product Center's** — the same
account people use at `ai-factory.demo.rda.ai`. One account, one password, one place to revoke it.

The split is deliberate:

| | Where | What it answers |
|---|---|---|
| **Authentication** | Product Center (`productcenter.js`) | *Who is this?* |
| **Authorization** | here (`permissions.js`, Roles & Access) | *What may they do in this dashboard?* |

This agent holds **no passwords, no accounts and no sessions**. It passes the credentials
straight through to Product Center and then verifies the JWT that comes back by asking Product
Center (`GET /api/me`), rather than keeping a copy of its signing secret: nothing to rotate in
two places, and a disabled account stops working here within `PRODUCT_CENTER_CACHE_SECONDS`.
Add, disable and reset people **in the Product Center**.

What a Product Center identity may do here comes from the mapping on **Roles & Access**:

| Product Center role | Gets here, by default |
|---|---|
| `admin` | Super Admin |
| `operator` (Engineering) | RDA Manager |
| `viewer` (Solution) | RDA Member |
| `ntu`, `customer` | nothing until granted |

`customer` grants nothing on purpose: Product Center has a single customer role and cannot say
*which* client, so each client contact is named individually under **Named people**, which
overrides their role. Someone who maps to nothing is told so at sign-in instead of being shown
an empty dashboard. From the command line: `npm run grant -- <email|role:NAME> <role,role>`.

A role grants three things; a user with several roles gets the union.

| Grant | Meaning | Enforced |
|---|---|---|
| **Pages** | Which menu entries show: Portfolio, Meeting To-dos, Meeting History, the DayOne project pages, Roles & Access | API routes check the page (`todo` → suggestions, `history` → meetings and audit, `users` → admin routes) |
| **Can do** | `approve` — approve, edit, reject to-dos (writes to Jira) · `ingest` — sync Granola, import, re-analyse · `edit_plan` — edit the DayOne Gantt (title, dates, target date, owner, status, progress, next step, milestone) | every write route |
| **Projects** | Whose data the role sees, or all projects | suggestions, meetings and the decision log are filtered per project; full meeting notes only for all-projects roles |

Starting roles:

| Role | Sees | Approves to Jira | Edits the plan (Gantt) | Roles & Access |
|---|---|---|---|---|
| **Super Admin** (locked) | everything | yes | yes | yes |
| **RDA Manager** | every page and project | yes | yes | no |
| **RDA Member** | every page and project; can import meetings | no | no | no |
| **Customer · DayOne** | DayOne overview and roadmap only | no | no | no |

Add a `Customer · <client>` role per client as their project views are built.
Edit them on Roles & Access → *Role → what it can see and do* and click **Save**.

Password rules, lockouts and session lifetime are the Product Center's. Here, eight rejected
sign-ins per username+address in 15 minutes are throttled (an unreachable Product Center is not
counted, so an outage cannot lock people out), and the mapping refuses to save if it would leave
nobody with access to Roles & Access. Files: `data/roles.json`, `data/access.json` (git-ignored).

Portfolio data (`data/portfolio.json`) is served by `/api/portfolio` and filtered per role, so it
is not in the HTML at all. **Remaining limit:** the DayOne project view's own data is still baked
into the HTML file, so anyone who can load the page can read DayOne's program data from its
source. Move it behind the API before giving accounts to clients other than DayOne, or to anyone
who should not see DayOne.

## Editing the plan

On DayOne → Roadmap View, people with `edit_plan` click a task name or its Gantt bar to edit it, or
the ◆ row to move the milestone. Edits are stored in `data/plan.json` (only what changed, plus who
changed what), validated on the server, and applied for everyone after sign-in. Edited tasks carry a
cyan dot; **Restore original plan** in the editor drops a task's edits. Every change is also in the
decision log.

## Meeting-minutes changes

On DayOne → Meetings, Approve / Reject / Withdraw are saved on the agent (`data/plan.json`,
`decisions`), so every viewer sees the same review state. Only roles with `edit_plan` can decide. An
approved task change becomes a plan edit tagged with the meeting (shown as "Meeting minutes" in the
data-source tags); Withdraw puts the field back unless someone changed it since. Status, owner and
target date of Jira-linked tasks cannot be changed from a meeting; change them in Jira. Proposals
match across browsers by content (meeting date + title + what they change).

## Nightly Jira sync

Monday to Friday at 24:00 Singapore time (00:00 Tue–Sat), the agent reads Jira with
`JIRA_EMAIL` + `JIRA_API_TOKEN` (read only; `JIRA_DRY_RUN` does not affect it) and refreshes:

- **DayOne phase**: the "Current Phase: … Month 2 → Month 3" line in the epic (BA-2380) description
  drives the phase card and phase KPIs.
- **DayOne plan** (`DAYONE_JQL`, default: children of epic BA-2380 plus `[DayOne-NTPE]` tickets).
  Tasks linked in `data/dayone-jira-map.json` take **status, owner and target date** from Jira, plus
  the latest comment; those fields are read-only on the Gantt (change them in Jira). Title, dates,
  progress and next step stay editable. DayOne tickets that are not mapped appear as extra rows
  in the month taken from their `[DayOne-NTPE][m.n]` code. Result: `data/dayone-jira.json`.
- **Portfolio** (`JIRA_JQL`): open tickets' status, assignee, due date and latest comment.
  Result: `data/portfolio.live.json` (the committed `portfolio.json` is the fallback).

`JIRA_SYNC=off` turns the schedule off. People with `edit_plan` can also press **Sync Jira now**
on Roadmap View (`POST /api/jira/sync`). Last and next run are in `/api/health`. To link another
plan task, add `"<task id>": "BA-xxxx"` to `tasks` in `dayone-jira-map.json`.

## API

See the header of `src/server.js`. All routes except `/`, `/api/health` and `/api/login` need `Authorization: Bearer <session token>`.

## Files

```
src/granola.js   Granola public API (list + get note with transcript)
src/claude.js    Prompt, tool schema and guard rails for one meeting
src/jira.js      Open-ticket read (live or data/jira.snapshot.json) and approved writes
src/agent.js     ingest → analyse → store; approve / reject / edit
src/productcenter.js  sign-in and token checks against the AI-factory Product Center
src/auth.js      role matrix, Product Center identity -> roles here, who-is-calling
src/permissions.js  the pages / actions / projects a role can grant, and the starting roles
src/jirasync.js  nightly Jira → DayOne plan + portfolio sync, and its schedule
src/plan.js      Gantt edits per project, with validation and history
src/store.js     JSON file store (data/store.json, git-ignored)
src/server.js    HTTP routes
```

## Not done yet

- Status transitions are posted as comments; moving a ticket's workflow status needs the BA
  workflow's transition ids.
- An approved write to Jira cannot be withdrawn from the dashboard; fix it in Jira.
- The dashboard's own HTML still carries DayOne's program data (see the note above), so anyone who
  can load the page can read it. Move it behind `/api/` before giving accounts to clients other
  than DayOne.
- Product Center is asked to verify each token, cached for a minute. If that ever shows up as
  latency, verifying its JWT locally is the alternative — at the cost of sharing its signing secret.
