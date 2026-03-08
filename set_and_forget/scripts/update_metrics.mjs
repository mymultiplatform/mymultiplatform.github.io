import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "live");
const outFile = path.join(outDir, "metrics.json");
const seedFile = path.join(outDir, "seed.json");
const paymentsSummaryFile = path.join(outDir, "payments_summary.json");
const outreachSummaryFile = path.join(outDir, "outreach_summary.json");
const replyTriageFile = path.join(outDir, "reply_triage.json");

const DEFAULT_TARGET_WEEKLY = 500;
const REQUEST_TIMEOUT_MS = 12000;

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deriveConfidence({
  targetCoveragePct,
  automationCoveragePct,
  closed,
  trials
}) {
  const revenueScore = clamp(targetCoveragePct, 0, 130) / 130;
  const automationScore = clamp(automationCoveragePct, 0, 100) / 100;
  const closeRate = closed / Math.max(1, trials);
  const pipelineScore = clamp(closeRate * 2.3, 0, 1);
  const score =
    (revenueScore * 0.5 + automationScore * 0.3 + pipelineScore * 0.2) * 100;
  return clamp(score, 0, 99.5);
}

async function fetchJson(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSeed() {
  try {
    const raw = await readFile(seedFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadExistingMetrics() {
  try {
    const raw = await readFile(outFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadJson(file, fallback) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function withoutUpdatedAt(payload) {
  const clone = { ...payload };
  delete clone.updatedAtUtc;
  return clone;
}

function buildMetrics(sourcePayload, sourceName) {
  const targetWeeklyUsd = toNumber(
    process.env.MYMSAF_TARGET_WEEKLY_USD,
    DEFAULT_TARGET_WEEKLY
  );
  const activeClients = toNumber(sourcePayload.activeClients, 15);
  const monthlyPriceUsd = toNumber(sourcePayload.monthlyPriceUsd, 149);
  const platformCostPct = toNumber(sourcePayload.platformCostPct, 7.5);
  const automationSystemsTotal = Math.max(
    1,
    Math.round(toNumber(sourcePayload.automationSystemsTotal, 10))
  );
  const automationSystemsDone = clamp(
    Math.round(toNumber(sourcePayload.automationSystemsDone, 9)),
    0,
    automationSystemsTotal
  );
  const pipelineClosed7d = Math.max(
    0,
    Math.round(toNumber(sourcePayload.pipelineClosed7d, 2))
  );
  const pipelineTrials7d = Math.max(
    0,
    Math.round(toNumber(sourcePayload.pipelineTrials7d, 6))
  );
  const manualHoursWeekly = clamp(
    toNumber(sourcePayload.manualHoursWeekly, 2.5),
    0,
    168
  );

  const modeledGrossMonthlyUsd = activeClients * monthlyPriceUsd;
  const modeledNetMonthlyUsd = modeledGrossMonthlyUsd * (1 - platformCostPct / 100);
  const modeledNetWeeklyUsd = modeledNetMonthlyUsd / 4.345;
  const actualNetWeeklyUsd = toNumber(sourcePayload.actualNetWeeklyUsd, NaN);
  const usesActualNet =
    Number.isFinite(actualNetWeeklyUsd) && actualNetWeeklyUsd > 0;
  const netWeeklyUsd = usesActualNet ? actualNetWeeklyUsd : modeledNetWeeklyUsd;
  const netMonthlyUsd = netWeeklyUsd * 4.345;
  const grossMonthlyUsd = toNumber(
    sourcePayload.actualGrossMonthlyUsd,
    modeledGrossMonthlyUsd
  );
  const targetCoveragePct = (netWeeklyUsd / targetWeeklyUsd) * 100;
  const gapWeeklyUsd = targetWeeklyUsd - netWeeklyUsd;
  const clientsNeededForTarget = Math.ceil(
    (targetWeeklyUsd * 4.345) /
      Math.max(1, monthlyPriceUsd * Math.max(0.05, 1 - platformCostPct / 100))
  );
  const automationCoveragePct =
    (automationSystemsDone / automationSystemsTotal) * 100;
  const confidenceScorePct = deriveConfidence({
    targetCoveragePct,
    automationCoveragePct,
    closed: pipelineClosed7d,
    trials: pipelineTrials7d
  });

  const runState =
    netWeeklyUsd >= targetWeeklyUsd &&
    automationCoveragePct >= 90 &&
    manualHoursWeekly <= 3
      ? "on-track"
      : "at-risk";

  return {
    updatedAtUtc: new Date().toISOString(),
    sourceName,
    netWeeklyMode: usesActualNet ? "actual" : "modeled",
    runState,
    targetWeeklyUsd: Number(targetWeeklyUsd.toFixed(2)),
    activeClients,
    monthlyPriceUsd,
    platformCostPct: Number(platformCostPct.toFixed(2)),
    grossMonthlyUsd: Number(grossMonthlyUsd.toFixed(2)),
    netMonthlyUsd: Number(netMonthlyUsd.toFixed(2)),
    netWeeklyUsd: Number(netWeeklyUsd.toFixed(2)),
    targetCoveragePct: Number(targetCoveragePct.toFixed(2)),
    gapWeeklyUsd: Number(gapWeeklyUsd.toFixed(2)),
    clientsNeededForTarget,
    automationSystemsDone,
    automationSystemsTotal,
    automationCoveragePct: Number(automationCoveragePct.toFixed(2)),
    pipelineClosed7d,
    pipelineTrials7d,
    outreachSent7d: Math.max(
      0,
      Math.round(toNumber(sourcePayload.outreachSent7d, 0))
    ),
    replyMatched7d: Math.max(
      0,
      Math.round(toNumber(sourcePayload.replyMatched7d, 0))
    ),
    replyHot7d: Math.max(
      0,
      Math.round(toNumber(sourcePayload.replyHot7d, 0))
    ),
    replyWarm7d: Math.max(
      0,
      Math.round(toNumber(sourcePayload.replyWarm7d, 0))
    ),
    replyCold7d: Math.max(
      0,
      Math.round(toNumber(sourcePayload.replyCold7d, 0))
    ),
    replyMode: String(sourcePayload.replyMode || "unknown"),
    paymentsCount7d: Math.max(
      0,
      Math.round(toNumber(sourcePayload.paymentsCount7d, 0))
    ),
    manualHoursWeekly: Number(manualHoursWeekly.toFixed(2)),
    confidenceScorePct: Number(confidenceScorePct.toFixed(2)),
    note:
      sourcePayload.note ||
      "Feed generated for MYMSAF mission control. Replace seed with live endpoint when ready."
  };
}

async function main() {
  let sourceName = "seed";
  let payload = await loadSeed();
  const endpoint = process.env.MYMSAF_METRICS_ENDPOINT;
  const token = process.env.MYMSAF_METRICS_TOKEN;

  if (endpoint) {
    try {
      const remote = await fetchJson(endpoint, token);
      payload = { ...payload, ...remote };
      sourceName = "remote-endpoint";
    } catch (error) {
      sourceName = "seed-fallback";
      payload = {
        ...payload,
        note: `Remote fetch failed (${error.message}). Using seed fallback.`
      };
    }
  }

  const paymentsSummary = await loadJson(paymentsSummaryFile, null);
  if (paymentsSummary && paymentsSummary.mode === "active") {
    payload = {
      ...payload,
      activeClients: toNumber(paymentsSummary.activeClients, payload.activeClients),
      pipelineClosed7d: toNumber(
        paymentsSummary.pipelineClosed7d,
        payload.pipelineClosed7d
      ),
      paymentsCount7d: toNumber(
        paymentsSummary.paymentsCount7d,
        payload.paymentsCount7d
      ),
      actualNetWeeklyUsd: toNumber(
        paymentsSummary.net7dUsd,
        payload.actualNetWeeklyUsd
      ),
      note: "Metrics include active PayPal payment sync."
    };
    sourceName = "payments-sync";
  }

  const outreachSummary = await loadJson(outreachSummaryFile, null);
  if (outreachSummary) {
    const sentLast7d = toNumber(outreachSummary.sentLast7d, 0);
    payload = {
      ...payload,
      outreachSent7d: sentLast7d,
      pipelineTrials7d: Math.max(
        toNumber(payload.pipelineTrials7d, 0),
        sentLast7d
      )
    };
  }

  const replyTriage = await loadJson(replyTriageFile, null);
  if (replyTriage) {
    payload = {
      ...payload,
      replyMode: String(replyTriage.mode || "unknown"),
      replyMatched7d: toNumber(
        replyTriage.hot7d,
        0
      ) + toNumber(replyTriage.warm7d, 0) + toNumber(replyTriage.cold7d, 0),
      replyHot7d: toNumber(replyTriage.hot7d, 0),
      replyWarm7d: toNumber(replyTriage.warm7d, 0),
      replyCold7d: toNumber(replyTriage.cold7d, 0)
    };
  }

  const metrics = buildMetrics(payload, sourceName);
  const previous = await loadExistingMetrics();
  if (
    previous &&
    JSON.stringify(withoutUpdatedAt(previous)) ===
      JSON.stringify(withoutUpdatedAt(metrics))
  ) {
    metrics.updatedAtUtc = previous.updatedAtUtc;
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, JSON.stringify(metrics, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
