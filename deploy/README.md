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
