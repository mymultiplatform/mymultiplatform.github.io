# MYMSAF Set-and-Forget

This folder powers:

- `/set_and_forget/` mission control dashboard
- Hourly generated live metrics at `/set_and_forget/live/metrics.json`
- Daily San Diego lead queue at:
  - `/set_and_forget/live/sd_leads.json`
  - `/set_and_forget/live/outreach_queue.json`
- Lead enrichment summary at `/set_and_forget/live/lead_enrichment_summary.json`
- Follow-up queue summary at `/set_and_forget/live/followup_summary.json`
- Outreach run summary at `/set_and_forget/live/outreach_summary.json`
- Reply triage summary at `/set_and_forget/live/reply_triage.json`
- Payment summary at `/set_and_forget/live/payments_summary.json`

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
- Runner sequence: `refresh_leads` -> `enrich_leads` -> `prepare_followups` -> `sync_payments` -> `send_outreach` -> `triage_replies` -> `update_metrics`

Optional env file loaded by runner:

- `~/.mymsaf/mymultiplatform.github.io/set_and_forget/.mymsaf.env`

Example:

```bash
MYMSAF_METRICS_ENDPOINT=https://your-api.example.com/mymsaf
MYMSAF_METRICS_TOKEN=replace_me
MYMSAF_TARGET_WEEKLY_USD=500
MYMSAF_LEAD_REFRESH_HOURS=24
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

## Lead source config

Lead refresh script:

- `set_and_forget/scripts/refresh_leads.mjs`
- `set_and_forget/scripts/enrich_leads.mjs`

Optional env knobs:

- `MYMSAF_OVERPASS_ENDPOINT`
- `MYMSAF_OVERPASS_ENDPOINTS` (comma-separated, retries in order)
- `MYMSAF_SD_LAT`
- `MYMSAF_SD_LON`
- `MYMSAF_SD_RADIUS`
- `MYMSAF_LEAD_REFRESH_HOURS`
- `MYMSAF_QUEUE_MAX` (default `220`)
- `MYMSAF_ENRICH_HOURS`
- `MYMSAF_ENRICH_MAX_SITES`
- `MYMSAF_ENRICH_CONCURRENCY`
- `MYMSAF_ENRICH_TIMEOUT_MS`

## Outreach dispatch config

Outreach script:

- `set_and_forget/scripts/send_outreach.mjs`
- `set_and_forget/scripts/prepare_followups.mjs`

Required to actually send:

- Email path:
  - `MYMSAF_FROM_EMAIL` + (`RESEND_API_KEY` or `SENDGRID_API_KEY`)
  - or `MYMSAF_USE_APPLE_MAIL=1` (macOS Mail.app account, optional `MYMSAF_APPLE_MAIL_SENDER`)
- `MYMSAF_CTA_URL` (recommended public offer page, default: `/set_and_forget/offer.html`)
- Optional SMS path:
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID`)
- `MYMSAF_PAYMENT_URL` (optional direct payment URL override)

Optional:

- `MYMSAF_REPLY_TO_EMAIL`
- `MYMSAF_CONTACT_EMAIL` (shown in outreach message body/signature)
- `MYMSAF_OUTREACH_DAILY_LIMIT` (default `20`)
- `MYMSAF_SMS_DAILY_LIMIT` (default `20`)
- `MYMSAF_SMS_ONLY_WHEN_NO_EMAIL` (default `true`)
- `MYMSAF_FOLLOWUP1_DELAY_HOURS` (default `48`)
- `MYMSAF_FOLLOWUP2_DELAY_HOURS` (default `120`)
- `MYMSAF_FOLLOWUP_MAX_PER_RUN` (default `120`)
- `MYMSAF_TEST_RECIPIENT` (routes all sends to one inbox for testing)
- `MYMSAF_SMS_TEST_RECIPIENT` (routes all SMS to one phone number for testing)

## Offer page

Public conversion page:

- `set_and_forget/offer.html`

It supports tracking parameters used by outreach links:

- `src`
- `lead`
- `vertical`

## Reply triage config

Reply triage script:

- `set_and_forget/scripts/triage_replies.mjs`

Optional:

- `GMAIL_ACCESS_TOKEN` (required for active Gmail triage)
- `GMAIL_USER_ID` (default `me`)
- `MYMSAF_REPLY_TRIAGE_HOURS` (default `6`)
- `MYMSAF_REPLY_TRIAGE_MAX_MESSAGES` (default `200`)
- `MYMSAF_REPLY_QUERY_DAYS` (default `14`)

## PayPal sync config

Payment sync script:

- `set_and_forget/scripts/sync_payments.mjs`

Required:

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`

Optional:

- `PAYPAL_MODE` (`live` or `sandbox`, default `live`)
- `MYMSAF_PAYMENT_FEE_PCT` (used only when fee data is missing)

## Confidence score

`confidenceScorePct` is computed from:

- Revenue coverage vs weekly target
- Automation coverage
- Pipeline conversion quality

This score is intended as an operating signal, not a guarantee.
