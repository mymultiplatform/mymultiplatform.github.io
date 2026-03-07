#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

DEFAULT_REPO_DIR="$HOME/.mymsaf/mymultiplatform.github.io"
FALLBACK_REPO_DIR="/Users/dantesanchez/Documents/New project/mymultiplatform.github.io"
REPO_DIR="${MYMSAF_REPO_DIR:-$DEFAULT_REPO_DIR}"
if [ ! -d "$REPO_DIR/.git" ] && [ -d "$FALLBACK_REPO_DIR/.git" ]; then
  REPO_DIR="$FALLBACK_REPO_DIR"
fi
METRICS_SCRIPT="$REPO_DIR/set_and_forget/scripts/update_metrics.mjs"
METRICS_FILE="$REPO_DIR/set_and_forget/live/metrics.json"
LOG_DIR="$REPO_DIR/set_and_forget/logs"
LOCK_DIR="$REPO_DIR/set_and_forget/.runner.lock"
ENV_FILE="$REPO_DIR/set_and_forget/.mymsaf.env"
REMOTE="${MYMSAF_REMOTE:-origin}"
BRANCH="${MYMSAF_BRANCH:-main}"

mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/local_runner.log" 2>&1

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] MYMSAF local runner start"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git not found"
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found"
  exit 1
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "repo not found at $REPO_DIR"
  exit 1
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "runner lock exists; skipping overlapping run"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

cd "$REPO_DIR"

git pull --rebase --autostash "$REMOTE" "$BRANCH"
"$NODE_BIN" "$METRICS_SCRIPT"

git add "$METRICS_FILE"
if git diff --cached --quiet; then
  echo "no metrics change"
  exit 0
fi

git commit -m "Update MYMSAF live metrics (local runner)"
git push "$REMOTE" "$BRANCH"
echo "metrics pushed"
