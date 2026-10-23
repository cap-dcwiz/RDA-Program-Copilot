#!/usr/bin/env bash
# Deploy Delivery Copilot to the RDA GCP VM.
#
# The dashboard is not a static page any more: pm-copilot-agent serves both it and its API, so
# this installs the repo, runs the agent under systemd on :8790, and points the shared Caddy edge
# at it. Public URL: https://ai-factory.demo.rda.ai/DeliveryCopilot/ — :8790 is not open to the
# internet, and the edge is the only way in.
#
# This VM hosts many demos, so the work is deliberately narrow — see deploy/remote-install.sh for
# exactly what it touches. Order matters: the agent is installed and proven healthy BEFORE the
# route moves to it, so the public path never points at a dead port.
#
# Usage: ./deploy/deploy-vm.sh   (run from repo root or anywhere)
set -euo pipefail
HOST="${VM_HOST:-fofo@34.177.94.143}"
KEY="${VM_KEY:-$HOME/.ssh/gcloud}"
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO_URL:-https://github.com/cap-dcwiz/RDA-Program-Copilot.git}"
BRANCH="${BRANCH:-main}"
STAGE="/tmp/rda-program-copilot-deploy"

echo "==> uploading unit, route and installer"
ssh -i "$KEY" "$HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"
scp -q -i "$KEY" "$DIR/delivery-copilot.service" "$DIR/edge-route.caddy" "$DIR/remote-install.sh" "$HOST:$STAGE/"
ssh -i "$KEY" "$HOST" "bash '$STAGE/remote-install.sh' '$REPO' '$BRANCH' '$STAGE'"

echo
echo "==> verifying from outside"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://ai-factory.demo.rda.ai/DeliveryCopilot/)
echo "    /DeliveryCopilot/ -> $code"
[ "$code" = "200" ] || { echo "Expected 200." >&2; exit 1; }
# A neighbour check, because this path shares one Caddy with every other demo on the box.
for p in /DCBI/ /PM/ /ROI; do
  printf '    %-10s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://ai-factory.demo.rda.ai$p")"
done
echo "Deployed: https://ai-factory.demo.rda.ai/DeliveryCopilot/"
