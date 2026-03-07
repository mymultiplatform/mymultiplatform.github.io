import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const liveDir = path.join(rootDir, "live");

const ledgerFile = path.join(liveDir, "payments.json");
const summaryFile = path.join(liveDir, "payments_summary.json");

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_MODE = (process.env.PAYPAL_MODE || "live").toLowerCase();
const PAYPAL_API_BASE =
  process.env.PAYPAL_API_BASE ||
  (PAYPAL_MODE === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com");
const FALLBACK_FEE_PCT = Number(process.env.MYMSAF_PAYMENT_FEE_PCT || 0);

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value) {
  return Number(value.toFixed(2));
}

function atLeast(date, cutoffMs) {
  const ms = Date.parse(date || "");
  return Number.isFinite(ms) && ms >= cutoffMs;
}

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function withoutUpdatedAt(payload) {
  const clone = { ...(payload || {}) };
  delete clone.updatedAtUtc;
  return clone;
}

async function getAccessToken() {
  const basic = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`,
    "utf8"
  ).toString("base64");

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PayPal token ${response.status}: ${text.slice(0, 260)}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error("PayPal token response missing access_token");
  }
  return payload.access_token;
}

async function fetchTransactions(token, startDate, endDate) {
  const rows = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = new URL(`${PAYPAL_API_BASE}/v1/reporting/transactions`);
    url.searchParams.set("start_date", startDate.toISOString());
    url.searchParams.set("end_date", endDate.toISOString());
    url.searchParams.set("fields", "all");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `PayPal transactions ${response.status}: ${text.slice(0, 260)}`
      );
    }

    const payload = await response.json();
    const details = Array.isArray(payload.transaction_details)
      ? payload.transaction_details
      : [];
    rows.push(...details);
    totalPages = toNumber(
      payload.total_pages,
      Math.max(1, Math.ceil(toNumber(payload.total_items, 0) / 100))
    );
    page += 1;
  } while (page <= totalPages && page <= 10);

  return rows;
}

function normalizeTransactions(rawRows) {
  const normalized = [];

  for (const row of rawRows) {
    const info = row.transaction_info || {};
    const amount = toNumber(info.transaction_amount?.value, 0);
    const currency = String(info.transaction_amount?.currency_code || "");
    const feeRaw = toNumber(info.fee_amount?.value, 0);
    const fee = Math.abs(feeRaw) > 0 ? Math.abs(feeRaw) : Math.abs(amount) * (FALLBACK_FEE_PCT / 100);
    const status = String(info.transaction_status || "");
    const occurredAt =
      info.transaction_updated_date ||
      info.transaction_initiation_date ||
      row.transaction_info?.transaction_initiation_date ||
      "";
    const transactionId = String(info.transaction_id || "");
    const payer = row.payer_info || {};
    const payerEmail = String(payer.email_address || "");
    const payerName = String(
      payer.payer_name?.alternate_full_name ||
        payer.payer_name?.name ||
        payer.account_id ||
        ""
    );

    if (!transactionId || !occurredAt) continue;
    if (status !== "S") continue;
    if (currency !== "USD") continue;
    if (amount <= 0) continue;

    normalized.push({
      transactionId,
      occurredAtUtc: occurredAt,
      amountUsd: round(amount),
      feeUsd: round(fee),
      netUsd: round(amount - fee),
      payerEmail,
      payerName,
      eventCode: String(info.transaction_event_code || ""),
      referenceId: String(info.reference_id || ""),
      status
    });
  }

  normalized.sort((a, b) => Date.parse(b.occurredAtUtc) - Date.parse(a.occurredAtUtc));
  return normalized;
}

function summarize(transactions) {
  const nowMs = Date.now();
  const cutoff7d = nowMs - 7 * 24 * 60 * 60 * 1000;
  const cutoff30d = nowMs - 30 * 24 * 60 * 60 * 1000;
  const last7d = transactions.filter((item) => atLeast(item.occurredAtUtc, cutoff7d));
  const last30d = transactions.filter((item) => atLeast(item.occurredAtUtc, cutoff30d));
  const gross7d = last7d.reduce((sum, item) => sum + item.amountUsd, 0);
  const gross30d = last30d.reduce((sum, item) => sum + item.amountUsd, 0);
  const net7d = last7d.reduce((sum, item) => sum + item.netUsd, 0);
  const net30d = last30d.reduce((sum, item) => sum + item.netUsd, 0);
  const uniquePayers30d = new Set(
    last30d
      .map((item) => item.payerEmail || item.payerName)
      .filter(Boolean)
      .map((item) => item.toLowerCase())
  ).size;

  return {
    paymentsCount7d: last7d.length,
    paymentsCount30d: last30d.length,
    gross7dUsd: round(gross7d),
    gross30dUsd: round(gross30d),
    net7dUsd: round(net7d),
    net30dUsd: round(net30d),
    uniquePayers30d,
    activeClients: uniquePayers30d,
    averageTicketUsd:
      last7d.length > 0 ? round(gross7d / last7d.length) : 0,
    pipelineClosed7d: last7d.length
  };
}

async function writeSummary(summary) {
  await mkdir(liveDir, { recursive: true });
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
}

async function main() {
  await mkdir(liveDir, { recursive: true });
  const startDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
  const endDate = new Date();
  const previous = await readJson(summaryFile, null);

  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    const fallback = {
      updatedAtUtc: new Date().toISOString(),
      mode: "blocked-missing-credentials",
      source: `paypal-${PAYPAL_MODE}`,
      note:
        "PayPal credentials not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      ...(previous && previous.mode === "active" ? previous : {})
    };
    if (
      previous &&
      JSON.stringify(withoutUpdatedAt(previous)) ===
        JSON.stringify(withoutUpdatedAt(fallback))
    ) {
      fallback.updatedAtUtc = previous.updatedAtUtc;
    }
    await writeSummary(fallback);
    return;
  }

  try {
    const token = await getAccessToken();
    const rawRows = await fetchTransactions(token, startDate, endDate);
    const normalized = normalizeTransactions(rawRows);
    const baseSummary = summarize(normalized);
    const summary = {
      updatedAtUtc: new Date().toISOString(),
      mode: "active",
      source: `paypal-${PAYPAL_MODE}`,
      periodStartUtc: startDate.toISOString(),
      periodEndUtc: endDate.toISOString(),
      transactionsFetched: rawRows.length,
      ...baseSummary
    };

    await writeFile(ledgerFile, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    await writeSummary(summary);
    console.log(
      `Payments: 7d=${summary.paymentsCount7d} net7d=${summary.net7dUsd}`
    );
  } catch (error) {
    const fallback = {
      updatedAtUtc: new Date().toISOString(),
      mode: "error",
      source: `paypal-${PAYPAL_MODE}`,
      note: `PayPal sync failed: ${String(error.message || error).slice(0, 260)}`,
      ...(previous && previous.mode === "active" ? previous : {})
    };
    if (
      previous &&
      JSON.stringify(withoutUpdatedAt(previous)) ===
        JSON.stringify(withoutUpdatedAt(fallback))
    ) {
      fallback.updatedAtUtc = previous.updatedAtUtc;
    }
    await writeSummary(fallback);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
