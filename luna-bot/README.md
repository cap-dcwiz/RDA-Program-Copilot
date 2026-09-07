# Luna Delivery Bot — V1 (Microsoft Teams)

This is a first runnable version of **Luna**, the execution agent described in
`Delivery_Copilot_Luna_PRD_Framework.md`. It implements the Ticket lifecycle
(Part 5), the Luna Queue's six states (Part 6), and the business rules (Part 7)
as real, tested code — wired to Microsoft Teams via the Bot Framework, using
your existing Bot Framework App (App ID / Password).

It is **not** a toy: `npm run simulate` runs the full Detect → Draft → Review →
Publish → Reminder → Escalation → Blocked-reroute → Verify → Close lifecycle
end-to-end, offline, against the real DayOne NTPE blocker chain (Historical
BMS Data → Digital Twin Framework / Single Data Hall Pilot → MS2), and prints
a full audit trail. Run it first — it costs nothing and proves the logic
before you touch Teams at all.

## What is actually real here, and what is not

Real and tested right now, without any Teams connection:
- The Ticket state machine (`src/store.js`) — every transition in Part 5.
- The trigger / Root Blocker / Blocker-Owner-vs-Task-Owner rule engine (`src/rules.js`) — Part 7 and Part 12.
- Ticket deduplication (Part 7).
- The Luna Queue's six-tab derivation (`src/queueView.js`) — Part 6.
- The Adaptive Card content (`src/cards.js`) — matches the review card / ticket card formats from the source brief.

Wired but **requires your Teams credentials and one-time setup** to actually run:
- Sending/receiving real messages in Teams (`src/bot.js`, `src/index.js`).
- The `/api/run-detection` and `/api/run-followups` HTTP endpoints that post real cards.

Deliberately stubbed for V1 (see "Known V1 simplifications" below):
- Auto-creating a new Dependency edge when a stakeholder names a different Blocker Owner in a `Blocked` response (Part 19 / Part 12) — the code path is there with a `TODO` comment, but it needs a real Stakeholder identity record first (PRD Open Question #4).
- Stakeholder ↔ Teams identity mapping — V1 matches on free-text names, not a real directory.

## Quick start (no Teams needed)

```bash
npm install
npm run simulate
```

Reads `data/program.seed.json` (the real DayOne NTPE task/dependency data),
runs detection, drafts Tickets, simulates review/publish/response/reminder/
escalation/verification, and prints the full audit trail plus final Luna
Queue tab counts. Re-run any time — it resets `data/tickets.store.json` at
the start of every run.

## Architecture

```
data/program.seed.json     Program data: tasks, Hard/Soft/Part-of dependencies,
                            stakeholders, Task Owner map, Blocker Owner overrides.
data/tickets.store.json    Ticket store (JSON file, git-ignored). Swap store.js's
                            load/save for a real DB later without touching rules.

src/rules.js        Pure functions: Root Blocker detection, Hard-Dependency
                     propagation, Blocker-Owner-vs-Task-Owner routing, the six
                     V1 trigger scenarios. No I/O — fully unit-testable.
src/messages.js      Trigger event -> human-readable draft text.
src/store.js         Ticket state machine + JSON persistence + dedup.
src/queueView.js     Derives the 6 Luna Queue tabs from ticket state (read-only,
                     never stored, so it can't drift from the state machine).
src/cards.js          Adaptive Card JSON builders (review card, ticket card,
                     reminder/escalation proposal cards, all sub-dialogs).
src/bot.js            TeamsActivityHandler: dispatches Action.Submit `verb`s
                     onto store.js methods. This is the file to read to see
                     what each button actually does.
src/conversationRefs.js  Persists the two channel conversation references
                     (Control Room, Project Group) captured on first contact.
src/programState.js  Seed program data + a runtime overlay of changes approved in the
                     dashboard (data/program.state.json). Delete that file to roll
                     everything back to the seed.
src/index.js          restify server: /api/messages (Bot Framework endpoint),
                     /api/run-detection, /api/apply-changes (dashboard handoff),
                     /api/run-followups, /api/queue.
test/simulate.js      Offline end-to-end proof, see Quick Start above.
```

## Setting up the real Teams connection

You said you already have a Bot Framework App (App ID + Password). Here is
what's still needed, and how to do each step. **Do not paste the App
Password into chat with me or into any file that gets committed to git** —
put it only in your local `.env`.

### 1. Configure environment

```bash
cp .env.example .env
```

Fill in, locally, in your own editor:
- `BOT_APP_ID`, `BOT_APP_PASSWORD`, `BOT_TENANT_ID` — from your existing Azure Bot registration.
- `BOT_APP_TYPE` — `SingleTenant` if the bot is registered for your org only (typical for an internal delivery bot), `MultiTenant` otherwise.
- Leave `TEAMS_CONTROL_ROOM_CONVERSATION_REF_PATH` / `TEAMS_PROJECT_GROUP_CONVERSATION_REF_PATH` as the defaults — these files get created automatically (see step 4).
- Adjust `REMINDER_THRESHOLD_HOURS` / `ESCALATION_THRESHOLD_DAYS` / `ESCALATION_MIN_REMINDERS` if you don't want the PRD's default 48h / 7 days / 2 reminders.

### 2. Messaging endpoint — the one hard requirement

Teams calls your bot back at a **public HTTPS URL** (`<your-domain>/api/messages`)
whenever someone clicks a card button. That URL has to be registered on your
Azure Bot resource under "Messaging endpoint". Options, easiest first:

- **Local development**: run `npm start` (listens on `PORT`, default 3978),
  then use the [Bot Framework Emulator](https://github.com/microsoft/BotFramework-Emulator)
  to test locally without Teams at all — point it at `http://localhost:3978/api/messages`
  with your App ID/Password. This proves the bot logic against real
  Bot Framework activities before Teams is involved.
- **Testing inside real Teams**: you need a public tunnel to your local
  server (e.g. `devtunnel host -p 3978` via the Microsoft dev tunnels CLI, or
  your own ngrok-equivalent), then set that tunnel's HTTPS URL + `/api/messages`
  as the Azure Bot's messaging endpoint.
- **Production**: deploy this project to Azure App Service (or any Node
  host you control) and set the messaging endpoint to `https://<your-app>.azurewebsites.net/api/messages`.
  A generic `az webapp up` from this folder is enough for a first deployment;
  set the same `.env` values as Application Settings on the App Service
  instead of a `.env` file.

### 3. Add the bot to both Teams channels

Add your Bot Framework App to the Team/channel you're using as the
**Delivery Control Room**, and separately to the **Project Delivery Group**.
(If you don't already have a Teams app manifest for this bot, the minimal
manifest needs the bot's App ID, a name, and `messageTeamMembers` /
`personal, team` scopes — ask your Teams admin if you need one created.)

### 4. Register each channel with Luna

In the **Control Room** channel, @mention the bot and send:
```
/luna register control-room
```
In the **Project Delivery Group** channel, send:
```
/luna register project-group
```
Each command captures that channel's Bot Framework conversation reference
into `data/control-room-conversation-ref.json` / `data/project-group-conversation-ref.json`
(git-ignored). This is a one-time step per environment — re-run it if you
ever move channels or redeploy to a new bot registration.

### 5. Run detection and follow-ups

```bash
curl -X POST http://localhost:3978/api/run-detection   # draft + post new Review Cards
curl -X POST http://localhost:3978/api/run-followups    # propose Reminders/Escalations
```

### 6. Connect the Delivery Copilot dashboard (meeting minutes → Tickets)

This is the path that turns a meeting into follow-up Tickets. Open
`DayOne_NTPE_Program_Kanban_EN.html`, find `LUNA_ENDPOINT` near the top of its
script block, and set it to this bot:

```js
const LUNA_ENDPOINT = 'http://localhost:3978/api/apply-changes';
```

Then the loop is:

1. **Import the minutes** in the dashboard's Meetings page. It extracts Change
   Proposals automatically — progress, target dates, status, next steps,
   assigned follow-ups — each with the sentence it came from.
2. **Approve the ones that are right.** Nothing leaves the dashboard until you do.
3. **Click "Push to Luna (N)".** The approved set is POSTed here.
4. Luna writes those changes into its program state, **re-runs blocker
   detection against the post-meeting picture**, and posts a Review Card per
   Ticket into the Delivery Control Room.
5. **Approve a Ticket there** and only then does Luna message the owner in the
   Project Delivery Group.

Two review gates, on purpose: the dashboard decides *what the meeting decided*,
the Control Room decides *what we chase someone about*. Neither reaches the
Project Delivery Group alone.

The re-detection step is the point of the whole thing. A meeting that
re-baselines a date makes that task stop looking overdue, so Luna stops chasing
it; a meeting that reports a task blocked makes Luna route to its **Blocker
Owner** instead of its Task Owner on the next cycle.

**Testing it without Teams:** start the bot with `LUNA_DRY_RUN=1` and every card
is logged to the console instead of being posted. The full pipeline —
extraction, program-state update, detection, card rendering — runs for real:

```bash
LUNA_DRY_RUN=1 npm start
```

**What `/api/apply-changes` returns**, so you can tell the cases apart:

| Field | Meaning |
|---|---|
| `applied` | changes written, with before/after values |
| `skipped` | changes this bot could not use (unknown task or field) — the dashboard tracks all 18 roadmap tasks, this bot only the subset that matters for blocker routing |
| `drafted` | Tickets created **and** delivered to the Control Room |
| `deduped` | tasks that already had an open Ticket, so no duplicate was raised |
| `deliveryError` | changes were saved but Teams delivery failed — nearly always an unregistered channel (step 4) |

In production, schedule these on an interval (Azure Function Timer trigger,
a cron job hitting the endpoints, whatever your infra already uses) — V1
deliberately exposes them as plain HTTP calls instead of an in-process
scheduler so you can control the cadence from outside the bot process and
trigger them on demand while testing.

## Business rule → code map (Part 7 of the PRD)

| PRD rule | Where it lives |
|---|---|
| Root Blocker (structural, not a model judgement) | `rules.js: findRootBlockers()` |
| Hard Dependency propagation only (never Soft, never Part-of) | `rules.js: downstreamImpact()` — filters `type === 'hard'` |
| Blocker Owner vs Task Owner routing | `rules.js: resolveOwner()` |
| Ticket Deduplication (Program + related object, non-terminal) | `store.js: findActive()`, `dedupeKey()` |
| Reminder / Escalation thresholds (configurable, not hard-coded) | `.env`: `REMINDER_THRESHOLD_HOURS`, `ESCALATION_THRESHOLD_DAYS`, `ESCALATION_MIN_REMINDERS` — read by `index.js`'s `/api/run-followups` |
| Closure Verification (Critical Deliverable vs plain Action) | `bot.js`: `requiresVerification = ticket.relatedMilestone != null` — see "Known V1 simplifications" |
| Change ETA → Critical Path check | `bot.js`: `impactsCriticalPath = ticket.relatedMilestone != null` — same simplification |

## Known V1 simplifications (deliberate, not oversights)

- **Critical Path / Critical Deliverable check is simplified to "is this tied
  to a Milestone at all."** The PRD's real Critical Path definition (Part 7)
  needs full schedule-duration math over the Hard Dependency graph. That's a
  well-defined next step, not implemented here — flagged so a real Critical
  Path calculator can replace that one-line check in `bot.js` without
  touching anything else.
- **Blocked-response owner rerouting is a stub.** When a stakeholder names a
  different Blocker Owner (Step 8 of the simulation), the response is
  recorded, but no new Dependency edge is written back automatically — this
  needs a real Stakeholder record for the newly-named person first (PRD Open
  Question #4, identity mapping). The `TODO` comment in `bot.js` marks
  exactly where that write-back belongs.
- **Ticket store is a single JSON file**, adequate for one Program at V1
  demo scale, not for concurrent writes at real production volume. Swap
  `store.js`'s `_load`/`_save` for a real database when that matters — no
  other file needs to change.
- **No auth on the HTTP endpoints** (`/api/run-detection` etc.). Fine behind
  a private network / Azure Function with its own auth; add API-key or AAD
  auth before exposing this publicly.
- **Stakeholder Teams identity mapping is name-based**, not a real directory
  lookup — `teamsUpn` fields in `program.seed.json` are placeholders. Part 27
  of the source brief (Identity Mapping) is real product scope still to design.

## Security

- Never commit `.env` — it's git-ignored.
- Never paste `BOT_APP_PASSWORD` into a chat session, ticket, or PR description.
- `data/tickets.store.json` and the conversation-ref files are git-ignored — they contain internal Program data, not secrets, but still shouldn't ship in the public repo history.
