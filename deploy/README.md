# Deployment

Delivery Copilot is **not a static page**: `pm-copilot-agent` serves both the dashboard
(`docs/DayOne_NTPE_Program_Kanban_EN.html`) and its API, and the DayOne program data now comes
from `GET /api/program/dayone` rather than from the HTML. So deploying means running that
process, not copying a file.

Sign-in is the AI-factory Product Center's; see `pm-copilot-agent/README.md`.

## VM (RDA GCP, fofo-001 / 34.177.94.143)

```bash
./deploy/deploy-vm.sh
```

- **URL: https://ai-factory.demo.rda.ai/DeliveryCopilot/**
- It deploys **what is on GitHub**, not your working tree: it does `git fetch` + `reset --hard`
  against `origin/main`. Push first, or you will deploy the previous commit.
- Checkout: `/home/fofo/rda-program-copilot`. Service: `delivery-copilot` (systemd, from
  `delivery-copilot.service`), listening on **:8790, not open to the internet**. The shared Caddy
  edge is the only way in, reaching it over the docker bridge gateway `172.23.0.1`.
- Edge route: `edge-route.caddy`, installed as project `delivery-copilot` via `~/edge/edgectl set`.
  Keep it in this repo — an edge route that exists only on the VM is the usual reason a demo path
  silently starts serving the Product Center shell instead.
- Config: `pm-copilot-agent/.env` on the VM, created from `.env.example` on the first deploy and
  never overwritten afterwards. The dashboard, sign-in and roles work with it blank; Claude,
  Granola and Jira do not. Fill it in there, then `sudo systemctl restart delivery-copilot`.

```bash
sudo systemctl status delivery-copilot      # is it up
sudo journalctl -u delivery-copilot -f      # logs, incl. the nightly Jira sync
~/edge/edgectl check /DeliveryCopilot/      # is the public path still ours
```

### What it touches, and what it does not

This VM hosts a dozen demos behind one Caddy, so the deploy is deliberately narrow:

| Touches | Never touches |
|---|---|
| `~/rda-program-copilot` | any other project's checkout |
| `~/edge/routes/delivery-copilot.caddy`, via `edgectl` | `~/edge/Caddyfile`, `~/edge/sites/`, other `routes/*.caddy` |
| the `delivery-copilot` systemd unit | any other unit or container |
| port 8790 | every other port |

`edgectl` refuses to let one project claim another's prefix, validates the whole config in a
throwaway container, then hot-reloads — it never restarts Caddy. The deploy also installs the
agent and waits for `/api/health` **before** moving the route, so the public path is never
pointed at a dead port; if the agent does not come up, the route is left where it was.

After deploying, compare the neighbouring paths against a baseline taken beforehand
(`edgectl check --all`, plus a `curl` of each public path) — `deploy-vm.sh` spot-checks
`/DCBI/`, `/PM/` and `/ROI` on its way out.

## Auto-deploy

A systemd timer on the VM checks GitHub **every ten minutes** and redeploys only if `main` has
moved, so a merge reaches the site within ten minutes.

```bash
systemctl list-timers delivery-copilot-update      # when it next runs
tail -40 ~/delivery-copilot-update.log             # what the last runs did
sudo systemctl start delivery-copilot-update       # run the check right now
sudo systemctl disable --now delivery-copilot-update.timer   # stop auto-deploying
```

A run that finds nothing is a `git fetch` and a sha compare — 0.55s measured on this VM — and
`flock -n` means a tick that arrives during a slow deploy is skipped rather than overlapped.
`Persistent=true` means a tick missed because the VM was off happens once it is back.

This used to run once a day at 19:30 UTC, a time chosen to sit hours clear of the agent's own
nightly Jira sync at 16:00 UTC (00:00 SGT, Tue–Sat). Ten-minute checks give that distance up, so
`auto-update.sh` honours the window itself: between 15:58 and 16:10 UTC it logs the update it found
and defers to the next tick. Restarting mid-sync would abandon a sync whose next attempt is 24h
away, and waiting ten minutes costs nothing.

The three systemd units — the service, the updater's service and its timer — are all installed
from the checkout on every deploy. Installing only the service let the timer file in the repo and
the schedule actually running drift apart silently, and left a rollback unable to take the old
schedule back with it. The updater never restarts its own service unit: it *is* that service, so a
`daemon-reload` is what makes its next run use the new unit.

The timer lives on the VM rather than in a laptop crontab or a cloud runner because the VM is the
only place that already has the checkout, `sudo` and `~/edge/edgectl` — and because it is always
awake. `deploy/auto-update.sh` is what it runs, and it differs from a hand-run `deploy-vm.sh` in
three ways that matter when nobody is watching:

- **It rolls back.** If the new commit will not answer `/api/health` within 30s, the previous
  commit is checked out, its unit reinstalled, and the service restarted. A bad push costs a
  restart, not an outage. If the rollback is *also* unhealthy, the log says so in those words.
- **It proves the neighbours are untouched.** Seven public paths are fetched and hashed before the
  update and again after; the log either says they are byte-identical or prints the diff. A
  changed neighbour is reported, not rolled back — our code is not what would have changed it.
- **It survives updating itself.** The script re-execs from a private copy, so a commit that
  rewrites `auto-update.sh` cannot make bash resume at a byte offset in the new text.

It takes the route through `edgectl` only when `deploy/edge-route.caddy` itself changed, and it
leaves `.env` and `pm-copilot-agent/data/` alone — both are git-ignored, so `git reset --hard`
does not see them. A failed run exits non-zero, so `systemctl status delivery-copilot-update`
shows it.

### The review gate

The timer does not deploy security-sensitive changes on its own. Before anything is touched,
`deploy/review-gate.js` classifies the incoming diff; if any rule trips, the run **holds**: no
reset, no restart, no route move, and the service stays exactly where it is.

| Rule | Why it holds |
|---|---|
| identity & access code | `auth.js`, `productcenter.js`, `permissions.js`, or any path naming oauth / token / session / secret / crypt |
| cryptography | new `createCipheriv`, `createHmac`, `randomBytes`, `timingSafeEqual`, `scrypt`, … |
| new secret-shaped config | a new `*_SECRET`, `*_TOKEN`, `*_API_KEY`, `*_CLIENT_ID`, `*_ENCRYPTION_KEY` |
| new outbound host | a URL host that appears nowhere in the current tree |
| request authorisation | code lines in `server.js` touching `signedIn`, `whoIs`, `Authorization`, `Bearer`, `/api/login` |
| deploy mechanism | any real change under `deploy/`, documentation and comment-only churn aside |
| new dependency | a first third-party package in a service that has none |

Two of those deserve their reasons stated. **`deploy/` holds** because without that rule a commit
could delete the gate and everything after it would flow through unread. And the gate that runs is
always the one in the **current** checkout, never the incoming commit's copy — a commit does not
get to supply the rules it is judged by.

Line-level rules read code, not prose, and that has been narrowed twice by things this gate
actually did:

- Scanning `.md` made it quote a markdown table in a README as evidence of an authorisation change.
- Scanning comments made it hold the 16 Nov range for "request authorisation" and offer, as its
  evidence, a line of comment this repo had just added to explain the very fix being deployed. The
  test is line-prefix based on purpose: a trailing comment on a real code line still counts,
  because the code line is real.
- `review-gate.js` is excluded from the line rules entirely. Its source necessarily contains the
  tokens the rules search for — rule 2 lists the crypto primitives by name — so touching those
  lines made the gate report its own rule definitions as a cryptography change. Nothing is lost:
  rule 6 holds for any real change here by path, a stronger test than a line match.

For the same reason, `deploy/*.md` and comment-only changes under `deploy/` no longer hold.
Approving a deploy because a README paragraph moved is the same training to approve without
looking. Deleting code still shows up as removed non-comment lines, so the delete-the-gate case
rule 6 exists for is unaffected — verified, along with the four cases above, against this repo's
own history and against synthetic commits.

A hold exits **75**, so `systemctl status delivery-copilot-update` shows it and the log carries the
full report with the matching lines quoted. Later ticks print one line instead of repeating it.

Being held is **not** a verdict on the code. Several of these rules fire on changes that are
perfectly good — it means only that a person should read this one before it serves the public.

To deploy a held commit after reading it, approve that exact sha:

```bash
echo <full-sha> > ~/.delivery-copilot-approved && sudo systemctl start delivery-copilot-update
```

The approval is consumed on use and matches one sha, so it cannot sit there approving whatever
lands next. `deploy/deploy-vm.sh` from a laptop does not consult the gate at all: a person running
a deploy by hand is the thing the gate is trying to get.

To see what the gate makes of a branch or PR before it is merged, without deploying anything:

```bash
node deploy/review-gate.js . origin/main <branch-or-sha>
```

That diffs from the **merge base**, so main's own newer commits are not counted as the branch's
work. Diffing straight against main would hold a data-only PR for "changing the deploy mechanism"
it never touched.

What the gate does **not** do: judge whether the code is correct. It routes changes to a human; it
does not replace one. An ordinary-looking commit can still be wrong, and the rollback is what
catches that.

## Cloud Run — retired

The `rda-program-copilot` service in `asia-southeast1` served a **static copy** of the page. That
is no longer a working deployment: the page now needs the agent behind it, and the agent needs a
writable data directory and a route to the Product Center, neither of which that setup has. The
service is still deployed and will keep serving a page whose API calls all fail.

Delete it when you are ready:

```bash
gcloud run services delete rda-program-copilot --region asia-southeast1 --project rda-engineering
```

`Dockerfile`, `nginx.conf` and `site/` exist only for that retired service.
