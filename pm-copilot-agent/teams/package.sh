#!/usr/bin/env bash
# Build the Teams app package (luna-teams.zip) for upload in Teams: Apps → Manage your apps →
# Upload an app. Usage: TEAMS_APP_ID=<your bot's App ID> ./teams/package.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${TEAMS_APP_ID:?set TEAMS_APP_ID to the Azure Bot's Microsoft App ID}"
tmp=$(mktemp -d)
sed "s/\${TEAMS_APP_ID}/${TEAMS_APP_ID}/g" manifest.json > "$tmp/manifest.json"
cp color.png outline.png "$tmp/"
(cd "$tmp" && zip -q luna-teams.zip manifest.json color.png outline.png)
mv "$tmp/luna-teams.zip" ./luna-teams.zip && rm -rf "$tmp"
echo "Built $(pwd)/luna-teams.zip"
