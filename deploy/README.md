# Deployment

What is deployable here is the self-contained static page
`docs/DayOne_NTPE_Program_Kanban_EN.html` (the Delivery Copilot dashboard). The rest of the
repo root is still the unrendered dcwiz cookiecutter template, and `luna-bot/` has no
deployment of its own yet — see its README.

`deploy/site/` holds the two copies that actually ship (`index.html` plus the original
filename). They are **generated, not tracked** — `deploy-vm.sh` re-copies them from `docs/`
on every run, so the page has exactly one source of truth. Building the Cloud Run image
without running `deploy-vm.sh` first needs that copy done by hand:

```bash
cp docs/DayOne_NTPE_Program_Kanban_EN.html deploy/site/index.html
cp docs/DayOne_NTPE_Program_Kanban_EN.html deploy/site/DayOne_NTPE_Program_Kanban_EN.html
```

## VM (RDA GCP, fofo-001 / 34.177.94.143) — the public deployment

```bash
./deploy/deploy-vm.sh
```

One command does all of it: uploads `site/*.html`, installs the host nginx site, reloads
nginx, and reinstalls the Caddy edge route.

- **URL: https://ai-factory.demo.rda.ai/DeliveryCopilot/**
- Files: `/var/www/rda-program-copilot/`
- Host nginx site: `/etc/nginx/sites-available/rda-program-copilot` (from `nginx-vm.conf`),
  listening on **8091, which is not open to the internet**. The only public way in is the
  shared Caddy edge, which reaches 8091 over the docker bridge gateway `172.23.0.1`.
- Edge route: `edge-route.caddy`, installed as project `delivery-copilot` via
  `~/edge/edgectl set`. Keep it in this repo — an edge route that only exists on the VM is
  the usual reason a demo path silently starts showing the Product Center shell instead.
  Check it with `~/edge/edgectl check /DeliveryCopilot/`.

Note: `deploy-vm.sh` writes to the VM over ssh, so Claude Code's auto mode will not run it;
run it yourself, or approve it when prompted.

## Cloud Run (internal, authenticated) — asia-southeast1

A second copy for anyone who should reach the page without the demo domain. `--no-allow-unauthenticated`
is the point of it; do not open it up.

```bash
cd deploy
docker buildx build --platform linux/amd64 --push \
  -t asia-southeast1-docker.pkg.dev/rda-engineering/cloud-run-source-deploy/rda-program-copilot:latest .
gcloud run deploy rda-program-copilot --region asia-southeast1 --project rda-engineering \
  --image asia-southeast1-docker.pkg.dev/rda-engineering/cloud-run-source-deploy/rda-program-copilot:latest --port 8080
```

- URL: https://rda-program-copilot-612211749393.asia-southeast1.run.app (403 without an identity token)
- `gcloud run deploy --source` does not work here: the Cloud Build compute SA lacks
  `storage.objects.get` on the sources bucket. Build and push the image yourself, as above.
