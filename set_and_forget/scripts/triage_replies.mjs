import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const liveDir = path.join(rootDir, "live");

const sentLogFile = path.join(liveDir, "outreach_sent.json");
const summaryFile = path.join(liveDir, "reply_triage.json");

const CONTACT_EMAIL =
  process.env.MYMSAF_CONTACT_EMAIL || "mymultiplatform@gmail.com";
const GMAIL_ACCESS_TOKEN = process.env.GMAIL_ACCESS_TOKEN || "";
const GMAIL_USER_ID = process.env.GMAIL_USER_ID || "me";
const TRIAGE_HOURS = Number(process.env.MYMSAF_REPLY_TRIAGE_HOURS || 6);
const TRIAGE_MAX_MESSAGES = Number(process.env.MYMSAF_REPLY_TRIAGE_MAX_MESSAGES || 200);
const QUERY_WINDOW_DAYS = Number(process.env.MYMSAF_REPLY_QUERY_DAYS || 14);

const HOT_REGEX =
  /\b(yes|interested|let'?s|start|ready|how much|price|proposal|quote|send details|sign up|do it)\b/i;
const COLD_REGEX =
  /\b(not interested|unsubscribe|remove me|stop|no thanks|don't contact|spam)\b/i;
const WARM_REGEX =
  /\b(maybe|question|curious|details|info|timing|later|budget)\b/i;

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

function parseEmailAddress(value) {
  const text = String(value || "");
  const bracketMatch = text.match(/<([^>]+)>/);
  if (bracketMatch) {
    return String(bracketMatch[1] || "").trim().toLowerCase();
  }
  const direct = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return direct ? String(direct[0]).toLowerCase() : "";
}

function pickHeader(headers, target) {
  const found = (headers || []).find(
    (entry) => String(entry?.name || "").toLowerCase() === target.toLowerCase()
  );
  return String(found?.value || "");
}

function classifyTier({ subject, snippet }) {
  const text = `${subject || ""}\n${snippet || ""}`.toLowerCase();
  if (COLD_REGEX.test(text)) return "cold";
  if (HOT_REGEX.test(text)) return "hot";
  if (WARM_REGEX.test(text) || text.includes("?")) return "warm";
  return "warm";
}

function withinDays(isoDate, days) {
  const ms = Date.parse(String(isoDate || ""));
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms <= days * 24 * 60 * 60 * 1000;
}

async function gmailFetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GMAIL_ACCESS_TOKEN}`
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail API ${response.status}: ${text.slice(0, 260)}`);
  }
  return await response.json();
}

async function listMessageIds() {
  const ids = [];
  let pageToken = "";

  while (ids.length < TRIAGE_MAX_MESSAGES) {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(
        GMAIL_USER_ID
      )}/messages`
    );
    url.searchParams.set(
      "q",
      `to:${CONTACT_EMAIL} newer_than:${QUERY_WINDOW_DAYS}d`
    );
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const payload = await gmailFetchJson(url);
    const batch = Array.isArray(payload.messages) ? payload.messages : [];
    for (const item of batch) {
      if (item?.id) ids.push(String(item.id));
      if (ids.length >= TRIAGE_MAX_MESSAGES) break;
    }
    pageToken = String(payload.nextPageToken || "");
    if (!pageToken || batch.length === 0) break;
  }

  return ids;
}

async function getMessageDetails(messageIds) {
  const details = [];
  for (let i = 0; i < messageIds.length; i += 20) {
    const chunk = messageIds.slice(i, i + 20);
    const rows = await Promise.all(
      chunk.map(async (id) => {
        const url = new URL(
          `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(
            GMAIL_USER_ID
          )}/messages/${encodeURIComponent(id)}`
        );
        url.searchParams.set("format", "metadata");
        url.searchParams.append("metadataHeaders", "From");
        url.searchParams.append("metadataHeaders", "Subject");
        url.searchParams.append("metadataHeaders", "Date");
        url.searchParams.append("metadataHeaders", "To");
        const payload = await gmailFetchJson(url);
        return payload;
      })
    );
    details.push(...rows);
  }
  return details;
}

function buildSentRecipientIndex(sentLog) {
  const byEmail = new Map();
  for (const item of sentLog) {
    if (!item || typeof item !== "object") continue;
    if (item.status !== "sent") continue;
    if (item.channel && item.channel !== "email") continue;
    const email = parseEmailAddress(item.recipient || item.email);
    if (!email) continue;
    const prior = byEmail.get(email);
    if (
      !prior ||
      Date.parse(String(item.sentAtUtc || "")) >
        Date.parse(String(prior.sentAtUtc || ""))
    ) {
      byEmail.set(email, item);
    }
  }
  return byEmail;
}

function shouldRun(previous) {
  if (!previous || !previous.updatedAtUtc) return true;
  const lastMs = Date.parse(String(previous.updatedAtUtc || ""));
  if (!Number.isFinite(lastMs)) return true;
  const elapsedHours = (Date.now() - lastMs) / (1000 * 60 * 60);
  return elapsedHours >= TRIAGE_HOURS;
}

async function writeSummary(summary) {
  await mkdir(liveDir, { recursive: true });
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
}

async function main() {
  await mkdir(liveDir, { recursive: true });
  const previous = await readJson(summaryFile, null);
  if (!shouldRun(previous)) {
    console.log("Reply triage not due yet");
    return;
  }

  if (!GMAIL_ACCESS_TOKEN) {
    const fallback = {
      ...(previous && previous.mode === "active" ? previous : {}),
      updatedAtUtc: new Date().toISOString(),
      mode: "blocked-missing-token",
      source: "gmail-api",
      note: "Set GMAIL_ACCESS_TOKEN to enable Gmail reply triage."
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
    const sentLog = await readJson(sentLogFile, []);
    const sentByEmail = buildSentRecipientIndex(Array.isArray(sentLog) ? sentLog : []);
    if (sentByEmail.size === 0) {
      const idle = {
        updatedAtUtc: new Date().toISOString(),
        mode: "idle-no-sent-email",
        source: "gmail-api",
        note: "No sent email records available for reply matching.",
        scannedMessages: 0,
        matchedReplies: 0,
        hot: 0,
        warm: 0,
        cold: 0,
        hot7d: 0,
        warm7d: 0,
        cold7d: 0,
        unreadMatched: 0,
        lastMessageAtUtc: "",
        items: []
      };
      await writeSummary(idle);
      return;
    }

    const messageIds = await listMessageIds();
    const messages = await getMessageDetails(messageIds);

    const matched = [];
    for (const message of messages) {
      const payloadHeaders = message?.payload?.headers || [];
      const fromHeader = pickHeader(payloadHeaders, "From");
      const subject = pickHeader(payloadHeaders, "Subject");
      const fromEmail = parseEmailAddress(fromHeader);
      const sentMeta = sentByEmail.get(fromEmail);
      if (!sentMeta) continue;

      const receivedAtUtc = Number.isFinite(Number(message.internalDate))
        ? new Date(Number(message.internalDate)).toISOString()
        : "";
      const snippet = String(message.snippet || "");
      const tier = classifyTier({ subject, snippet });

      matched.push({
        messageId: String(message.id || ""),
        threadId: String(message.threadId || ""),
        receivedAtUtc,
        fromEmail,
        fromName: fromHeader.replace(/<[^>]+>/g, "").trim(),
        subject,
        snippet,
        tier,
        unread: Array.isArray(message.labelIds)
          ? message.labelIds.includes("UNREAD")
          : false,
        leadId: String(sentMeta.leadId || ""),
        businessName: String(sentMeta.businessName || ""),
        recipientEmail: parseEmailAddress(sentMeta.recipient || sentMeta.email)
      });
    }

    matched.sort(
      (a, b) => Date.parse(String(b.receivedAtUtc || "")) - Date.parse(String(a.receivedAtUtc || ""))
    );

    const hot = matched.filter((item) => item.tier === "hot").length;
    const warm = matched.filter((item) => item.tier === "warm").length;
    const cold = matched.filter((item) => item.tier === "cold").length;
    const hot7d = matched.filter(
      (item) => item.tier === "hot" && withinDays(item.receivedAtUtc, 7)
    ).length;
    const warm7d = matched.filter(
      (item) => item.tier === "warm" && withinDays(item.receivedAtUtc, 7)
    ).length;
    const cold7d = matched.filter(
      (item) => item.tier === "cold" && withinDays(item.receivedAtUtc, 7)
    ).length;
    const unreadMatched = matched.filter((item) => item.unread).length;

    const summary = {
      updatedAtUtc: new Date().toISOString(),
      mode: "active",
      source: "gmail-api",
      contactEmail: CONTACT_EMAIL,
      scannedMessages: messages.length,
      matchedReplies: matched.length,
      hot,
      warm,
      cold,
      hot7d,
      warm7d,
      cold7d,
      unreadMatched,
      lastMessageAtUtc: matched[0]?.receivedAtUtc || "",
      items: matched.slice(0, 200)
    };

    if (
      previous &&
      JSON.stringify(withoutUpdatedAt(previous)) ===
        JSON.stringify(withoutUpdatedAt(summary))
    ) {
      summary.updatedAtUtc = previous.updatedAtUtc;
    }
    await writeSummary(summary);
    console.log(
      `Reply triage: matched=${summary.matchedReplies} hot=${summary.hot} warm=${summary.warm} cold=${summary.cold}`
    );
  } catch (error) {
    const fallback = {
      ...(previous && previous.mode === "active" ? previous : {}),
      updatedAtUtc: new Date().toISOString(),
      mode: "error",
      source: "gmail-api",
      note: `Reply triage failed: ${String(error.message || error).slice(0, 260)}`
    };
    await writeSummary(fallback);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
