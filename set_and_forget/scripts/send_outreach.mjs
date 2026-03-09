import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const liveDir = path.join(rootDir, "live");
const execFileAsync = promisify(execFile);

const queueJsonFile = path.join(liveDir, "outreach_queue.json");
const queueCsvFile = path.join(liveDir, "outreach_queue.csv");
const sentLogFile = path.join(liveDir, "outreach_sent.json");
const summaryFile = path.join(liveDir, "outreach_summary.json");

const DAILY_LIMIT = Number(process.env.MYMSAF_OUTREACH_DAILY_LIMIT || 20);
const SMS_DAILY_LIMIT = Number(process.env.MYMSAF_SMS_DAILY_LIMIT || 20);
const FROM_EMAIL = process.env.MYMSAF_FROM_EMAIL || "";
const REPLY_TO_EMAIL = process.env.MYMSAF_REPLY_TO_EMAIL || FROM_EMAIL;
const TEST_RECIPIENT = process.env.MYMSAF_TEST_RECIPIENT || "";
const SMS_TEST_RECIPIENT = process.env.MYMSAF_SMS_TEST_RECIPIENT || "";
const SMS_ONLY_WHEN_NO_EMAIL = toBool(
  process.env.MYMSAF_SMS_ONLY_WHEN_NO_EMAIL,
  true
);
const APPLE_MAIL_ENABLED = toBool(process.env.MYMSAF_USE_APPLE_MAIL, false);
const APPLE_MAIL_SENDER = process.env.MYMSAF_APPLE_MAIL_SENDER || "";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const TWILIO_MESSAGING_SERVICE_SID =
  process.env.TWILIO_MESSAGING_SERVICE_SID || "";

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
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

function withoutUpdatedAt(payload) {
  const clone = { ...(payload || {}) };
  delete clone.updatedAtUtc;
  return clone;
}

function normalizePhone(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const startsPlus = value.startsWith("+");
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return "";
  if (startsPlus) {
    if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
    return "";
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function resolveProviders() {
  let emailProvider = "none";
  if (RESEND_API_KEY) emailProvider = "resend";
  else if (SENDGRID_API_KEY) emailProvider = "sendgrid";
  else if (APPLE_MAIL_ENABLED) emailProvider = "apple-mail";

  let smsProvider = "none";
  if (
    TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    (TWILIO_FROM_NUMBER || TWILIO_MESSAGING_SERVICE_SID)
  ) {
    smsProvider = "twilio";
  }
  return { emailProvider, smsProvider };
}

function sentChannel(item) {
  return item?.channel === "sms" ? "sms" : "email";
}

function normalizeMessageKind(item) {
  const value = String(item?.messageKind || "initial").trim().toLowerCase();
  return value || "initial";
}

function queueMessageKey(item) {
  return `${String(item?.leadId || "")}|${normalizeMessageKind(item)}`;
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

function escapeAppleScript(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
}

async function sendWithAppleMail({ to, subject, body }) {
  if (process.platform !== "darwin") {
    throw new Error("Apple Mail provider requires macOS");
  }

  const toEscaped = escapeAppleScript(to);
  const subjectEscaped = escapeAppleScript(subject);
  const bodyEscaped = escapeAppleScript(body);
  const senderEscaped = escapeAppleScript(APPLE_MAIL_SENDER);
  const lines = [
    'tell application "Mail"',
    `set outgoingMessage to make new outgoing message with properties {subject:"${subjectEscaped}", content:"${bodyEscaped}\\n\\n", visible:false}`,
    "tell outgoingMessage",
    `make new to recipient at end of to recipients with properties {address:"${toEscaped}"}`,
    senderEscaped ? `set sender to "${senderEscaped}"` : "",
    "send",
    "end tell",
    "end tell"
  ].filter(Boolean);

  await execFileAsync(
    "osascript",
    lines.flatMap((line) => ["-e", line]),
    { timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  return "";
}

async function sendWithTwilio({ to, body }) {
  const auth = Buffer.from(
    `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`,
    "utf8"
  ).toString("base64");
  const payload = new URLSearchParams({
    To: to,
    Body: body
  });
  if (TWILIO_MESSAGING_SERVICE_SID) {
    payload.set("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
  } else {
    payload.set("From", TWILIO_FROM_NUMBER);
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: payload.toString()
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio ${response.status}: ${text.slice(0, 240)}`);
  }

  const result = await response.json();
  return result.sid || "";
}

async function sendEmail({ provider, to, subject, body }) {
  if (provider === "resend") return sendWithResend({ to, subject, body });
  if (provider === "sendgrid") return sendWithSendGrid({ to, subject, body });
  if (provider === "apple-mail") return sendWithAppleMail({ to, subject, body });
  throw new Error("No provider configured");
}

async function sendSms({ provider, to, body }) {
  if (provider === "twilio") return sendWithTwilio({ to, body });
  throw new Error("No SMS provider configured");
}

function buildSmsMessage(item) {
  const message = String(item.smsMessage || item.message || "").replace(/\s+/g, " ").trim();
  if (message) return message.slice(0, 640);
  const business = String(item.businessName || "your team");
  return `Hi ${business}, I run Inbox-to-Booking Autopilot for San Diego businesses. Reply YES for async details.`;
}

function dedupeSent(log) {
  const map = new Map();
  for (const item of log) {
    const channel = sentChannel(item);
    const messageKind = normalizeMessageKind(item);
    const recipient = String(item.recipient || item.email || "");
    const key = `${item.leadId}|${channel}|${messageKind}|${item.sentDate}|${recipient.toLowerCase()}`;
    map.set(key, item);
  }
  return [...map.values()];
}

async function main() {
  await mkdir(liveDir, { recursive: true });

  const queue = await readJson(queueJsonFile, []);
  const sentLog = dedupeSent(await readJson(sentLogFile, []));
  const previousSummary = await readJson(summaryFile, null);
  const providers = resolveProviders();
  if (
    providers.emailProvider !== "none" &&
    providers.emailProvider !== "apple-mail" &&
    !FROM_EMAIL
  ) {
    providers.emailProvider = "none";
  }
  const today = isoDate();
  const alreadySentTodayEmail = sentLog.filter(
    (item) =>
      item.sentDate === today &&
      item.status === "sent" &&
      sentChannel(item) === "email"
  ).length;
  const alreadySentTodaySms = sentLog.filter(
    (item) =>
      item.sentDate === today &&
      item.status === "sent" &&
      sentChannel(item) === "sms"
  ).length;
  const remainingTodayEmail = Math.max(0, DAILY_LIMIT - alreadySentTodayEmail);
  const remainingTodaySms = Math.max(0, SMS_DAILY_LIMIT - alreadySentTodaySms);
  const hasAnyProvider =
    providers.emailProvider !== "none" || providers.smsProvider !== "none";

  const summary = {
    updatedAtUtc: new Date().toISOString(),
    provider: providers.emailProvider,
    emailProvider: providers.emailProvider,
    smsProvider: providers.smsProvider,
    dailyLimit: DAILY_LIMIT,
    smsDailyLimit: SMS_DAILY_LIMIT,
    alreadySentToday: alreadySentTodayEmail + alreadySentTodaySms,
    alreadySentTodayEmail,
    alreadySentTodaySms,
    remainingToday: remainingTodayEmail + remainingTodaySms,
    remainingTodayEmail,
    remainingTodaySms,
    attempted: 0,
    attemptedEmail: 0,
    attemptedSms: 0,
    sent: 0,
    sentEmail: 0,
    sentSms: 0,
    sentInitial: 0,
    sentFollowup: 0,
    failed: 0,
    failedEmail: 0,
    failedSms: 0,
    skippedNoEmail: 0,
    skippedNoPhone: 0,
    skippedNoProvider: 0,
    pending: 0,
    sentLast7d: 0,
    emailSentLast7d: 0,
    smsSentLast7d: 0,
    mode: hasAnyProvider ? "active" : "blocked-missing-provider"
  };

  const sentIndexEmail = new Set(
    sentLog
      .filter((item) => item.status === "sent" && sentChannel(item) === "email")
      .map((item) => `${String(item.leadId || "")}|${normalizeMessageKind(item)}`)
  );
  const sentIndexSms = new Set(
    sentLog
      .filter((item) => item.status === "sent" && sentChannel(item) === "sms")
      .map((item) => `${String(item.leadId || "")}|${normalizeMessageKind(item)}`)
  );
  const pendingQueue = queue.filter(
    (item) => item && typeof item === "object" && (!item.status || item.status === "pending")
  );

  for (const item of pendingQueue) {
    if (!item.messageKind) item.messageKind = "initial";
    if (!Number.isFinite(Number(item.followupStage))) item.followupStage = 0;
    if (!item.createdAtUtc) item.createdAtUtc = new Date().toISOString();
    if (!item.email) summary.skippedNoEmail += 1;
    if (!normalizePhone(item.phone)) summary.skippedNoPhone += 1;
  }

  const emailTargets = pendingQueue.filter(
    (item) => item.email && !sentIndexEmail.has(queueMessageKey(item))
  );
  const smsCandidates = pendingQueue
    .map((item) => ({ ...item, phoneNormalized: normalizePhone(item.phone) }))
    .filter((item) => {
      if (!item.phoneNormalized) return false;
      if (SMS_ONLY_WHEN_NO_EMAIL && item.email) return false;
      if (sentIndexSms.has(queueMessageKey(item))) return false;
      return true;
    });

  if (!hasAnyProvider || summary.mode !== "active") {
    summary.skippedNoProvider = emailTargets.length + smsCandidates.length;
    summary.pending = queue.filter(
      (item) => item.status === "pending" || !item.status
    ).length;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    summary.emailSentLast7d = sentLog.filter(
      (item) =>
        item.status === "sent" &&
        sentChannel(item) === "email" &&
        Date.parse(item.sentAtUtc) >= cutoff
    ).length;
    summary.smsSentLast7d = sentLog.filter(
      (item) =>
        item.status === "sent" &&
        sentChannel(item) === "sms" &&
        Date.parse(item.sentAtUtc) >= cutoff
    ).length;
    summary.sentLast7d = summary.emailSentLast7d + summary.smsSentLast7d;
    if (
      previousSummary &&
      JSON.stringify(withoutUpdatedAt(previousSummary)) ===
        JSON.stringify(withoutUpdatedAt(summary))
    ) {
      summary.updatedAtUtc = previousSummary.updatedAtUtc;
    }
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
      "smsMessage",
      "ctaUrl",
      "messageKind",
      "followupStage",
      "status",
      "emailStatus",
      "smsStatus",
      "lastError",
      "smsLastError",
      "createdAtUtc"
    ];
    await writeFile(queueJsonFile, JSON.stringify(queue, null, 2) + "\n", "utf8");
    await writeFile(queueCsvFile, toCsv(queue, headers), "utf8");
    return;
  }

  if (providers.emailProvider === "none") {
    summary.skippedNoProvider += emailTargets.length;
  }
  if (providers.smsProvider === "none") {
    summary.skippedNoProvider += smsCandidates.length;
  }

  const emailLimit = Math.min(remainingTodayEmail, emailTargets.length);
  const smsLimit = Math.min(remainingTodaySms, smsCandidates.length);
  const emailSendQueue =
    providers.emailProvider === "none" ? [] : emailTargets.slice(0, emailLimit);
  const smsSendQueue =
    providers.smsProvider === "none" ? [] : smsCandidates.slice(0, smsLimit);

  for (const item of emailSendQueue) {
    summary.attempted += 1;
    summary.attemptedEmail += 1;
    const recipient = TEST_RECIPIENT || item.email;
    const testPrefix =
      TEST_RECIPIENT && TEST_RECIPIENT !== item.email
        ? `[TEST to ${TEST_RECIPIENT}] Original recipient: ${item.email}\n\n`
        : "";

    try {
      const messageId = await sendEmail({
        provider: providers.emailProvider,
        to: recipient,
        subject: item.subject,
        body: `${testPrefix}${item.message}`
      });
      item.status = "sent";
      item.emailStatus = "sent";
      item.emailSentAtUtc = new Date().toISOString();
      item.sentAtUtc = item.sentAtUtc || item.emailSentAtUtc;
      const messageKind = normalizeMessageKind(item);
      summary.sent += 1;
      summary.sentEmail += 1;
      if (messageKind === "initial") summary.sentInitial += 1;
      else summary.sentFollowup += 1;
      sentLog.push({
        leadId: item.leadId,
        businessName: item.businessName,
        email: item.email,
        recipient,
        provider: providers.emailProvider,
        channel: "email",
        messageKind,
        followupStage: Number(item.followupStage || 0),
        messageId,
        sentAtUtc: item.emailSentAtUtc,
        sentDate: isoDate(new Date(item.emailSentAtUtc)),
        status: "sent"
      });
    } catch (error) {
      if (item.status === "pending" || !item.status) {
        item.status = "failed";
      }
      item.emailStatus = "failed";
      item.lastError = String(error.message || error).slice(0, 320);
      summary.failed += 1;
      summary.failedEmail += 1;
      sentLog.push({
        leadId: item.leadId,
        businessName: item.businessName,
        email: item.email,
        recipient,
        provider: providers.emailProvider,
        channel: "email",
        messageId: "",
        sentAtUtc: new Date().toISOString(),
        sentDate: today,
        status: "failed",
        error: item.lastError
      });
    }
  }

  for (const item of smsSendQueue) {
    summary.attempted += 1;
    summary.attemptedSms += 1;
    const recipient = SMS_TEST_RECIPIENT || item.phoneNormalized;
    const smsBody = buildSmsMessage(item);
    const body =
      SMS_TEST_RECIPIENT && SMS_TEST_RECIPIENT !== item.phoneNormalized
        ? `TEST for ${item.businessName} (${item.phoneNormalized}): ${smsBody}`
        : smsBody;

    try {
      const messageId = await sendSms({
        provider: providers.smsProvider,
        to: recipient,
        body
      });
      item.status = "sent";
      item.smsStatus = "sent";
      item.smsSentAtUtc = new Date().toISOString();
      item.sentAtUtc = item.sentAtUtc || item.smsSentAtUtc;
      const messageKind = normalizeMessageKind(item);
      summary.sent += 1;
      summary.sentSms += 1;
      if (messageKind === "initial") summary.sentInitial += 1;
      else summary.sentFollowup += 1;
      sentLog.push({
        leadId: item.leadId,
        businessName: item.businessName,
        recipient,
        provider: providers.smsProvider,
        channel: "sms",
        messageKind,
        followupStage: Number(item.followupStage || 0),
        messageId,
        sentAtUtc: item.smsSentAtUtc,
        sentDate: isoDate(new Date(item.smsSentAtUtc)),
        status: "sent"
      });
    } catch (error) {
      if (item.status === "pending" || !item.status) {
        item.status = "failed";
      }
      item.smsStatus = "failed";
      item.smsLastError = String(error.message || error).slice(0, 320);
      summary.failed += 1;
      summary.failedSms += 1;
      sentLog.push({
        leadId: item.leadId,
        businessName: item.businessName,
        recipient,
        provider: providers.smsProvider,
        channel: "sms",
        messageId: "",
        sentAtUtc: new Date().toISOString(),
        sentDate: today,
        status: "failed",
        error: item.smsLastError
      });
    }
  }

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  summary.emailSentLast7d = sentLog.filter(
    (item) =>
      item.status === "sent" &&
      sentChannel(item) === "email" &&
      Date.parse(item.sentAtUtc) >= cutoff
  ).length;
  summary.smsSentLast7d = sentLog.filter(
    (item) =>
      item.status === "sent" &&
      sentChannel(item) === "sms" &&
      Date.parse(item.sentAtUtc) >= cutoff
  ).length;
  summary.sentLast7d = summary.emailSentLast7d + summary.smsSentLast7d;
  summary.pending = queue.filter(
    (item) => item.status === "pending" || !item.status
  ).length;

  if (
    previousSummary &&
    JSON.stringify(withoutUpdatedAt(previousSummary)) ===
      JSON.stringify(withoutUpdatedAt(summary))
  ) {
    summary.updatedAtUtc = previousSummary.updatedAtUtc;
  }

  const headers = [
    "leadId",
    "businessName",
    "vertical",
    "website",
    "phone",
    "email",
    "subject",
    "message",
    "smsMessage",
    "ctaUrl",
    "messageKind",
    "followupStage",
    "status",
    "emailStatus",
    "smsStatus",
    "lastError",
    "smsLastError",
    "createdAtUtc"
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
    `Outreach: attempted=${summary.attempted} sent=${summary.sent} failed=${summary.failed} emailProvider=${summary.emailProvider} smsProvider=${summary.smsProvider}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
