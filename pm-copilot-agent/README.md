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
cp .env.example .env        # fill in the keys below; set ADMIN_PASSWORD for the first sign-in
npm start                   # dashboard + API on http://<host>:8790
```

Node 18+, no npm dependencies. Open `http://<host>:8790/`, sign in as `admin`, then add people on
**Users & Roles**. (If the dashboard is still served from another port, put the agent address
under **Server address** on the sign-in screen and add that origin to `ALLOWED_ORIGINS`.)

| `.env` | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. Server only — never put it in the HTML. |
| `GRANOLA_API_KEY` | Granola desktop → Settings → Connectors → API keys (Business/Enterprise plan). Optional `GRANOLA_FOLDER_ID` limits it to one folder. |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | A Jira service account and an API token from id.atlassian.com → Security → API tokens. Needs browse, comment, edit and create in `BA`. |
| `JIRA_DRY_RUN` | Starts as `true`: approvals are recorded and the exact Jira request is shown, but nothing is sent. Set `false` once you have checked a few. |
| `ADMIN_PASSWORD` | Password for the `admin` user created on first start (only when no users exist). |
| `ALLOWED_ORIGINS` | Other origins allowed to call the API, if the dashboard is not served by the agent. |

## Users, roles and permissions

Everything sits behind sign-in. A role grants three things; a user with several roles gets the union.

| Grant | Meaning | Enforced |
|---|---|---|
| **Pages** | Which menu entries show: Portfolio, Meeting To-dos, Meeting History, the DayOne project pages, Users & Roles | API routes check the page (`todo` → suggestions, `history` → meetings and audit, `users` → admin routes) |
| **Can do** | `approve` — approve, edit, reject to-dos (writes to Jira) · `ingest` — sync Granola, import, re-analyse | every write route |
| **Projects** | Whose data the role sees, or all projects | suggestions, meetings and the decision log are filtered per project; full meeting notes only for all-projects roles |

Starting roles: **Admin** (locked, everything), **PM**, **Leadership**, **Engineering**, **Customer · DayOne**.
Edit them on Users & Roles → *Role → what it can see and do* and click **Save**.

Passwords are scrypt-hashed; sessions are random tokens stored as hashes and last 7 days.
Changing someone's password or disabling them signs them out everywhere. Eight wrong passwords
in 15 minutes locks that username from that address for 15 minutes. You cannot delete yourself or
remove the last person who can manage users. Files: `data/users.json`, `data/roles.json`,
`data/sessions.json` (git-ignored).

`npm run add-user -- <username> <password> [role,role] ["Display name"] [email]` adds a user from
the command line (for scripts or recovery).

**Limit:** the Portfolio and DayOne figures are still baked into the HTML file. The page hides what
a role does not grant, but a signed-in person could read them from the page source. Move that data
behind the agent's API before giving customers access to anything but their own project.

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
src/store.js     JSON file store (data/store.json, git-ignored)
src/server.js    HTTP routes
```

## Not done yet

- Status transitions are posted as comments; moving a ticket's workflow status needs the BA
  workflow's transition ids.
- An approved write to Jira cannot be withdrawn from the dashboard; fix it in Jira.
- Sign-in is username + password. Swap `auth.js` for SSO (Microsoft Entra) when needed.
