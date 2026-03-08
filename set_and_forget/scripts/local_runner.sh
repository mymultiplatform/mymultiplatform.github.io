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
LEADS_SCRIPT="$REPO_DIR/set_and_forget/scripts/refresh_leads.mjs"
ENRICH_SCRIPT="$REPO_DIR/set_and_forget/scripts/enrich_leads.mjs"
FOLLOWUP_SCRIPT="$REPO_DIR/set_and_forget/scripts/prepare_followups.mjs"
OUTREACH_SCRIPT="$REPO_DIR/set_and_forget/scripts/send_outreach.mjs"
TRIAGE_SCRIPT="$REPO_DIR/set_and_forget/scripts/triage_replies.mjs"
PAYMENTS_SCRIPT="$REPO_DIR/set_and_forget/scripts/sync_payments.mjs"
METRICS_FILE="$REPO_DIR/set_and_forget/live/metrics.json"
LEADS_FILE="$REPO_DIR/set_and_forget/live/sd_leads.csv"
OUTREACH_FILE="$REPO_DIR/set_and_forget/live/outreach_queue.csv"
LEADS_JSON_FILE="$REPO_DIR/set_and_forget/live/sd_leads.json"
OUTREACH_JSON_FILE="$REPO_DIR/set_and_forget/live/outreach_queue.json"
LEAD_META_FILE="$REPO_DIR/set_and_forget/live/lead_refresh_meta.json"
ENRICH_SUMMARY_FILE="$REPO_DIR/set_and_forget/live/lead_enrichment_summary.json"
FOLLOWUP_SUMMARY_FILE="$REPO_DIR/set_and_forget/live/followup_summary.json"
OUTREACH_SUMMARY_FILE="$REPO_DIR/set_and_forget/live/outreach_summary.json"
OUTREACH_SENT_FILE="$REPO_DIR/set_and_forget/live/outreach_sent.json"
REPLY_TRIAGE_FILE="$REPO_DIR/set_and_forget/live/reply_triage.json"
PAYMENTS_SUMMARY_FILE="$REPO_DIR/set_and_forget/live/payments_summary.json"
PAYMENTS_LEDGER_FILE="$REPO_DIR/set_and_forget/live/payments.json"
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

if [ -f "$LEADS_SCRIPT" ]; then
  if ! "$NODE_BIN" "$LEADS_SCRIPT"; then
    echo "lead refresh failed; continuing with metrics update"
  fi
fi

if [ -f "$ENRICH_SCRIPT" ]; then
  if ! "$NODE_BIN" "$ENRICH_SCRIPT"; then
    echo "lead enrichment failed; continuing with followups/payments/outreach/metrics update"
  fi
fi

if [ -f "$FOLLOWUP_SCRIPT" ]; then
  if ! "$NODE_BIN" "$FOLLOWUP_SCRIPT"; then
    echo "followup preparation failed; continuing with payments/outreach/metrics update"
  fi
fi

if [ -f "$PAYMENTS_SCRIPT" ]; then
  if ! "$NODE_BIN" "$PAYMENTS_SCRIPT"; then
    echo "payments sync failed; continuing with outreach/metrics update"
  fi
fi

if [ -f "$OUTREACH_SCRIPT" ]; then
  if ! "$NODE_BIN" "$OUTREACH_SCRIPT"; then
    echo "outreach dispatch failed; continuing with reply-triage/metrics update"
  fi
fi

if [ -f "$TRIAGE_SCRIPT" ]; then
  if ! "$NODE_BIN" "$TRIAGE_SCRIPT"; then
    echo "reply triage failed; continuing with metrics update"
  fi
fi

"$NODE_BIN" "$METRICS_SCRIPT"

git add "$METRICS_FILE"
if [ -f "$LEADS_FILE" ]; then git add "$LEADS_FILE"; fi
if [ -f "$OUTREACH_FILE" ]; then git add "$OUTREACH_FILE"; fi
if [ -f "$LEADS_JSON_FILE" ]; then git add "$LEADS_JSON_FILE"; fi
if [ -f "$OUTREACH_JSON_FILE" ]; then git add "$OUTREACH_JSON_FILE"; fi
if [ -f "$LEAD_META_FILE" ]; then git add "$LEAD_META_FILE"; fi
if [ -f "$ENRICH_SUMMARY_FILE" ]; then git add "$ENRICH_SUMMARY_FILE"; fi
if [ -f "$FOLLOWUP_SUMMARY_FILE" ]; then git add "$FOLLOWUP_SUMMARY_FILE"; fi
if [ -f "$OUTREACH_SUMMARY_FILE" ]; then git add "$OUTREACH_SUMMARY_FILE"; fi
if [ -f "$OUTREACH_SENT_FILE" ]; then git add "$OUTREACH_SENT_FILE"; fi
if [ -f "$REPLY_TRIAGE_FILE" ]; then git add "$REPLY_TRIAGE_FILE"; fi
if [ -f "$PAYMENTS_SUMMARY_FILE" ]; then git add "$PAYMENTS_SUMMARY_FILE"; fi
if [ -f "$PAYMENTS_LEDGER_FILE" ]; then git add "$PAYMENTS_LEDGER_FILE"; fi
if git diff --cached --quiet; then
  echo "no metrics change"
  exit 0
fi

git commit -m "Update MYMSAF live metrics (local runner)"
git push "$REMOTE" "$BRANCH"
echo "metrics pushed"
