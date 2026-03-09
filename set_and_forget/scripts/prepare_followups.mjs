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
const replyTriageFile = path.join(liveDir, "reply_triage.json");
const summaryFile = path.join(liveDir, "followup_summary.json");

const FOLLOWUP1_DELAY_HOURS = Number(process.env.MYMSAF_FOLLOWUP1_DELAY_HOURS || 48);
const FOLLOWUP2_DELAY_HOURS = Number(process.env.MYMSAF_FOLLOWUP2_DELAY_HOURS || 120);
const FOLLOWUP_MAX_PER_RUN = Number(process.env.MYMSAF_FOLLOWUP_MAX_PER_RUN || 120);
const CONTACT_EMAIL =
  process.env.MYMSAF_CONTACT_EMAIL || "mymultiplatform@gmail.com";
const CTA_BASE_URL =
  process.env.MYMSAF_CTA_URL ||
  process.env.MYMSAF_PAYMENT_URL ||
  "https://www.mymultiplatform.com/set_and_forget/offer.html";

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

function normalizeMessageKind(value) {
  const normalized = String(value || "initial").trim().toLowerCase();
  return normalized || "initial";
}

function queueMessageKey(item) {
  return `${String(item?.leadId || "")}|${normalizeMessageKind(item?.messageKind)}`;
}

function withoutUpdatedAt(payload) {
  const clone = { ...(payload || {}) };
  delete clone.updatedAtUtc;
  return clone;
}

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseLeadReplies(replyTriage) {
  if (!replyTriage || !Array.isArray(replyTriage.items)) return new Set();
  return new Set(
    replyTriage.items
      .map((item) => String(item?.leadId || ""))
      .filter(Boolean)
  );
}

function elapsedHours(sinceIso, nowMs) {
  const sinceMs = Date.parse(String(sinceIso || ""));
  if (!Number.isFinite(sinceMs)) return NaN;
  return (nowMs - sinceMs) / (1000 * 60 * 60);
}

function buildFollowupMessage(base, stage) {
  const businessName = String(base.businessName || "team");
  const vertical = String(base.vertical || "local business").replaceAll("_", " ");
  const ctaUrl = String(base.ctaUrl || CTA_BASE_URL);

  if (stage === 1) {
    return {
      subject: `${businessName}: quick async follow-up`,
      message: [
        `Hi ${businessName} team,`,
        "",
        `Quick follow-up on my note about Inbox-to-Booking Autopilot for ${vertical} businesses in San Diego.`,
        "It handles instant response plus a 3-touch recovery sequence for missed leads.",
        "I can deploy the first version in 48 hours with async onboarding only.",
        "",
        `Start async setup: ${ctaUrl}`,
        `Reply to ${CONTACT_EMAIL} with "YES" if you want the one-page setup brief.`,
        "",
        `MyMultiPlatform Ops | ${CONTACT_EMAIL}`
      ].join("\n")
    };
  }

  return {
    subject: `${businessName}: final async check-in`,
    message: [
      `Hi ${businessName} team,`,
      "",
      "Final async check-in from me.",
      "If you want Inbox-to-Booking Autopilot, I can still start this week.",
      "",
      `Start async setup: ${ctaUrl}`,
      `Reply to ${CONTACT_EMAIL} with "YES" and I will send the setup brief.`,
      "If this is not relevant, reply STOP and I will close your thread.",
      "",
      `MyMultiPlatform Ops | ${CONTACT_EMAIL}`
    ].join("\n")
  };
}

function buildSentIndex(sentLog) {
  const sentByKey = new Map();
  for (const item of sentLog) {
    if (!item || typeof item !== "object") continue;
    if (item.status !== "sent") continue;
    if (item.channel && item.channel !== "email") continue;
    const key = `${String(item.leadId || "")}|${normalizeMessageKind(item.messageKind)}`;
    const sentAt = String(item.sentAtUtc || "");
    const existing = sentByKey.get(key);
    if (!existing || Date.parse(sentAt) > Date.parse(existing.sentAtUtc || "")) {
      sentByKey.set(key, item);
    }
  }
  return sentByKey;
}

function queueHeaders() {
  return [
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
}

async function main() {
  await mkdir(liveDir, { recursive: true });

  const queue = await readJson(queueJsonFile, []);
  const sentLog = await readJson(sentLogFile, []);
  const replyTriage = await readJson(replyTriageFile, null);
  const previousSummary = await readJson(summaryFile, null);

  if (!Array.isArray(queue) || queue.length === 0) {
    return;
  }

  const repliedLeadIds = parseLeadReplies(replyTriage);
  const existingQueueKeys = new Set(
    queue.map((item) => queueMessageKey(item))
  );
  const sentByKey = buildSentIndex(Array.isArray(sentLog) ? sentLog : []);
  const baseByLead = new Map();
  const nowMs = Date.now();

  for (const item of queue) {
    if (!item || typeof item !== "object") continue;
    const leadId = String(item.leadId || "");
    if (!leadId) continue;
    const kind = normalizeMessageKind(item.messageKind);
    if (kind !== "initial") continue;
    const prior = baseByLead.get(leadId);
    if (!prior) {
      baseByLead.set(leadId, item);
      continue;
    }
    if (!prior.email && item.email) {
      baseByLead.set(leadId, item);
    }
  }

  const summary = {
    updatedAtUtc: new Date().toISOString(),
    queuedFollowup1: 0,
    queuedFollowup2: 0,
    queuedTotal: 0,
    baseCandidates: baseByLead.size,
    skippedReplied: 0,
    skippedNoInitialSent: 0,
    skippedNotDue1: 0,
    skippedNotDue2: 0
  };

  for (const [leadId, base] of baseByLead) {
    if (summary.queuedTotal >= FOLLOWUP_MAX_PER_RUN) break;
    if (repliedLeadIds.has(leadId)) {
      summary.skippedReplied += 1;
      continue;
    }
    if (!base.email) continue;

    const initialKey = `${leadId}|initial`;
    const initialSent = sentByKey.get(initialKey);
    if (!initialSent) {
      summary.skippedNoInitialSent += 1;
      continue;
    }

    const followup1Key = `${leadId}|followup_1`;
    const followup2Key = `${leadId}|followup_2`;
    const followup1Sent = sentByKey.get(followup1Key);
    const followup2Sent = sentByKey.get(followup2Key);

    if (!existingQueueKeys.has(followup1Key) && !followup1Sent) {
      const sinceInitial = elapsedHours(initialSent.sentAtUtc, nowMs);
      if (Number.isFinite(sinceInitial) && sinceInitial >= FOLLOWUP1_DELAY_HOURS) {
        const followup1 = buildFollowupMessage(base, 1);
        queue.push({
          leadId,
          businessName: base.businessName || "",
          vertical: base.vertical || "",
          website: base.website || "",
          phone: base.phone || "",
          email: base.email || "",
          subject: followup1.subject,
          message: followup1.message,
          smsMessage: "",
          ctaUrl: base.ctaUrl || CTA_BASE_URL,
          messageKind: "followup_1",
          followupStage: 1,
          status: "pending",
          emailStatus: "pending",
          smsStatus: "pending",
          lastError: "",
          smsLastError: "",
          createdAtUtc: new Date().toISOString()
        });
        existingQueueKeys.add(followup1Key);
        summary.queuedFollowup1 += 1;
        summary.queuedTotal += 1;
      } else {
        summary.skippedNotDue1 += 1;
      }
    }

    if (summary.queuedTotal >= FOLLOWUP_MAX_PER_RUN) break;
    if (existingQueueKeys.has(followup2Key) || followup2Sent || !followup1Sent) {
      if (!followup1Sent) summary.skippedNotDue2 += 1;
      continue;
    }

    const sinceFollowup1 = elapsedHours(followup1Sent.sentAtUtc, nowMs);
    if (Number.isFinite(sinceFollowup1) && sinceFollowup1 >= FOLLOWUP2_DELAY_HOURS) {
      const followup2 = buildFollowupMessage(base, 2);
      queue.push({
        leadId,
        businessName: base.businessName || "",
        vertical: base.vertical || "",
        website: base.website || "",
        phone: base.phone || "",
        email: base.email || "",
        subject: followup2.subject,
        message: followup2.message,
        smsMessage: "",
        ctaUrl: base.ctaUrl || CTA_BASE_URL,
        messageKind: "followup_2",
        followupStage: 2,
        status: "pending",
        emailStatus: "pending",
        smsStatus: "pending",
        lastError: "",
        smsLastError: "",
        createdAtUtc: new Date().toISOString()
      });
      existingQueueKeys.add(followup2Key);
      summary.queuedFollowup2 += 1;
      summary.queuedTotal += 1;
    } else {
      summary.skippedNotDue2 += 1;
    }
  }

  if (
    previousSummary &&
    JSON.stringify(withoutUpdatedAt(previousSummary)) ===
      JSON.stringify(withoutUpdatedAt(summary))
  ) {
    summary.updatedAtUtc = previousSummary.updatedAtUtc;
  }

  await writeFile(queueJsonFile, JSON.stringify(queue, null, 2) + "\n", "utf8");
  await writeFile(queueCsvFile, toCsv(queue, queueHeaders()), "utf8");
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(
    `Followups: queued=${summary.queuedTotal} f1=${summary.queuedFollowup1} f2=${summary.queuedFollowup2}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
