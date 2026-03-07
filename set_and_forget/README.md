# MYMSAF Set-and-Forget

This folder powers:

- `/set_and_forget/` mission control dashboard
- Hourly generated live metrics at `/set_and_forget/live/metrics.json`

## What runs automatically

Recommended GitHub Action: `.github/workflows/mymsaf-metrics.yml`

- Runs every hour (`7 * * * *`) and on manual dispatch.
- Executes `set_and_forget/scripts/update_metrics.mjs`.
- Writes fresh `set_and_forget/live/metrics.json`.
- Commits only if metrics changed.

If your push token does not include workflow permissions, add/push the workflow file later with a token that has `workflow` scope.

## Local production fallback (enabled now)

When GitHub workflow scope is blocked, run hourly from your Mac with LaunchAgent:

- `set_and_forget/scripts/local_runner.sh`
- `set_and_forget/scripts/install_launch_agent.sh`
- `set_and_forget/scripts/uninstall_launch_agent.sh`

Install:

```bash
bash set_and_forget/scripts/install_launch_agent.sh
```

This creates:

- `~/Library/LaunchAgents/com.mymultiplatform.mymsaf.metrics.plist`
- Runner clone at `~/.mymsaf/mymultiplatform.github.io`
- Hourly run at minute `07` (plus run-at-load)
- Logs under `~/.mymsaf/logs/`

Optional env file loaded by runner:

- `~/.mymsaf/mymultiplatform.github.io/set_and_forget/.mymsaf.env`

Example:

```bash
MYMSAF_METRICS_ENDPOINT=https://your-api.example.com/mymsaf
MYMSAF_METRICS_TOKEN=replace_me
MYMSAF_TARGET_WEEKLY_USD=500
```

## Optional live endpoint

If you set `MYMSAF_METRICS_ENDPOINT`, the script pulls live values from that endpoint.
If endpoint fetch fails or is not configured, it falls back to `set_and_forget/live/seed.json`.

Optional repo secrets:

- `MYMSAF_METRICS_ENDPOINT`
- `MYMSAF_METRICS_TOKEN`
- `MYMSAF_TARGET_WEEKLY_USD` (default `500`)

Expected endpoint JSON shape:

```json
{
  "activeClients": 15,
  "monthlyPriceUsd": 149,
  "platformCostPct": 7.5,
  "automationSystemsDone": 9,
  "automationSystemsTotal": 10,
  "pipelineClosed7d": 2,
  "pipelineTrials7d": 6,
  "manualHoursWeekly": 2.5
}
```

## Confidence score

`confidenceScorePct` is computed from:

- Revenue coverage vs weekly target
- Automation coverage
- Pipeline conversion quality

This score is intended as an operating signal, not a guarantee.
