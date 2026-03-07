#!/bin/bash
set -euo pipefail

RUNNER_REPO="${MYMSAF_RUNNER_REPO:-$HOME/.mymsaf/mymultiplatform.github.io}"
REMOTE_URL="${MYMSAF_REMOTE_URL:-https://github.com/mymultiplatform/mymultiplatform.github.io.git}"
BRANCH="${MYMSAF_BRANCH:-main}"

mkdir -p "$(dirname "$RUNNER_REPO")"

if [ -d "$RUNNER_REPO/.git" ]; then
  git -C "$RUNNER_REPO" fetch origin "$BRANCH"
  git -C "$RUNNER_REPO" checkout "$BRANCH"
  git -C "$RUNNER_REPO" pull --rebase origin "$BRANCH"
else
  git clone --branch "$BRANCH" --depth 1 "$REMOTE_URL" "$RUNNER_REPO"
fi

echo "Runner repo: $RUNNER_REPO"
