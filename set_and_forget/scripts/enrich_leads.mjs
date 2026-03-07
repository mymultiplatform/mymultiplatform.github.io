import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const liveDir = path.join(rootDir, "live");

const leadsJsonFile = path.join(liveDir, "sd_leads.json");
const leadsCsvFile = path.join(liveDir, "sd_leads.csv");
const queueJsonFile = path.join(liveDir, "outreach_queue.json");
const queueCsvFile = path.join(liveDir, "outreach_queue.csv");
const summaryFile = path.join(liveDir, "lead_enrichment_summary.json");

const ENRICH_HOURS = Number(process.env.MYMSAF_ENRICH_HOURS || 24);
const MAX_SITES = Number(process.env.MYMSAF_ENRICH_MAX_SITES || 30);
const FETCH_TIMEOUT_MS = Number(process.env.MYMSAF_ENRICH_TIMEOUT_MS || 10000);
const ENRICH_CONCURRENCY = Number(process.env.MYMSAF_ENRICH_CONCURRENCY || 8);
const CONTACT_PATHS = ["/contact", "/contact-us", "/about", "/about-us"];

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

function isValidEmail(email) {
  const value = String(email || "").trim();
  if (!value) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value)) return false;
  const blockedFragments = [
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".webp",
    "@example.",
    "@domain.",
    "sentry.io"
  ];
  const lower = value.toLowerCase();
  return !blockedFragments.some((item) => lower.includes(item));
}

function pickBestEmail(candidates) {
  const cleaned = [...new Set(candidates.map((item) => String(item).trim()))]
    .filter(isValidEmail)
    .filter((item) => !item.toLowerCase().includes("noreply"));
  return cleaned[0] || "";
}

function normalizeWebsite(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://${value}`;
}

function extractEmails(text) {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return matches;
}

function extractPhones(text) {
  const matches =
    text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || [];
  return [...new Set(matches.map((item) => item.replace(/\s+/g, " ").trim()))];
}

function resolveUrl(base, link) {
  try {
    return new URL(link, base).toString();
  } catch {
    return "";
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MYMSAF-LeadEnricher/1.0; +https://www.mymultiplatform.com)"
      }
    });
    if (!response.ok) return "";
    const contentType = String(response.headers.get("content-type") || "");
    if (!contentType.includes("text/html")) return "";
    return await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function extractContactLinks(baseUrl, html) {
  const links = [];
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const href = String(match[1] || "");
    if (!href) continue;
    const lower = href.toLowerCase();
    if (
      lower.includes("contact") ||
      lower.includes("about") ||
      lower.includes("support")
    ) {
      const resolved = resolveUrl(baseUrl, href);
      if (resolved) links.push(resolved);
    }
  }
  for (const extra of CONTACT_PATHS) {
    const resolved = resolveUrl(baseUrl, extra);
    if (resolved) links.push(resolved);
  }
  return [...new Set(links)].slice(0, 2);
}

function buildMessage(lead) {
  const verticalLabel = String(lead.vertical || "local business").replaceAll(
    "_",
    " "
  );
  const subject = `${lead.businessName}: 90% automated lead follow-up setup`;
  const body = [
    `Hi ${lead.businessName} team,`,
    "",
    `I run MYMSAF (MyMultiPlatform Set-and-Forget) for ${verticalLabel} businesses in San Diego.`,
    "We deploy a no-call, mostly automated pipeline for lead response, follow-up, and client reporting.",
    "",
    "If useful, I can send a short async audit and projected weekly lift with zero meetings.",
    "Reply YES and I will send the setup outline + pricing.",
    "",
    "Dante | MYMSAF"
  ].join("\n");
  return { subject, body };
}

function leadScore(lead) {
  let score = 0;
  if (lead.website) score += 2;
  if (lead.phone) score += 1;
  if (lead.email) score += 1;
  if (lead.vertical === "dentist" || lead.vertical === "plumber") score += 0.5;
  return score;
}

async function main() {
  await mkdir(liveDir, { recursive: true });
  const leads = await readJson(leadsJsonFile, []);
  const queue = await readJson(queueJsonFile, []);
  if (!Array.isArray(leads) || leads.length === 0) {
    return;
  }

  const previousSummary = await readJson(summaryFile, null);
  const previousRunMs = previousSummary
    ? Date.parse(previousSummary.updatedAtUtc || "")
    : NaN;
  const due =
    !Number.isFinite(previousRunMs) ||
    (Date.now() - previousRunMs) / (1000 * 60 * 60) >= ENRICH_HOURS;

  if (!due) {
    return;
  }

  let processed = 0;
  let emailFound = 0;
  let phoneFound = 0;
  let queueAdded = 0;

  const candidates = leads
    .filter((lead) => !lead.email && lead.website)
    .slice(0, MAX_SITES);

  async function enrichLead(lead) {
    const baseUrl = normalizeWebsite(lead.website);
    if (!baseUrl) return { emailFound: 0, phoneFound: 0 };

    const primaryHtml = await fetchText(baseUrl);
    if (!primaryHtml) return { emailFound: 0, phoneFound: 0 };

    const emails = extractEmails(primaryHtml);
    const phones = extractPhones(primaryHtml);
    const contactLinks = extractContactLinks(baseUrl, primaryHtml);
    for (const link of contactLinks) {
      const html = await fetchText(link);
      if (!html) continue;
      emails.push(...extractEmails(html));
      phones.push(...extractPhones(html));
      if (emails.length > 0 && phones.length > 0) break;
    }

    let foundEmail = 0;
    let foundPhone = 0;
    const bestEmail = pickBestEmail(emails);
    if (bestEmail) {
      lead.email = bestEmail;
      lead.emailSource = "website-enrichment";
      lead.enrichedAtUtc = new Date().toISOString();
      foundEmail = 1;
    }

    if (!lead.phone && phones.length > 0) {
      lead.phone = phones[0];
      lead.phoneSource = "website-enrichment";
      lead.enrichedAtUtc = new Date().toISOString();
      foundPhone = 1;
    }

    lead.score = leadScore(lead);
    return { emailFound: foundEmail, phoneFound: foundPhone };
  }

  for (let i = 0; i < candidates.length; i += ENRICH_CONCURRENCY) {
    const chunk = candidates.slice(i, i + ENRICH_CONCURRENCY);
    processed += chunk.length;
    const results = await Promise.all(chunk.map((lead) => enrichLead(lead)));
    for (const result of results) {
      emailFound += result.emailFound;
      phoneFound += result.phoneFound;
    }
  }

  const queueByLeadId = new Map(
    queue.map((item) => [String(item.leadId || ""), item])
  );

  for (const lead of leads) {
    if (!lead.email) continue;
    if (!lead.website && !lead.phone) continue;
    const key = String(lead.id || "");
    if (!key) continue;
    const existing = queueByLeadId.get(key);
    const { subject, body } = buildMessage(lead);
    if (!existing) {
      queue.push({
        leadId: key,
        businessName: lead.businessName,
        vertical: lead.vertical,
        website: lead.website || "",
        phone: lead.phone || "",
        email: lead.email || "",
        subject,
        message: body,
        ctaUrl: "https://www.mymultiplatform.com/set_and_forget/",
        status: "pending"
      });
      queueAdded += 1;
      continue;
    }
    if (!existing.email && lead.email) existing.email = lead.email;
    if (!existing.phone && lead.phone) existing.phone = lead.phone;
    if (!existing.website && lead.website) existing.website = lead.website;
    if (!existing.subject) existing.subject = subject;
    if (!existing.message) existing.message = body;
    if (!existing.ctaUrl) {
      existing.ctaUrl = "https://www.mymultiplatform.com/set_and_forget/";
    }
  }

  leads.sort((a, b) => (b.score || 0) - (a.score || 0));

  const leadHeaders = [
    "id",
    "businessName",
    "vertical",
    "website",
    "phone",
    "email",
    "lat",
    "lon",
    "source",
    "score"
  ];
  const queueHeaders = [
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

  const summary = {
    updatedAtUtc: new Date().toISOString(),
    leadsScanned: processed,
    leadsTotal: leads.length,
    emailFound,
    phoneFound,
    queueAdded,
    queueTotal: queue.length
  };

  await writeFile(leadsJsonFile, JSON.stringify(leads, null, 2) + "\n", "utf8");
  await writeFile(leadsCsvFile, toCsv(leads, leadHeaders), "utf8");
  await writeFile(queueJsonFile, JSON.stringify(queue, null, 2) + "\n", "utf8");
  await writeFile(queueCsvFile, toCsv(queue, queueHeaders), "utf8");
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(
    `Lead enrichment: scanned=${processed} emailFound=${emailFound} queueAdded=${queueAdded}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
