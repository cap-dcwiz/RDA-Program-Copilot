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
cp .env.example .env        # fill in the keys below, incl. SEED_ADMINS
npm start                   # dashboard + API on http://<host>:8790
```

Node 18+, no npm dependencies. On first start each address in `SEED_ADMINS` gets its own Super
Admin account; temporary passwords are written to `data/initial-passwords.txt` (hand them out,
then delete the file). Everyone sets a new password at first sign-in. Super Admins add everyone
else on **Users & Roles**. (If the dashboard is still served from another port, put the agent address
under **Server address** on the sign-in screen and add that origin to `ALLOWED_ORIGINS`.)

| `.env` | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. Server only — never put it in the HTML. |
| `GRANOLA_API_KEY` | Granola desktop → Settings → Connectors → API keys (Business/Enterprise plan). Optional `GRANOLA_FOLDER_ID` limits it to one folder. |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | A Jira service account and an API token from id.atlassian.com → Security → API tokens. Needs browse, comment, edit and create in `BA`. |
| `JIRA_DRY_RUN` | Starts as `true`: approvals are recorded and the exact Jira request is shown, but nothing is sent. Set `false` once you have checked a few. |
| `SEED_ADMINS` | Emails that become Super Admins on first start, e.g. `selena.zhang@rda.ai,wenqian.yuan@rda.ai,zhaomeng.zhu@rda.ai`. Give admin rights to named people rather than sharing one login, so the decision log shows who did what. |
| `ADMIN_PASSWORD` | Only if `SEED_ADMINS` is empty: password for a single `admin` account. |
| `ALLOWED_ORIGINS` | Other origins allowed to call the API, if the dashboard is not served by the agent. |

## Users, roles and permissions

Everything sits behind sign-in. A role grants three things; a user with several roles gets the union.

| Grant | Meaning | Enforced |
|---|---|---|
| **Pages** | Which menu entries show: Portfolio, Meeting To-dos, Meeting History, the DayOne project pages, Users & Roles | API routes check the page (`todo` → suggestions, `history` → meetings and audit, `users` → admin routes) |
| **Can do** | `approve` — approve, edit, reject to-dos (writes to Jira) · `ingest` — sync Granola, import, re-analyse · `edit_plan` — edit the DayOne Gantt (title, dates, target date, owner, status, progress, next step, milestone) | every write route |
| **Projects** | Whose data the role sees, or all projects | suggestions, meetings and the decision log are filtered per project; full meeting notes only for all-projects roles |

Starting roles:

| Role | Sees | Approves to Jira | Edits the plan (Gantt) | Users & Roles |
|---|---|---|---|---|
| **Super Admin** (locked) | everything | yes | yes | yes |
| **RDA Manager** | every page and project | yes | yes | no |
| **RDA Member** | every page and project; can import meetings | no | no | no |
| **Customer · DayOne** | DayOne overview and roadmap only | no | no | no |

Add a `Customer · <client>` role per client as their project views are built.
Edit them on Users & Roles → *Role → what it can see and do* and click **Save**.

Passwords are scrypt-hashed; sessions are random tokens stored as hashes and last 7 days.
Changing someone's password or disabling them signs them out everywhere. Eight wrong passwords
in 15 minutes locks that username from that address for 15 minutes. You cannot delete yourself or
remove the last person who can manage users. Files: `data/users.json`, `data/roles.json`,
`data/sessions.json` (git-ignored).

`npm run add-user -- <username> <password> [role,role] ["Display name"] [email]` adds a user from
the command line (for scripts or recovery).

Portfolio data (`data/portfolio.json`) is served by `/api/portfolio` and filtered per role, so it
is not in the HTML at all. **Remaining limit:** the DayOne project view's own data is still baked
into the HTML file, so anyone who can load the page can read DayOne's program data from its
source. Move it behind the API before giving accounts to clients other than DayOne, or to anyone
who should not see DayOne.

Accounts an admin creates, or whose password an admin resets, must set a new password at next
sign-in. People change their own password from the header.

## Editing the plan

On DayOne → Roadmap View, people with `edit_plan` click a task name or its Gantt bar to edit it, or
the ◆ row to move the milestone. Edits are stored in `data/plan.json` (only what changed, plus who
changed what), validated on the server, and applied for everyone after sign-in. Edited tasks carry a
cyan dot; **Restore original plan** in the editor drops a task's edits. Every change is also in the
decision log.

## API

See the header of `src/server.js`. All routes except `/`, `/api/health` and `/api/login` need `Authorization: Bearer <session token>`.

## Files

```
src/granola.js   Granola public API (list + get note with transcript)
src/claude.js    Prompt, tool schema and guard rails for one meeting
src/jira.js      Open-ticket read (live or data/jira.snapshot.json) and approved writes
src/agent.js     ingest → analyse → store; approve / reject / edit
src/auth.js      users, password login, sessions, roles
src/permissions.js  the pages / actions / projects a role can grant, and the starting roles
src/plan.js      Gantt edits per project, with validation and history
src/store.js     JSON file store (data/store.json, git-ignored)
src/server.js    HTTP routes
```

## Not done yet

- Status transitions are posted as comments; moving a ticket's workflow status needs the BA
  workflow's transition ids.
- An approved write to Jira cannot be withdrawn from the dashboard; fix it in Jira.
- Sign-in is username + password. Swap `auth.js` for SSO (Microsoft Entra) when needed.
