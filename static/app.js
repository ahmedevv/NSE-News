const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hours = () => $("#hours").value;
let DASH = null;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const pct = (v) => (v == null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const effChip = (name, e, title = "") =>
  `<span class="chip ${e > 0 ? "pos" : e < 0 ? "neg" : ""}" title="${esc(title)}">${e > 0 ? "▲" : e < 0 ? "▼" : "◆"} ${esc(name)}</span>`;

function spark(vals, w = 80, h = 22) {
  if (!vals || vals.length < 2) return "";
  const min = Math.min(...vals), max = Math.max(...vals), rng = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / rng) * (h - 2) - 1}`).join(" ");
  const c = vals[vals.length - 1] >= vals[0] ? "var(--up)" : "var(--down)";
  return `<svg class="spark" width="${w}" height="${h}"><polyline fill="none" stroke="${c}" stroke-width="1.5" points="${pts}"/></svg>`;
}

/* ---------------------------------------------------------------- renderers */
function newsItem(n, compact = false) {
  const a = n.a;
  const sc = a.score >= 7 ? "down" : a.score >= 5 ? "" : "flat";
  const sectors = (a.sectors || []).filter((s) => s.sector !== "Broad Market").slice(0, compact ? 4 : 8)
    .map((s) => effChip(s.sector, s.effect, s.reason)).join("");
  const stocks = (a.stocks || []).slice(0, 8).map((s) => effChip(s.symbol, s.effect, s.reason)).join("");
  const events = (a.events || []).map((e) => e.name).join(" · ");
  return `<div class="news-item">
    <a class="t" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
    <div class="meta">
      <span class="score ${sc}" title="impact score 0-10">${a.score}</span>
      <span class="pill ${a.sentiment}">${esc(a.sentiment)}</span>
      <span>${esc(a.category)}</span>
      ${a.finbert ? `<span class="pill ai" title="FinBERT headline sentiment (used for company tone; macro direction comes from the rules)">FinBERT · ${esc(a.finbert.label)} ${Number(a.finbert.score).toFixed(2)}</span>` : ""}
      <span>${esc(n.source)}</span><span>${ago(n.published)}</span>
      ${a.horizon ? `<span>horizon: ${esc(a.horizon)}</span>` : ""}
    </div>
    ${compact ? "" : `<div class="exp">${esc(a.expected_impact)}</div>`}
    <div>${sectors}${stocks}</div>
    ${compact || !events ? "" : `<details><summary>Detected drivers: ${esc(events)}</summary>
      ${(a.events || []).map((e) => `<div class="exp"><b>${esc(e.name)}</b>${e.direction && e.direction !== "n/a" ? ` (${esc(e.direction)})` : ""}: ${esc(e.why)}</div>`).join("")}
    </details>`}
  </div>`;
}

function renderKpis(d) {
  const m = d.mood, nifty = m.nifty;
  const topSec = d.sectors.filter((s) => s.count);
  const best = [...topSec].sort((a, b) => b.net - a.net)[0];
  const worst = [...topSec].sort((a, b) => a.net - b.net)[0];
  const geo = (m.categories.Geopolitical || 0);
  $("#kpis").innerHTML = `
    <div class="card kpi"><div class="label">News mood (${hours()}h)</div>
      <div class="value ${cls(m.value)}">${m.value > 0 ? "+" : ""}${m.value}</div><div class="note">${esc(m.label)}</div></div>
    <div class="card kpi"><div class="label">NIFTY 50</div>
      <div class="value">${nifty ? nifty.price.toLocaleString("en-IN") : "–"}</div>
      <div class="note ${cls(nifty?.chg_1d)}">${nifty ? `${pct(nifty.chg_1d)} today · RV20 ${nifty.rv20}%` : "price feed unavailable"}</div></div>
    <div class="card kpi"><div class="label">Sector tailwind</div>
      <div class="value up" style="font-size:18px">${best && best.net > 0 ? esc(best.sector) : "–"}</div><div class="note">${best && best.net > 0 ? esc(best.top_reasons[0] || "") : "no strong positive driver"}</div></div>
    <div class="card kpi"><div class="label">Sector headwind</div>
      <div class="value down" style="font-size:18px">${worst && worst.net < 0 ? esc(worst.sector) : "–"}</div><div class="note">${worst && worst.net < 0 ? esc(worst.top_reasons[0] || "") : "no strong negative driver"}</div></div>
    <div class="card kpi"><div class="label">Geopolitical stories</div>
      <div class="value">${geo}</div><div class="note">${Object.entries(m.categories).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}</div></div>`;
}

function renderHeatmap(sectors) {
  const max = Math.max(1, ...sectors.map((s) => Math.abs(s.net)));
  $("#heatmap").innerHTML = sectors.map((s) => {
    const t = Math.min(1, Math.abs(s.net) / max);
    const col = s.net > 0 ? "47,191,113" : s.net < 0 ? "240,82,79" : "139,152,169";
    const idx = s.index_market;
    return `<div class="cell" style="background:rgba(${col},${0.08 + t * 0.45})" title="${esc(s.top_reasons.join("\n") || "no news")}">
      <div class="n">${esc(s.sector)}</div>
      <div class="v">${s.count ? `${s.count} stories · net ${s.net > 0 ? "+" : ""}${s.net}` : "quiet"}${idx ? ` · <span class="${cls(idx.chg_1d)}">${pct(idx.chg_1d)}</span>` : ""}</div>
    </div>`;
  }).join("");
}

function volRow(r, full) {
  const m = r.market;
  const bias = `<span class="pill ${r.bias}">${r.bias === "two-way" ? "two-way" : r.bias}</span>`;
  const hl = r.headlines.map((h) => `<div class="small"><a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.title)}</a></div>`).join("");
  return `<tr>
    <td><span class="sym">${esc(r.symbol)}</span><div class="muted small">${esc(r.sector)}</div></td>
    <td><div class="bar"><span style="width:${r.score}%"></span></div><div class="small muted">${r.score}</div></td>
    <td>${bias}${r.earnings ? `<div class="small" style="margin-top:4px">📅 results ${esc(r.earnings)}</div>` : ""}</td>
    ${full ? `<td class="num">${m ? m.price.toLocaleString("en-IN") : "–"}</td>
    <td class="num ${cls(m?.chg_1d)}">${pct(m?.chg_1d)}</td>
    <td class="num ${cls(m?.chg_5d)}">${pct(m?.chg_5d)}</td>
    <td class="num" title="20-day annualised realised volatility; regime = RV20/RV60">${m ? `${m.rv20}%` : "–"}${m?.vol_regime ? `<div class="small ${m.vol_regime > 1.2 ? "down" : "muted"}">×${m.vol_regime}</div>` : ""}</td>
    <td>${m ? spark(m.spark) : ""}</td>` : ""}
    <td>${r.direct_mentions ? `<span class="small muted">${r.direct_mentions} direct</span>` : `<span class="small muted">via sector</span>`}${full ? hl : ""}</td>
  </tr>`;
}

function renderVol(rows, el, full) {
  if (!rows.length) { el.innerHTML = `<div class="empty">No news-driven volatility yet. Waiting for the first refresh…</div>`; return; }
  const head = full
    ? "<tr><th>Asset</th><th>Vol. score</th><th>Bias</th><th>Price</th><th>1D</th><th>5D</th><th>RV20</th><th>30D</th><th>Why</th></tr>"
    : "<tr><th>Asset</th><th>Vol. score</th><th>Bias</th><th>Mentions</th></tr>";
  el.innerHTML = (el.tagName === "TABLE" ? "" : "<table>") + head + rows.map((r) => volRow(r, full)).join("") + (el.tagName === "TABLE" ? "" : "</table>");
}

function renderEarnings(rows, el, mini) {
  const tracked = mini || $("#trackedOnly").checked;
  let list = tracked ? rows.filter((r) => r.tracked) : rows;
  if (mini) list = list.filter((r) => r.days_away <= 7).slice(0, 10);
  if (!list.length) { el.innerHTML = `<div class="empty">No results scheduled${tracked ? " for tracked stocks" : ""}. Check the Sources tab — exchange calendars sometimes block automated requests.</div>`; return; }
  const html = `<tr><th>Date</th><th>Symbol</th><th>Company</th><th>Sector</th>${mini ? "" : "<th>1D</th><th>RV20</th><th>Source</th>"}</tr>` +
    list.map((r) => `<tr>
      <td>${esc(r.date)}<div class="small muted">${r.days_away === 0 ? "today" : r.days_away === 1 ? "tomorrow" : `in ${r.days_away}d`}</div></td>
      <td class="sym">${esc(r.symbol)}</td><td>${esc(r.company)}</td><td class="small">${esc(r.sector)}</td>
      ${mini ? "" : `<td class="num ${cls(r.market?.chg_1d)}">${pct(r.market?.chg_1d)}</td><td class="num">${r.market ? r.market.rv20 + "%" : "–"}</td><td class="small muted">${esc(r.source)}</td>`}
    </tr>`).join("");
  el.innerHTML = el.tagName === "TABLE" ? html : `<table>${html}</table>`;
}

function renderSectors(rows) {
  $("#secTable").innerHTML = "<tr><th>Sector</th><th>Outlook</th><th>Net pressure</th><th>Stories</th><th>Index 1D</th><th>Key drivers</th></tr>" +
    rows.map((s) => `<tr>
      <td class="sym">${esc(s.sector)}</td>
      <td><span class="pill ${s.outlook}">${s.outlook}</span></td>
      <td class="num ${cls(s.net)}">${s.net > 0 ? "+" : ""}${s.net}</td>
      <td class="num">${s.count}</td>
      <td class="num ${cls(s.index_market?.chg_1d)}">${s.index ? pct(s.index_market?.chg_1d) : "–"}</td>
      <td class="small">${s.top_reasons.map(esc).join("<br>") || '<span class="muted">quiet</span>'}</td>
    </tr>`).join("");
}

function renderSources(rows) {
  $("#srcTable").innerHTML = "<tr><th>Source</th><th>Status</th><th>Items</th><th>Checked</th><th>Error</th></tr>" +
    rows.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.ok ? '<span class="up">● OK</span>' : '<span class="down">● failing</span>'}</td>
      <td class="num">${s.count}</td><td class="small">${ago(s.checked_at)}</td><td class="small muted">${esc(s.error)}</td></tr>`).join("");
}

/* ---------------------------------------------------------------- loaders */
async function loadDashboard() {
  const d = await api(`/api/dashboard?hours=${hours()}`);
  DASH = d;
  const okSrc = d.sources.filter((s) => s.ok).length;
  $("#status").innerHTML = `${d.refreshing ? "⟳ refreshing… · " : ""}updated ${ago(d.last_refresh)} · ${okSrc}/${d.sources.length} sources OK${d.finbert_enabled ? ' · <span class="pill ai">FinBERT on</span>' : ""}`;
  renderKpis(d);
  renderHeatmap(d.sectors);
  renderVol(d.volatility.slice(0, 10), $("#volMini"), false);
  $("#topNews").innerHTML = d.top_news.length ? d.top_news.slice(0, 8).map((n) => newsItem(n, true)).join("") : `<div class="empty">No high-impact news yet.</div>`;
  renderEarnings(d.earnings, $("#earnMini"), true);
  renderVol(d.volatility, $("#volTable"), true);
  renderSectors(d.sectors);
  renderEarnings(d.earnings, $("#earnTable"), false);
  $("#reported").innerHTML = d.reported.length ? d.reported.map((r) =>
    `<div class="news-item"><span class="sym">${esc(r.symbol)}</span> ${effChip(r.effect > 0 ? "positive" : r.effect < 0 ? "negative" : "watch", r.effect)}
     <div><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a></div><div class="small muted">${ago(r.published)}</div></div>`).join("")
    : `<div class="empty">No results coverage in the last 48h.</div>`;
  renderSources(d.sources);
  if (d.refreshing) setTimeout(loadDashboard, 8000);
}

let newsTimer;
async function loadNews() {
  const p = new URLSearchParams({ hours: hours(), min_impact: $("#minImpact").value, category: $("#cat").value, q: $("#q").value, kind: $("#kind").value });
  const rows = await api(`/api/news?${p}`);
  $("#newsList").innerHTML = rows.length ? rows.map((n) => newsItem(n)).join("") : `<div class="empty">No articles match.</div>`;
}
const debounceNews = () => { clearTimeout(newsTimer); newsTimer = setTimeout(loadNews, 250); };

/* ---------------------------------------------------------------- wiring */
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "news") loadNews();
  try { localStorage.setItem("tab", name); } catch {}
}
$("#tabs").addEventListener("click", (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); showTab(a.dataset.goto); }));
$("#hours").addEventListener("change", () => { loadDashboard(); if ($("#tab-news").classList.contains("active")) loadNews(); });
["#q", "#cat", "#kind"].forEach((s) => $(s).addEventListener("input", debounceNews));
$("#minImpact").addEventListener("input", () => { $("#minImpactV").textContent = $("#minImpact").value; debounceNews(); });
$("#trackedOnly").addEventListener("change", () => DASH && renderEarnings(DASH.earnings, $("#earnTable"), false));
$("#refreshBtn").addEventListener("click", async () => {
  $("#refreshBtn").disabled = true;
  await api("/api/refresh", { method: "POST" });
  setTimeout(async () => { await loadDashboard(); $("#refreshBtn").disabled = false; }, 3000);
});
$("#tryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = $("#tryText").value.trim();
  if (!t) return;
  const a = await api(`/api/analyze?text=${encodeURIComponent(t)}`);
  $("#tryOut").innerHTML = newsItem({ title: t, link: "#", source: "you", published: new Date().toISOString(), a: { ...a, engine: "rules" } });
});

try { const t = localStorage.getItem("tab"); if (t) showTab(t); } catch {}
loadDashboard().catch((e) => ($("#status").textContent = "Failed to load: " + e.message));
setInterval(() => loadDashboard().catch(() => {}), 5 * 60 * 1000);
