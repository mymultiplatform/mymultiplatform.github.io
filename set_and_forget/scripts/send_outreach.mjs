import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const liveDir = path.join(rootDir, "live");

const queueJsonFile = path.join(liveDir, "outreach_queue.json");
const queueCsvFile = path.join(liveDir, "outreach_queue.csv");
const sentLogFile = path.join(liveDir, "outreach_sent.json");
const summaryFile = path.join(liveDir, "outreach_summary.json");

const DAILY_LIMIT = Number(process.env.MYMSAF_OUTREACH_DAILY_LIMIT || 20);
const FROM_EMAIL = process.env.MYMSAF_FROM_EMAIL || "";
const REPLY_TO_EMAIL = process.env.MYMSAF_REPLY_TO_EMAIL || FROM_EMAIL;
const TEST_RECIPIENT = process.env.MYMSAF_TEST_RECIPIENT || "";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => escapeCsv(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function resolveProvider() {
  if (RESEND_API_KEY) return "resend";
  if (SENDGRID_API_KEY) return "sendgrid";
  return "none";
}

async function sendWithResend({ to, subject, body }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      reply_to: REPLY_TO_EMAIL || undefined,
      subject,
      text: body
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend ${response.status}: ${text.slice(0, 200)}`);
  }

  const payload = await response.json();
  return payload.id || "";
}

async function sendWithSendGrid({ to, subject, body }) {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL },
      reply_to: REPLY_TO_EMAIL ? { email: REPLY_TO_EMAIL } : undefined,
      subject,
      content: [{ type: "text/plain", value: body }]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SendGrid ${response.status}: ${text.slice(0, 200)}`);
  }

  return "";
}

async function sendEmail({ provider, to, subject, body }) {
  if (provider === "resend") return sendWithResend({ to, subject, body });
  if (provider === "sendgrid") return sendWithSendGrid({ to, subject, body });
  throw new Error("No provider configured");
}

function dedupeSent(log) {
  const map = new Map();
  for (const item of log) {
    const key = `${item.leadId}|${item.sentDate}`;
    map.set(key, item);
  }
  return [...map.values()];
}

async function main() {
  await mkdir(liveDir, { recursive: true });

  const queue = await readJson(queueJsonFile, []);
  const sentLog = dedupeSent(await readJson(sentLogFile, []));
  const provider = resolveProvider();
  const today = isoDate();
  const alreadySentToday = sentLog.filter(
    (item) => item.sentDate === today && item.status === "sent"
  ).length;
  const remainingToday = Math.max(0, DAILY_LIMIT - alreadySentToday);

  const summary = {
    updatedAtUtc: new Date().toISOString(),
    provider,
    dailyLimit: DAILY_LIMIT,
    alreadySentToday,
    remainingToday,
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedNoEmail: 0,
    skippedNoProvider: 0,
    pending: 0,
    sentLast7d: 0,
    mode:
      provider === "none" || !FROM_EMAIL ? "blocked-missing-provider" : "active"
  };

  const sentIndex = new Set(
    sentLog.filter((item) => item.status === "sent").map((item) => item.leadId)
  );

  const sendable = queue.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.status && item.status !== "pending") return false;
    if (!item.email) return false;
    if (sentIndex.has(item.leadId)) return false;
    return true;
  });

  const limit = Math.min(remainingToday, sendable.length);
  const targets = sendable.slice(0, limit);

  for (const target of queue) {
    if ((target.status === "pending" || !target.status) && !target.email) {
      summary.skippedNoEmail += 1;
    }
  }

  if (provider === "none" || !FROM_EMAIL) {
    summary.skippedNoProvider = targets.length;
    summary.pending = queue.filter((item) => item.status === "pending").length;
    await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
    const headers = [
      "leadId",
      "businessName",
      "vertical",
      "website",
      "phone",
      "email",
      "subject",
      "message",
      "ctaUrl",
      "status"
    ];
    await writeFile(queueCsvFile, toCsv(queue, headers), "utf8");
    return;
  }

  for (const item of targets) {
    summary.attempted += 1;
    const recipient = TEST_RECIPIENT || item.email;
    const testPrefix =
      TEST_RECIPIENT && TEST_RECIPIENT !== item.email
        ? `[TEST to ${TEST_RECIPIENT}] Original recipient: ${item.email}\n\n`
        : "";

    try {
      const messageId = await sendEmail({
        provider,
        to: recipient,
        subject: item.subject,
        body: `${testPrefix}${item.message}`
      });
      item.status = "sent";
      item.sentAtUtc = new Date().toISOString();
      summary.sent += 1;
      sentLog.push({
        leadId: item.leadId,
        businessName: item.businessName,
        email: item.email,
        provider,
        messageId,
        sentAtUtc: item.sentAtUtc,
        sentDate: isoDate(new Date(item.sentAtUtc)),
        status: "sent"
      });
    } catch (error) {
      item.status = "failed";
      item.lastError = String(error.message || error).slice(0, 320);
      summary.failed += 1;
      sentLog.push({
        leadId: item.leadId,
        businessName: item.businessName,
        email: item.email,
        provider,
        messageId: "",
        sentAtUtc: new Date().toISOString(),
        sentDate: today,
        status: "failed",
        error: item.lastError
      });
    }
  }

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  summary.sentLast7d = sentLog.filter(
    (item) => item.status === "sent" && Date.parse(item.sentAtUtc) >= cutoff
  ).length;
  summary.pending = queue.filter((item) => item.status === "pending").length;

  const headers = [
    "leadId",
    "businessName",
    "vertical",
    "website",
    "phone",
    "email",
    "subject",
    "message",
    "ctaUrl",
    "status"
  ];

  await writeFile(queueJsonFile, JSON.stringify(queue, null, 2) + "\n", "utf8");
  await writeFile(queueCsvFile, toCsv(queue, headers), "utf8");
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeFile(
    sentLogFile,
    JSON.stringify(dedupeSent(sentLog), null, 2) + "\n",
    "utf8"
  );

  console.log(
    `Outreach: attempted=${summary.attempted} sent=${summary.sent} failed=${summary.failed}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
