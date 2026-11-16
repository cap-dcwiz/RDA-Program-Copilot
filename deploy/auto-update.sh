#!/usr/bin/env bash
# Runs ON the VM, once a day, started by delivery-copilot-update.timer.
#
# What it does: fetch origin/main; if the commit has not moved, do nothing and say so. If it has,
# redeploy — and if the new commit will not come up healthy, put the previous commit back.
#
# Why it lives on the VM rather than on someone's laptop: the laptop is asleep at 03:30, and the
# VM is the only place that already has the checkout, sudo, and ~/edge/edgectl.
#
# Isolation, same rule as deploy/remote-install.sh: this touches only this project's checkout, its
# own systemd unit and its own edge route file. The other demos on this host are read (to prove
# they still answer) but never written.
#
# Logs: ~/delivery-copilot-update.log, newest at the bottom. Exit non-zero on any failure so that
# `systemctl status delivery-copilot-update` shows the last run as failed.
set -uo pipefail

# An update can rewrite this very file while bash is still reading it, which would make bash
# resume at a byte offset in the new text. Run from a private copy instead.
if [ "${AU_REEXEC:-}" != "1" ]; then
  self=$(mktemp /tmp/delivery-copilot-update.XXXXXX.sh)
  cat "$0" > "$self"
  AU_REEXEC=1 bash "$self" "$@"; code=$?
  rm -f "$self"
  exit $code
fi

BRANCH="${BRANCH:-main}"
APP_DIR="$HOME/rda-program-copilot"
AGENT_DIR="$APP_DIR/pm-copilot-agent"
SERVICE="delivery-copilot"
EDGE_PROJECT="delivery-copilot"
LOG="$HOME/delivery-copilot-update.log"
LOCK="$HOME/.delivery-copilot-update.lock"
BASE="https://ai-factory.demo.rda.ai"
# Neighbours. Not ours, never written — curled only to prove this deploy left them alone.
NEIGHBOURS=(/ /DCBI/ /PM/ /ROI /AISOP/ /NTPEModel/ /DSXPID/)

say() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

# One run at a time. A second one finding the lock held exits quietly rather than queueing.
exec 9> "$LOCK"
flock -n 9 || { say "another run holds the lock — skipping" >> "$LOG"; exit 0; }

# Trim before taking the log over: the appending fd below would otherwise survive the rename and
# keep writing to the unlinked old file, losing everything this run has to say.
[ -f "$LOG" ] && { tail -n 4000 "$LOG" > "$LOG.trim" && mv "$LOG.trim" "$LOG"; }
exec >> "$LOG" 2>&1

snapshot() {  # "<path> <status> <md5>" per neighbour
  local p
  for p in "${NEIGHBOURS[@]}"; do
    local body status
    body=$(curl -s --max-time 15 -w '\n%{http_code}' "$BASE$p" 2>/dev/null)
    status=$(printf '%s' "$body" | tail -n1)
    printf '%s %s %s\n' "$p" "${status:-000}" "$(printf '%s' "$body" | sed '$d' | md5sum | cut -d' ' -f1)"
  done
}

healthy() {  # the agent answers on its port within 30s
  local i
  for i in $(seq 1 30); do
    curl -fsS --max-time 2 http://127.0.0.1:8790/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

install_from_checkout() {  # unit + route as they are at the currently checked-out commit
  sudo cp "$APP_DIR/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service" || return 1
  sudo systemctl daemon-reload || return 1
  sudo systemctl restart "$SERVICE" || return 1
}

say "---- checking $BRANCH ----"
git -C "$APP_DIR" fetch --quiet origin "$BRANCH" || { say "FAILED: git fetch"; exit 1; }
PREV=$(git -C "$APP_DIR" rev-parse HEAD)
NEXT=$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")
if [ "$PREV" = "$NEXT" ]; then
  say "no change (${PREV:0:7}) — nothing to deploy"
  exit 0
fi

say "update: ${PREV:0:7} -> ${NEXT:0:7}"
git -C "$APP_DIR" log --oneline "$PREV..$NEXT" | sed 's/^/           /'
CHANGED=$(git -C "$APP_DIR" diff --name-only "$PREV" "$NEXT")
say "baselining ${#NEIGHBOURS[@]} neighbour paths"
BEFORE=$(snapshot)

# .env and the runtime data/*.json are git-ignored, so this keeps configuration and state.
git -C "$APP_DIR" reset --hard --quiet "$NEXT" || { say "FAILED: git reset"; exit 1; }

if [ -f "$AGENT_DIR/package-lock.json" ] && grep -q '^pm-copilot-agent/package' <<<"$CHANGED"; then
  say "dependencies changed — npm ci"
  (cd "$AGENT_DIR" && npm ci --omit=dev) || { say "FAILED: npm ci"; }
fi

say "restarting $SERVICE"
install_from_checkout || say "WARNING: unit install or restart reported an error"

if ! healthy; then
  say "FAILED: ${NEXT:0:7} never became healthy. Rolling back to ${PREV:0:7}."
  sudo journalctl -u "$SERVICE" -n 30 --no-pager | sed 's/^/           /'
  git -C "$APP_DIR" reset --hard --quiet "$PREV"
  install_from_checkout
  if healthy; then say "rolled back to ${PREV:0:7}; it is healthy. The edge route was not moved."
  else say "ROLLBACK ALSO UNHEALTHY — ${BASE}/DeliveryCopilot/ is down and needs a human."; fi
  exit 1
fi
say "healthy: $(curl -fsS --max-time 5 http://127.0.0.1:8790/api/health | head -c 200)"

# The route only moves when the route file itself changed; the upstream is otherwise unchanged.
if grep -q '^deploy/edge-route.caddy$' <<<"$CHANGED"; then
  say "edge route file changed — applying via edgectl"
  ~/edge/edgectl set "$EDGE_PROJECT" "$APP_DIR/deploy/edge-route.caddy" | sed 's/^/           /' \
    || say "WARNING: edgectl set failed — the public path still points at the old route"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/DeliveryCopilot/")
say "public /DeliveryCopilot/ -> $code"
status=0
[ "$code" = "200" ] || { say "FAILED: expected 200 from the public path"; status=1; }

AFTER=$(snapshot)
if [ "$BEFORE" = "$AFTER" ]; then
  say "neighbours byte-identical (${#NEIGHBOURS[@]} paths)"
else
  say "WARNING: a neighbour path changed across this deploy — diff below (before < / after >)"
  diff <(echo "$BEFORE") <(echo "$AFTER") | sed 's/^/           /'
  status=1
fi

say "---- done (${NEXT:0:7}) ----"
exit $status
