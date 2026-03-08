#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/des/deploy/mymserver}"
LOG_FILE="${LOG_FILE:-/home/des/mymserver-cloudflared.log}"
BRANCH="${BRANCH:-main}"
TARGET_FILE="$REPO_DIR/server.html"
ORIGIN_SSH_URL="${ORIGIN_SSH_URL:-git@github.com:mymultiplatform/mymultiplatform.github.io.git}"

if [[ ! -d "$REPO_DIR/.git" || ! -f "$TARGET_FILE" ]]; then
  echo "Invalid repo path: $REPO_DIR"
  exit 0
fi

if [[ ! -f "$LOG_FILE" ]]; then
  echo "Tunnel log not found yet: $LOG_FILE"
  exit 0
fi

tunnel_url=""
for _ in $(seq 1 45); do
  tunnel_url="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$LOG_FILE" | tail -n 1 || true)"
  if [[ -n "$tunnel_url" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$tunnel_url" ]]; then
  echo "No Cloudflare tunnel URL found in log."
  exit 0
fi

target="$tunnel_url/server"

cd "$REPO_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Repo has pending changes, skipping auto-sync."
  exit 0
fi

current_origin="$(git remote get-url origin || true)"
if [[ "$current_origin" != "$ORIGIN_SSH_URL" ]]; then
  git remote set-url origin "$ORIGIN_SSH_URL" || true
fi

git pull --ff-only origin "$BRANCH" >/dev/null 2>&1 || {
  echo "Git pull failed, skipping auto-sync."
  exit 0
}

sed -i "s#const target = \".*\";#const target = \"$target\";#" "$TARGET_FILE"

if git diff --quiet -- "$TARGET_FILE"; then
  echo "Redirect already current: $target"
  exit 0
fi

git add "$TARGET_FILE"
git commit -m "Auto-update /server redirect to active Cloudflare tunnel" >/dev/null
git push origin "$BRANCH" >/dev/null
echo "Updated redirect to $target"
