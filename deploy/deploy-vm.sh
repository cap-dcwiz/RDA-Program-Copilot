#!/usr/bin/env bash
# Deploy the Program Kanban static page to the RDA GCP VM and publish its public HTTPS path.
#
# Two pieces, both idempotent:
#   1. host nginx on :8091 serves the page out of /var/www/rda-program-copilot
#   2. the shared Caddy edge (~/edge) maps https://ai-factory.demo.rda.ai/DeliveryCopilot/
#      onto that port over the docker bridge gateway
# Port 8091 is NOT open to the internet — the edge is the only public way in.
#
# Usage: ./deploy/deploy-vm.sh   (run from repo root or anywhere)
set -euo pipefail
HOST="${VM_HOST:-fofo@34.177.94.143}"
KEY="${VM_KEY:-$HOME/.ssh/gcloud}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SITE="rda-program-copilot"
EDGE_PROJECT="delivery-copilot"

# The page is tracked once, in docs/. The two copies under site/ are what nginx and the
# Cloud Run image actually serve, so they are generated here rather than committed —
# a hand-copied duplicate of a 280KB file is a drift waiting to happen.
PAGE="$DIR/../docs/DayOne_NTPE_Program_Kanban_EN.html"
cp "$PAGE" "$DIR/site/index.html"
cp "$PAGE" "$DIR/site/DayOne_NTPE_Program_Kanban_EN.html"

ssh -i "$KEY" "$HOST" "mkdir -p /tmp/$SITE"
scp -i "$KEY" "$DIR/site/"*.html "$DIR/nginx-vm.conf" "$DIR/edge-route.caddy" "$HOST:/tmp/$SITE/"
ssh -i "$KEY" "$HOST" bash -s <<REMOTE
set -euo pipefail
sudo mkdir -p /var/www/$SITE
sudo cp /tmp/$SITE/*.html /var/www/$SITE/
sudo chown -R www-data:www-data /var/www/$SITE
sudo cp /tmp/$SITE/nginx-vm.conf /etc/nginx/sites-available/$SITE
sudo ln -sf /etc/nginx/sites-available/$SITE /etc/nginx/sites-enabled/$SITE
sudo nginx -t
sudo systemctl reload nginx
# Reinstall this project's edge route. Touches only routes/$EDGE_PROJECT.caddy and
# hot-reloads Caddy; it can never clobber another project's routes.
~/edge/edgectl set $EDGE_PROJECT /tmp/$SITE/edge-route.caddy
rm -rf /tmp/$SITE
REMOTE
echo "Deployed: https://ai-factory.demo.rda.ai/DeliveryCopilot/"
