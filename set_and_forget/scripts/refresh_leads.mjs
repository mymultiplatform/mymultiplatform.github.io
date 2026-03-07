import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const liveDir = path.join(rootDir, "live");
const leadsFile = path.join(liveDir, "sd_leads.csv");
const queueFile = path.join(liveDir, "outreach_queue.csv");
const leadsJsonFile = path.join(liveDir, "sd_leads.json");
const queueJsonFile = path.join(liveDir, "outreach_queue.json");
const metaFile = path.join(liveDir, "lead_refresh_meta.json");
const REFRESH_HOURS = Number(process.env.MYMSAF_LEAD_REFRESH_HOURS || 24);
const PAYMENT_URL =
  process.env.MYMSAF_PAYMENT_URL ||
  "https://www.mymultiplatform.com/set_and_forget/";

const overpassEndpoints = (
  process.env.MYMSAF_OVERPASS_ENDPOINTS ||
  [
    process.env.MYMSAF_OVERPASS_ENDPOINT,
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ]
    .filter(Boolean)
    .join(",")
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const SAN_DIEGO_LAT = Number(process.env.MYMSAF_SD_LAT || 32.7157);
const SAN_DIEGO_LON = Number(process.env.MYMSAF_SD_LON || -117.1611);
const SEARCH_RADIUS_METERS = Number(process.env.MYMSAF_SD_RADIUS || 32000);

const verticalQueries = [
  { id: "dentist", query: 'nwr["amenity"="dentist"]' },
  { id: "plumber", query: 'nwr["craft"="plumber"]' },
  { id: "med_spa", query: 'nwr["shop"="beauty"]' },
  { id: "real_estate", query: 'nwr["office"="estate_agent"]' },
  { id: "med_clinic", query: 'nwr["amenity"="clinic"]' }
];

function escapeCsv(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeWebsite(raw) {
  if (!raw) return "";
  const value = String(raw).trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `https://${value}`;
}

function extractField(tags, candidates) {
  for (const key of candidates) {
    if (tags[key]) return tags[key];
  }
  return "";
}

function classifyVertical(tags) {
  if (tags.amenity === "dentist") return "dentist";
  if (tags.craft === "plumber") return "plumber";
  if (tags.office === "estate_agent") return "real_estate";
  if (tags.amenity === "clinic") return "med_clinic";
  if (tags.shop === "beauty") return "med_spa";
  return "general_local";
}

function leadScore(lead) {
  let score = 0;
  if (lead.website) score += 2;
  if (lead.phone) score += 1;
  if (lead.email) score += 1;
  if (lead.vertical === "dentist" || lead.vertical === "plumber") score += 0.5;
  return score;
}

function dedupe(leads) {
  const byKey = new Map();
  for (const lead of leads) {
    const key =
      `${lead.businessName.toLowerCase()}|${lead.website.toLowerCase()}|${lead.phone}`;
    const prev = byKey.get(key);
    if (!prev || lead.score > prev.score) {
      byKey.set(key, lead);
    }
  }
  return [...byKey.values()];
}

function mergeExistingLeadData(newLeads, existingLeads) {
  const byId = new Map();
  const byWebsite = new Map();
  const byName = new Map();

  for (const lead of existingLeads) {
    if (!lead || typeof lead !== "object") continue;
    if (lead.id) byId.set(String(lead.id), lead);
    if (lead.website) {
      byWebsite.set(String(lead.website).toLowerCase(), lead);
    }
    if (lead.businessName) {
      byName.set(String(lead.businessName).toLowerCase(), lead);
    }
  }

  for (const lead of newLeads) {
    const prior =
      byId.get(String(lead.id || "")) ||
      byWebsite.get(String(lead.website || "").toLowerCase()) ||
      byName.get(String(lead.businessName || "").toLowerCase());
    if (!prior) continue;

    if (!lead.email && prior.email) lead.email = prior.email;
    if (!lead.phone && prior.phone) lead.phone = prior.phone;
    if (!lead.website && prior.website) lead.website = prior.website;
    if (prior.emailSource) lead.emailSource = prior.emailSource;
    if (prior.phoneSource) lead.phoneSource = prior.phoneSource;
    if (prior.enrichedAtUtc) lead.enrichedAtUtc = prior.enrichedAtUtc;
    lead.score = leadScore(lead);
  }

  return newLeads;
}

function buildOverpassQuery() {
  const segments = verticalQueries
    .map(
      (item) =>
        `${item.query}(around:${SEARCH_RADIUS_METERS},${SAN_DIEGO_LAT},${SAN_DIEGO_LON});`
    )
    .join("\n");

  return `[out:json][timeout:120];
(
${segments}
);
out center tags;`;
}

async function fetchLeadsFromEndpoint(endpoint) {
  const query = buildOverpassQuery();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query
  });
  if (!response.ok) {
    throw new Error(`Overpass failed with status ${response.status}`);
  }
  const payload = await response.json();
  const elements = Array.isArray(payload.elements) ? payload.elements : [];
  const leads = [];
  for (const element of elements) {
    const tags = element.tags || {};
    const businessName = String(tags.name || "").trim();
    if (!businessName) continue;

    const website = normalizeWebsite(
      extractField(tags, ["website", "contact:website", "url"])
    );
    const phone = extractField(tags, ["phone", "contact:phone"]);
    const email = extractField(tags, ["email", "contact:email"]);
    const country = String(
      extractField(tags, ["addr:country", "contact:country"])
    ).toUpperCase();
    const phoneCompact = phone.replace(/\s+/g, "");
    if (country && country !== "US" && country !== "USA") continue;
    if (phoneCompact.startsWith("+52")) continue;
    const lat = element.lat ?? element.center?.lat ?? "";
    const lon = element.lon ?? element.center?.lon ?? "";
    const vertical = classifyVertical(tags);

    const lead = {
      id: `${element.type || "node"}-${element.id || Math.random().toString(36).slice(2, 10)}`,
      businessName,
      vertical,
      website,
      phone,
      email,
      lat,
      lon,
      source: "overpass",
      score: 0
    };
    lead.score = leadScore(lead);
    leads.push(lead);
  }
  return dedupe(leads).sort((a, b) => b.score - a.score || a.businessName.localeCompare(b.businessName));
}

async function fetchLeadsFromOverpass() {
  const errors = [];
  for (const endpoint of overpassEndpoints) {
    try {
      const leads = await fetchLeadsFromEndpoint(endpoint);
      return { leads, endpoint };
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${errors.join(" | ")}`);
}

function buildMessage(lead) {
  const verticalLabel = lead.vertical.replaceAll("_", " ");
  const subject = `${lead.businessName}: 90% automated lead follow-up setup`;
  const body = [
    `Hi ${lead.businessName} team,`,
    "",
    `I run MYMSAF (MyMultiPlatform Set-and-Forget) for ${verticalLabel} businesses in San Diego.`,
    "We deploy a no-call, mostly automated pipeline for lead response, follow-up, and client reporting.",
    "",
    "If useful, I can send a short async audit and projected weekly lift with zero meetings.",
    `Direct checkout link: ${PAYMENT_URL}`,
    "Reply YES if you want a custom setup version first.",
    "",
    "Dante | MYMSAF"
  ].join("\n");
  return { subject, body };
}

function buildOutreachQueue(leads) {
  const topLeads = leads.filter((lead) => lead.website || lead.phone).slice(0, 120);
  return topLeads.map((lead) => {
    const { subject, body } = buildMessage(lead);
    return {
      leadId: lead.id,
      businessName: lead.businessName,
      vertical: lead.vertical,
      website: lead.website,
      phone: lead.phone,
      email: lead.email,
      subject,
      message: body,
      ctaUrl: PAYMENT_URL,
      status: "pending"
    };
  });
}

function mergeQueueData(newQueue, previousQueue) {
  const previousByLead = new Map(
    previousQueue
      .filter((item) => item && typeof item === "object")
      .map((item) => [String(item.leadId || ""), item])
  );

  return newQueue.map((item) => {
    const prev = previousByLead.get(String(item.leadId || ""));
    if (!prev) return item;
    return {
      ...item,
      status: prev.status || item.status,
      sentAtUtc: prev.sentAtUtc || item.sentAtUtc,
      lastError: prev.lastError || item.lastError
    };
  });
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

async function shouldRefresh() {
  try {
    const raw = await readFile(metaFile, "utf8");
    const meta = JSON.parse(raw);
    const last = Date.parse(meta.lastRefreshUtc);
    if (!Number.isFinite(last)) return true;
    const hoursAgo = (Date.now() - last) / (1000 * 60 * 60);
    return hoursAgo >= REFRESH_HOURS;
  } catch {
    return true;
  }
}

async function main() {
  await mkdir(liveDir, { recursive: true });
  const refresh = await shouldRefresh();
  if (!refresh) {
    console.log("Lead refresh not due yet");
    return;
  }

  const previousLeads = await readJson(leadsJsonFile, []);
  const previousQueue = await readJson(queueJsonFile, []);
  const { leads: fetchedLeads, endpoint } = await fetchLeadsFromOverpass();
  const leads = mergeExistingLeadData(fetchedLeads, previousLeads);
  const queue = mergeQueueData(buildOutreachQueue(leads), previousQueue);
  const leadsCsv = toCsv(leads, [
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
  ]);
  const queueCsv = toCsv(queue, [
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
  ]);

  const summary = {
    lastRefreshUtc: new Date().toISOString(),
    location: "San Diego, CA",
    radiusMeters: SEARCH_RADIUS_METERS,
    leadsCount: leads.length,
    queueCount: queue.length,
    source: "overpass",
    endpoint
  };

  await writeFile(leadsFile, leadsCsv, "utf8");
  await writeFile(queueFile, queueCsv, "utf8");
  await writeFile(leadsJsonFile, JSON.stringify(leads, null, 2) + "\n", "utf8");
  await writeFile(queueJsonFile, JSON.stringify(queue, null, 2) + "\n", "utf8");
  await writeFile(metaFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(`Wrote ${leads.length} leads and ${queue.length} outreach rows`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
