#!/usr/bin/env bash
# Runs ON the VM, uploaded by deploy/deploy-vm.sh. Not meant to be run by hand.
# Usage: remote-install.sh <repo-url> <branch> <staging-dir>
#
# Isolation: touches only this project's repo checkout, its systemd unit, its edge route file and
# the nginx site it created itself. Every other demo on this host is left alone.
set -euo pipefail
REPO="$1"; BRANCH="$2"; STAGE="$3"
APP="rda-program-copilot"
SERVICE="delivery-copilot"
EDGE_PROJECT="delivery-copilot"
APP_DIR="$HOME/$APP"
AGENT_DIR="$APP_DIR/pm-copilot-agent"

echo "==> syncing code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  # A deployment host has no business carrying local edits. .env and the runtime data/*.json are
  # git-ignored, so this never touches configuration or running state.
  git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
echo "    $(git -C "$APP_DIR" log --oneline -1)"

echo "==> configuration"
if [ ! -f "$AGENT_DIR/.env" ]; then
  cp "$AGENT_DIR/.env.example" "$AGENT_DIR/.env"
  chmod 600 "$AGENT_DIR/.env"
  echo "    created $AGENT_DIR/.env from the example — the API keys are still blank."
  echo "    Dashboard, sign-in and roles work without them; Claude, Granola and Jira do not."
else
  echo "    keeping the existing .env"
fi

echo "==> systemd unit"
sudo cp "$STAGE/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
sudo systemctl daemon-reload
sudo systemctl enable --quiet "$SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> waiting for the agent on :8790"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8790/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "FAILED: the agent never became healthy. Last log lines:" >&2
  sudo journalctl -u "$SERVICE" -n 30 --no-pager >&2
  # Leave the edge route pointing wherever it points now: stale beats dead.
  exit 1
fi
echo "    $(curl -fsS --max-time 5 http://127.0.0.1:8790/api/health | head -c 160)"

echo "==> edge route -> 172.23.0.1:8790"
~/edge/edgectl set "$EDGE_PROJECT" "$STAGE/edge-route.caddy"

# The static site this project served on :8091 is now a stale second copy of the page.
# Only the site this project created is removed; the other sites in sites-enabled belong to
# other demos and are neither read nor written.
if [ -e "/etc/nginx/sites-enabled/$APP" ]; then
  echo "==> retiring the old static site on :8091"
  sudo rm -f "/etc/nginx/sites-enabled/$APP" "/etc/nginx/sites-available/$APP"
  if sudo nginx -t >/dev/null 2>&1; then
    sudo systemctl reload nginx
    echo "    removed; nginx reloaded, other sites untouched"
  else
    echo "FAILED: nginx config invalid after removing our site — NOT reloading." >&2
    sudo nginx -t >&2
    exit 1
  fi
fi

rm -rf "$STAGE"
echo "==> done on the VM"
