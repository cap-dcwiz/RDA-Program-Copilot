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

## Daily auto-deploy

A systemd timer on the VM checks GitHub once a day and redeploys only if `main` has moved.

```bash
systemctl list-timers delivery-copilot-update      # when it next runs
tail -40 ~/delivery-copilot-update.log             # what the last runs did
sudo systemctl start delivery-copilot-update       # run the check right now
sudo systemctl disable --now delivery-copilot-update.timer   # stop auto-deploying
```

It runs at **19:30 UTC (03:30 Singapore)**, which is clear of the agent's own nightly Jira sync at
00:00 SGT, so a restart never lands mid-sync. `Persistent=true` means a run missed because the VM
was off happens on the next boot instead of being skipped.

The timer lives on the VM rather than in a laptop crontab or a cloud runner because the VM is the
only place that already has the checkout, `sudo` and `~/edge/edgectl` — and because it is awake at
03:30. `deploy/auto-update.sh` is what it runs, and it differs from a hand-run `deploy-vm.sh` in
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

What this does **not** do: review the commit. Anything merged to `main` is live by 03:30 the next
morning, on a public URL. The rollback catches a crash, not a mistake.

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
