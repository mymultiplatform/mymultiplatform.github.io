const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("en-US");

const state = {
  inventory: [],
  summary: null,
  query: "",
  year: "all",
};

const summaryStatsEl = document.getElementById("summary-stats");
const featuredProjectEl = document.getElementById("featured-project");
const topProjectsEl = document.getElementById("top-projects");
const inventoryMetaEl = document.getElementById("inventory-meta");
const inventoryGridEl = document.getElementById("inventory-grid");
const yearFiltersEl = document.getElementById("year-filters");
const searchEl = document.getElementById("project-search");

function formatMoney(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Not verified";
  }
  return currencyFormatter.format(Math.round(value));
}

function formatCount(value) {
  return numberFormatter.format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSummaryStats(summary) {
  const stats = [
    ["Projects", formatCount(summary.total_projects)],
    ["Files", formatCount(summary.total_files)],
    ["PDFs", formatCount(summary.total_pdfs)],
    ["Spreadsheets", formatCount(summary.total_spreadsheets)],
    ["Drawings", formatCount(summary.total_drawings)],
    ["Images", formatCount(summary.total_images)],
  ];

  summaryStatsEl.innerHTML = stats
    .map(
      ([label, value]) => `
        <article class="stat-card">
          <span class="stat-label">${escapeHtml(label)}</span>
          <strong class="stat-value">${escapeHtml(value)}</strong>
        </article>
      `
    )
    .join("");
}

function renderFeatured(summary) {
  const featured = summary.featured_project;
  if (!featured) {
    featuredProjectEl.innerHTML = `
      <div class="empty-state">No verified pricing totals were found in the archive.</div>
    `;
    return;
  }

  featuredProjectEl.innerHTML = `
    <div class="featured-top">
      <div>
        <span class="project-kicker">${escapeHtml(String(featured.year))} archive highlight</span>
        <h2>${escapeHtml(featured.project)}</h2>
      </div>
      <div class="money">${escapeHtml(formatMoney(featured.value))}</div>
    </div>
    <p class="context-line">
      Highest verified amount found in the USB spreadsheets under
      <strong>${escapeHtml(featured.context)}</strong>.
    </p>
    <div class="evidence-row">
      <span class="chip">Workbook: ${escapeHtml(featured.source_file)}</span>
      <span class="chip">Sheet: ${escapeHtml(featured.sheet)}</span>
      <span class="chip">Cell: ${escapeHtml(featured.cell)}</span>
    </div>
  `;
}

function renderTopProjects(summary) {
  const projects = summary.top_verified_projects.slice(1, 7);
  if (!projects.length) {
    topProjectsEl.innerHTML = `
      <div class="empty-state">No additional verified totals were found beyond the featured project.</div>
    `;
    return;
  }
  topProjectsEl.innerHTML = projects
    .map(
      (project) => `
        <article class="top-card">
          <span class="project-kicker">${escapeHtml(String(project.year))}</span>
          <h3>${escapeHtml(project.project)}</h3>
          <strong class="top-money">${escapeHtml(formatMoney(project.value))}</strong>
          <p class="context-line">${escapeHtml(project.context)}</p>
          <div class="chip-row">
            <span class="chip">${escapeHtml(project.sheet)}</span>
            <span class="chip">${escapeHtml(project.cell)}</span>
          </div>
        </article>
      `
    )
    .join("");
}

function renderYearFilters(summary) {
  const buttons = [
    { value: "all", label: "All years" },
    ...summary.years.map((item) => ({
      value: String(item.year),
      label: `${item.year} (${item.project_count})`,
    })),
  ];

  yearFiltersEl.innerHTML = buttons
    .map(
      (button) => `
        <button
          type="button"
          class="filter-btn${button.value === state.year ? " active" : ""}"
          data-year="${escapeHtml(button.value)}"
        >
          ${escapeHtml(button.label)}
        </button>
      `
    )
    .join("");

  yearFiltersEl.querySelectorAll("[data-year]").forEach((button) => {
    button.addEventListener("click", () => {
      state.year = button.dataset.year || "all";
      renderInventory();
      renderYearFilters(summary);
    });
  });
}

function projectMatchesQuery(project, query) {
  if (!query) {
    return true;
  }

  const searchable = [
    project.project,
    String(project.year),
    String(project.file_count),
    String(project.pdf_count),
    String(project.spreadsheet_count),
    String(project.drawing_count),
    String(project.image_count),
    project.verified_total?.context || "",
    project.verified_total?.sheet || "",
    project.verified_total?.cell || "",
    project.sample_files.join(" "),
  ]
    .join(" ")
    .toLowerCase();

  return searchable.includes(query);
}

function filteredInventory() {
  const query = state.query.trim().toLowerCase();

  return state.inventory
    .filter((project) => (state.year === "all" ? true : String(project.year) === state.year))
    .filter((project) => projectMatchesQuery(project, query))
    .sort((a, b) => {
      const totalA = a.verified_total?.value || 0;
      const totalB = b.verified_total?.value || 0;
      if (totalA !== totalB) {
        return totalB - totalA;
      }
      if (a.file_count !== b.file_count) {
        return b.file_count - a.file_count;
      }
      return a.project.localeCompare(b.project);
    });
}

function signalChips(project) {
  const chips = [];
  if (project.signals.has_billing) chips.push("Billing");
  if (project.signals.has_plans) chips.push("Plans");
  if (project.signals.has_photos) chips.push("Photos");
  if (project.signals.has_contract_pricing) chips.push("Contract pricing");
  return chips
    .map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`)
    .join("");
}

function topExtensionSummary(project) {
  return project.top_extensions
    .map((item) => `${item.extension} ${formatCount(item.count)}`)
    .join(" · ");
}

function inventoryCard(project) {
  const verifiedBlock = project.verified_total
    ? `
      <div class="verified-block">
        <strong>${escapeHtml(formatMoney(project.verified_total.value))}</strong>
        <span>
          Verified from ${escapeHtml(project.verified_total.context)} on
          ${escapeHtml(project.verified_total.sheet)} ${escapeHtml(project.verified_total.cell)}.
        </span>
      </div>
    `
    : "";

  const detailList = project.sample_files.length
    ? `
      <details class="details">
        <summary>Show sample files</summary>
        <ul>${project.sample_files.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>
      </details>
    `
    : "";

  return `
    <article class="inventory-card">
      <div class="inventory-top">
        <div>
          <h3>${escapeHtml(project.project)}</h3>
        </div>
        <span class="year">${escapeHtml(String(project.year))}</span>
      </div>
      <div class="mini-stats">
        <div class="mini-stat">
          <strong>${escapeHtml(formatCount(project.file_count))}</strong>
          <span>files</span>
        </div>
        <div class="mini-stat">
          <strong>${escapeHtml(formatCount(project.pdf_count))}</strong>
          <span>PDFs</span>
        </div>
        <div class="mini-stat">
          <strong>${escapeHtml(formatCount(project.spreadsheet_count))}</strong>
          <span>spreadsheets</span>
        </div>
        <div class="mini-stat">
          <strong>${escapeHtml(formatCount(project.image_count))}</strong>
          <span>images</span>
        </div>
      </div>
      ${verifiedBlock}
      <div class="chip-row">${signalChips(project)}</div>
      <p class="context-line">${escapeHtml(topExtensionSummary(project))}</p>
      ${detailList}
    </article>
  `;
}

function renderInventory() {
  const projects = filteredInventory();
  inventoryMetaEl.textContent = `Showing ${formatCount(projects.length)} of ${formatCount(
    state.inventory.length
  )} archived projects.`;

  if (!projects.length) {
    inventoryGridEl.innerHTML = `
      <div class="empty-state">No projects matched the current search or year filter.</div>
    `;
    return;
  }

  inventoryGridEl.innerHTML = projects.map(inventoryCard).join("");
}

function bindSearch() {
  searchEl.addEventListener("input", (event) => {
    state.query = event.target.value || "";
    renderInventory();
  });
}

function renderError(message) {
  featuredProjectEl.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  topProjectsEl.innerHTML = "";
  inventoryGridEl.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  inventoryMetaEl.textContent = "Archive data could not be loaded.";
}

async function loadArchive() {
  try {
    const [summaryResponse, inventoryResponse] = await Promise.all([
      fetch("./portfolio_summary.json"),
      fetch("./portfolio_inventory.json"),
    ]);

    if (!summaryResponse.ok || !inventoryResponse.ok) {
      throw new Error("The archive data files are missing or unreadable.");
    }

    const [summary, inventory] = await Promise.all([
      summaryResponse.json(),
      inventoryResponse.json(),
    ]);

    state.summary = summary;
    state.inventory = inventory;

    renderSummaryStats(summary);
    renderFeatured(summary);
    renderTopProjects(summary);
    renderYearFilters(summary);
    renderInventory();
    bindSearch();
  } catch (error) {
    renderError(error.message || "The archive data could not be loaded.");
  }
}

loadArchive();
