"use strict";
/* NSE Wire front end. No framework, no build step.
   Timers: clock every 1s, alerts every 15s, wire every 30s, dashboard every 60s. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  dash: null, wire: [], seen: new Set(), firstWire: true,
  alerts: [], lastAlertId: 0, unseen: 0,
  view: "monitor", wireFilter: "all", selected: null,
  muted: false, watch: [], known: [],
};
try { S.muted = localStorage.getItem("muted") === "1"; } catch {}

/* ------------------------------------------------------------------ formatting */
const IST_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const IST_FULL = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const IST_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const istTime = (iso) => IST_FMT.format(new Date(iso));
function istStamp(iso) {
  const d = new Date(iso), today = IST_DAY.format(new Date());
  const day = IST_DAY.format(d);
  return day === today ? istTime(iso) : `${day} ${istTime(iso)}`;
}
const num = (v, d = 2) => v == null ? "–" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v) => v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;
const dirCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
}
function sev(score) { return score >= 8 ? "critical" : score >= 7 ? "high" : score >= 5 ? "med" : "low"; }
const LEVEL_NAME = { critical: "Critical", high: "High", move: "Move", vix: "Volatility", watch: "Watchlist", test: "Test" };
function arrows(e) {
  if (e >= 2) return "▲▲"; if (e === 1) return "▲"; if (e <= -2) return "▼▼"; if (e === -1) return "▼"; return "±";
}
const fx = (name, e, title = "") =>
  `<span class="fx ${e > 0 ? "pos" : e < 0 ? "neg" : "unk"}" title="${esc(title)}">${esc(name)} ${arrows(e)}</span>`;
function spark(vals, w = 72, h = 20) {
  if (!vals || vals.length < 2) return "";
  const min = Math.min(...vals), max = Math.max(...vals), r = max - min || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - min) / r) * (h - 2) - 1).toFixed(1)}`).join(" ");
  const c = vals[vals.length - 1] >= vals[0] ? "var(--up)" : "var(--down)";
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="${c}" stroke-width="1.4" points="${pts}"/></svg>`;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} on ${path}`);
  return r.json();
}

/* ------------------------------------------------------------------ session clock */
function istParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: Number(p.hour) * 60 + Number(p.minute) };
}
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
function tickClock() {
  const now = new Date();
  $("#sessionClock").textContent = `${IST_FULL.format(now)} IST`;
  const { wd, min } = istParts(now);
  const weekday = !["Sat", "Sun"].includes(wd);
  const OPEN = 555, CLOSE = 930, PRE = 540; // 09:15, 15:30, 09:00
  let state = "Closed", cls = "closed", next = "";
  if (weekday && min >= PRE && min < OPEN) { state = "Pre-open"; cls = "pre"; next = `Opens in ${dur(OPEN - min)}`; }
  else if (weekday && min >= OPEN && min < CLOSE) { state = "Market open"; cls = "open"; next = `Closes in ${dur(CLOSE - min)}`; }
  else {
    let days = 0, w = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
    if (!(weekday && min < PRE)) { do { days++; w = (w + 1) % 7; } while (w === 0 || w === 6); }
    const mins = days * 1440 + OPEN - min;
    next = days === 0 ? `Opens in ${dur(mins)}` : days === 1 ? "Opens tomorrow 09:15" : `Opens ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][w]} 09:15`;
  }
  const st = $("#sessionState"); st.textContent = state; st.className = `session-state ${cls}`;
  $("#sessionNext").textContent = next;
  tickFeed();
}

function tickFeed() {
  const d = S.dash; if (!d) return;
  const el = $("#feed"), age = (Date.now() - new Date(d.last_refresh || 0)) / 60000;
  const every = d.refresh_minutes || 5;
  el.className = "feed " + (d.refreshing ? "live" : age < every * 2 + 1 ? "live" : age < 30 ? "late" : "dead");
  const nextIn = Math.max(0, Math.ceil(every - age));
  $("#feedText").textContent = d.refreshing ? "Checking sources now"
    : !d.last_refresh ? "Waiting for first update"
    : age < every * 2 + 1 ? `Live, updated ${ago(d.last_refresh)}${nextIn ? `, next in ${nextIn} min` : ""}`
    : `Updates delayed, last ${ago(d.last_refresh)}`;
}

/* ------------------------------------------------------------------ top bar + strip */
const INVERT = new Set(["^INDIAVIX", "USDINR=X", "BZ=F"]); // rising = bad for Indian equities
function renderQuotes(macro) {
  $("#quotes").innerHTML = macro.map((m) => {
    const ch = m.chg_1d, eff = INVERT.has(m.symbol) ? -ch : ch;
    const dec = m.symbol === "USDINR=X" ? 3 : m.symbol === "^INDIAVIX" ? 2 : m.price > 1000 ? 1 : 2;
    const tip = INVERT.has(m.symbol) ? "Coloured by effect on Indian equities: a rise is negative" : "";
    return `<div class="q" title="${esc(tip)}${m.asof ? ` Last bar ${esc(m.asof)}` : ""}">
      <span class="q-name">${esc(m.name)}</span>
      <span class="q-row"><span class="q-px">${m.price != null ? num(m.price, dec) : "–"}</span>
      <span class="q-ch ${ch == null ? "flat" : dirCls(eff)}">${ch == null ? "" : `${ch > 0 ? "▲" : ch < 0 ? "▼" : ""} ${pct(ch)}`}</span></span>
    </div>`;
  }).join("");
}
function renderStrip(sectors) {
  const withIdx = sectors.filter((s) => s.index_market).sort((a, b) => (b.index_market.chg_1d ?? 0) - (a.index_market.chg_1d ?? 0));
  $("#strip").innerHTML = withIdx.length
    ? withIdx.map((s) => `<span>${esc(s.sector)}<b class="${dirCls(s.index_market.chg_1d)}">${pct(s.index_market.chg_1d)}</b></span>`).join("")
    : `<span>Sector index prices are not available yet</span>`;
}

/* ------------------------------------------------------------------ news wire */
function wireRow(n, i) {
  const a = n.a, lv = sev(a.score);
  const sectors = (a.sectors || []).filter((s) => s.sector !== "Broad Market" && s.effect).slice(0, 4).map((s) => fx(s.sector, s.effect, s.reason));
  const stocks = (a.stocks || []).slice(0, 4).map((s) => fx(s.symbol, s.effect, s.reason));
  const lean = a.sentiment === "bullish" ? "Bullish" : a.sentiment === "bearish" ? "Bearish" : "";
  const isNew = !S.firstWire && !S.seen.has(n.id);
  return `<li class="row sev-${lv}${isNew ? " new" : ""}${S.selected === n.id ? " sel" : ""}" data-id="${esc(n.id)}" data-i="${i}" tabindex="0">
    <time datetime="${esc(n.published)}">${istTime(n.published)}</time>
    <div>
      <div class="hl">${esc(n.title)}</div>
      <div class="meta">
        <span class="score" title="Impact on Indian equities, 0 to 10">${a.score.toFixed(1)}</span>
        ${lean ? `<span class="lean ${a.sentiment}">${lean}</span>` : ""}
        ${[...stocks, ...sectors].join("")}
        <span>${esc(n.source)}</span>
      </div>
    </div>
  </li>`;
}
function wireEmpty(text) { return `<li class="empty">${text}</li>`; }

async function loadWire() {
  const f = S.wireFilter;
  const p = new URLSearchParams({ hours: 24, sort: "time", limit: 200,
    min_impact: f === "high" ? 7 : 2, kind: f === "india" ? "market" : f === "global" ? "geo" : "",
    watchlist: f === "watch" ? "true" : "false", q: $("#wireSearch").value.trim() });
  const rows = await api(`/api/news?${p}`);
  S.wire = rows;
  const el = $("#wire");
  if (!rows.length) {
    el.innerHTML = wireEmpty(f === "watch" && !S.watch.length
      ? "Your watchlist is empty. <b>Add symbols in Alerts and watchlist</b> to see their news here."
      : f === "high" ? "No high-impact stories in the last 24 hours." : "No stories match. Clear the search or pick another filter.");
  } else {
    el.innerHTML = rows.map(wireRow).join("");
  }
  rows.forEach((n) => S.seen.add(n.id));
  if (S.firstWire) { const m = location.hash.match(/^#story=(.+)$/); if (m) openDrawer(findStory(decodeURIComponent(m[1]))); }
  S.firstWire = false;
}

async function loadNews() {
  const p = new URLSearchParams({ hours: $("#newsHours").value, sort: $("#newsSort").value, limit: 400,
    min_impact: $("#newsMin").value, category: $("#newsCat").value, kind: $("#newsKind").value, q: $("#newsSearch").value.trim() });
  const rows = await api(`/api/news?${p}`);
  S.newsRows = rows;
  $("#newsList").innerHTML = rows.length ? rows.map(wireRow).join("") : wireEmpty("No stories match these filters.");
}

/* ------------------------------------------------------------------ detail drawer */
function findStory(id) {
  if (id === "try") return S.tryRow;
  return S.wire.find((n) => n.id === id) || (S.newsRows || []).find((n) => n.id === id)
    || (S.dash?.top_news || []).find((n) => n.id === id) || (S.reportedRows || []).find((n) => n.id === id);
}
function openDrawer(n) {
  if (!n) return;
  S.selected = n.id;
  $$(".row.sel").forEach((r) => r.classList.remove("sel"));
  $$(`.row[data-id="${CSS.escape(n.id)}"]`).forEach((r) => r.classList.add("sel"));
  const a = n.a, mk = Object.fromEntries((S.dash?.volatility || []).filter((r) => r.market).map((r) => [r.symbol, r.market]));
  const lean = a.sentiment === "bullish" ? "Bullish" : a.sentiment === "bearish" ? "Bearish" : "Mixed";
  const sectors = (a.sectors || []).filter((s) => s.sector !== "Broad Market");
  const broad = (a.sectors || []).find((s) => s.sector === "Broad Market");
  const secIdx = Object.fromEntries((S.dash?.sectors || []).map((s) => [s.sector, s.index_market]));
  $("#drawerBody").innerHTML = `
    <div class="d-src">${esc(n.source)}, ${istStamp(n.published)} IST</div>
    <div class="d-title">${esc(n.title)}</div>
    ${n.link && n.link !== "#" ? `<a href="${esc(n.link)}" target="_blank" rel="noopener">Open the original story</a>` : ""}
    <div class="d-stats">
      <div><span>Impact</span><b style="${a.score >= 8 ? "color:var(--amber)" : ""}">${a.score.toFixed(1)} / 10</b></div>
      <div><span>Lean for India</span><b class="${a.sentiment === "bullish" ? "up" : a.sentiment === "bearish" ? "down" : ""}">${lean}</b></div>
      <div><span>Horizon</span><b>${esc((a.horizon || "").replace("-to-", " to "))}</b></div>
      <div><span>Category</span><b>${esc(a.category)}</b></div>
    </div>
    <h3>What to expect</h3>
    <p>${esc(a.expected_impact)}</p>
    ${broad && broad.effect ? `<p>Overall market: <span class="${broad.effect > 0 ? "up" : "down"}">${broad.effect > 0 ? "supportive" : "negative"}</span>.</p>` : ""}
    ${(a.events || []).length ? `<h3>Why</h3>${a.events.map((e) => `<div class="driver"><b>${esc(e.name)}</b>${e.direction && !["n/a", "unclear"].includes(e.direction) ? `, ${esc(e.direction)}` : ""}<p>${esc(e.why)}</p></div>`).join("")}` : ""}
    ${sectors.length ? `<h3>Sectors</h3><table class="tbl"><tr><th>Sector</th><th>Effect</th><th class="r">Index today</th></tr>
      ${sectors.map((s) => `<tr><td>${esc(s.sector)}<span class="sub">${esc(s.reason || "")}</span></td>
        <td>${fx(s.effect > 0 ? "Positive" : s.effect < 0 ? "Negative" : "Exposed", s.effect)}</td>
        <td class="r ${dirCls(secIdx[s.sector]?.chg_1d)}">${secIdx[s.sector] ? pct(secIdx[s.sector].chg_1d) : "–"}</td></tr>`).join("")}</table>` : ""}
    ${(a.stocks || []).length ? `<h3>Stocks named</h3><table class="tbl"><tr><th>Symbol</th><th>Effect</th><th class="r">Price</th><th class="r">Today</th><th></th></tr>
      ${a.stocks.map((s) => { const m = mk[s.symbol]; return `<tr><td class="sym">${esc(s.symbol)}<span class="sub">${esc(s.sector || "")}</span></td>
        <td>${fx(s.effect > 0 ? "Positive" : s.effect < 0 ? "Negative" : "Watch", s.effect, s.reason)}<span class="sub">${esc(s.reason || "")}</span></td>
        <td class="r">${m ? num(m.price) : "–"}</td><td class="r ${dirCls(m?.chg_1d)}">${m ? pct(m.chg_1d) : "–"}</td>
        <td class="r">${S.watch.includes(s.symbol) ? `<span class="sub">On watchlist</span>` : `<button class="add-watch" data-add="${esc(s.symbol)}">Watch</button>`}</td></tr>`; }).join("")}</table>` : ""}
    ${a.finbert ? `<h3>FinBERT reading</h3><p>The headline reads ${esc(a.finbert.label)} with ${(a.finbert.score * 100).toFixed(0)}% confidence. Used for company tone only.</p>` : ""}
  `;
  history.replaceState(null, "", `#story=${encodeURIComponent(n.id)}`);
  $("#drawer").hidden = false;
  $("#drawerClose").focus({ preventScroll: true });
}
function closeDrawer() {
  $("#drawer").hidden = true; S.selected = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
  $$(".row.sel").forEach((r) => r.classList.remove("sel"));
}

/* ------------------------------------------------------------------ side panes */
function renderVolMini(rows) {
  const el = $("#volMini");
  if (!rows.length) { el.innerHTML = `<tr><td class="empty">Nothing yet. The list fills as news arrives.</td></tr>`; return; }
  el.innerHTML = `<tr><th>Stock</th><th>News pressure</th><th>Lean</th><th class="r">Price</th><th class="r">Today</th></tr>` +
    rows.slice(0, 12).map((r) => `<tr>
      <td class="sym">${esc(r.symbol)}<span class="sub">${esc(r.sector)}</span></td>
      <td><span class="meter"><i style="width:${r.score}%"></i></span>${r.score}</td>
      <td class="${r.bias === "bullish" ? "up" : r.bias === "bearish" ? "down" : "flat"}">${r.bias === "two-way" ? "Two-way" : r.bias === "bullish" ? "Bullish" : "Bearish"}${r.earnings ? `<span class="sub">Results ${esc(r.earnings.slice(5))}</span>` : ""}</td>
      <td class="r">${r.market ? num(r.market.price) : "–"}</td>
      <td class="r ${dirCls(r.market?.chg_1d)}">${r.market ? pct(r.market.chg_1d) : "–"}</td></tr>`).join("");
}
function renderVolTable(rows) {
  const el = $("#volTable");
  if (!rows.length) { el.innerHTML = `<tr><td class="empty">Nothing yet. The list fills as news arrives.</td></tr>`; return; }
  el.innerHTML = `<tr><th>Stock</th><th>News pressure</th><th>Lean</th><th class="r">Price</th><th class="r">Today</th><th class="r">5 days</th>
    <th class="r" title="20-day annualised realised volatility. The second figure compares it with the 60-day level; above 1.2 means volatility is expanding.">Realised vol</th><th>30 days</th><th>Results</th><th>Main story</th></tr>` +
    rows.map((r) => { const m = r.market, h = r.headlines[0]; return `<tr>
      <td class="sym">${esc(r.symbol)}<span class="sub">${esc(r.sector)}</span></td>
      <td><span class="meter"><i style="width:${r.score}%"></i></span>${r.score}<span class="sub">${r.direct_mentions ? `${r.direct_mentions} direct stories` : "Through its sector"}</span></td>
      <td class="${r.bias === "bullish" ? "up" : r.bias === "bearish" ? "down" : "flat"}">${r.bias === "two-way" ? "Two-way" : r.bias === "bullish" ? "Bullish" : "Bearish"}</td>
      <td class="r">${m ? num(m.price) : "–"}</td>
      <td class="r ${dirCls(m?.chg_1d)}">${m ? pct(m.chg_1d) : "–"}</td>
      <td class="r ${dirCls(m?.chg_5d)}">${m ? pct(m.chg_5d) : "–"}</td>
      <td class="r">${m ? `${m.rv20}%` : "–"}${m?.vol_regime ? `<span class="sub ${m.vol_regime > 1.2 ? "down" : ""}">${m.vol_regime}x</span>` : ""}</td>
      <td>${m ? spark(m.spark) : ""}</td>
      <td>${r.earnings ? esc(r.earnings) : ""}</td>
      <td class="hl-cell">${h ? `<a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.title)}</a>` : ""}</td></tr>`; }).join("");
}
function divBar(net, max) {
  const w = Math.min(50, (Math.abs(net) / (max || 1)) * 50);
  return `<span class="div"><i class="${net >= 0 ? "pos" : "neg"}" style="width:${w}%"></i></span>`;
}
function renderSecMini(rows) {
  const active = rows.filter((s) => s.count && s.sector !== "Broad Market").sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 12);
  const max = Math.max(1, ...active.map((s) => Math.abs(s.net)));
  $("#secMini").innerHTML = active.length ? active.map((s) => `<li class="sec" title="${esc(s.top_reasons.join("\n"))}">
      <span>${esc(s.sector)}</span>${divBar(s.net, max)}
      <span class="r ${dirCls(s.index_market?.chg_1d)}">${s.index_market ? pct(s.index_market.chg_1d) : ""}</span></li>`).join("")
    : `<li class="empty">No sector-moving news yet.</li>`;
}
function renderSecTable(rows) {
  const max = Math.max(1, ...rows.map((s) => Math.abs(s.net)));
  $("#secTable").innerHTML = `<tr><th>Sector</th><th>Net news pressure</th><th class="r">Score</th><th class="r">Stories</th><th class="r">Index today</th><th>Main drivers</th></tr>` +
    rows.map((s) => `<tr><td class="sym">${esc(s.sector)}</td><td style="min-width:160px">${divBar(s.net, max)}</td>
      <td class="r ${dirCls(s.net)}">${s.net > 0 ? "+" : ""}${s.net}</td><td class="r">${s.count}</td>
      <td class="r ${dirCls(s.index_market?.chg_1d)}">${s.index ? (s.index_market ? pct(s.index_market.chg_1d) : "–") : ""}</td>
      <td class="hl-cell">${s.top_reasons.map(esc).join("<br>") || "Quiet"}</td></tr>`).join("");
}
function dayLabel(r) { return r.days_away === 0 ? "Today" : r.days_away === 1 ? "Tomorrow" : new Date(r.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
function renderEarnings(rows) {
  const week = rows.filter((r) => r.tracked && r.days_away <= 7).slice(0, 12);
  $("#earnMini").innerHTML = week.length ? week.map((r) => `<div class="e-row"><span class="d ${r.days_away <= 1 ? "soon" : ""}">${dayLabel(r)}</span>
      <span><b class="sym">${esc(r.symbol)}</b> <span class="sub" style="display:inline">${esc(r.sector)}</span></span>
      <span class="${dirCls(r.market?.chg_1d)}">${r.market ? pct(r.market.chg_1d) : ""}</span></div>`).join("")
    : `<div class="empty">No large-cap results in the next 7 days, or the exchange calendars are blocked. Check System.</div>`;
  const tracked = $("#trackedOnly").checked, list = tracked ? rows.filter((r) => r.tracked) : rows;
  $("#earnTable").innerHTML = list.length ? `<tr><th>Date</th><th>Symbol</th><th>Company</th><th>Sector</th><th class="r">Today</th><th class="r">Realised vol</th></tr>` +
    list.map((r) => `<tr><td>${dayLabel(r)}<span class="sub">${esc(r.date)}</span></td><td class="sym">${esc(r.symbol)}</td>
      <td>${esc(r.company)}</td><td>${esc(r.sector)}</td><td class="r ${dirCls(r.market?.chg_1d)}">${r.market ? pct(r.market.chg_1d) : "–"}</td>
      <td class="r">${r.market ? r.market.rv20 + "%" : "–"}</td></tr>`).join("")
    : `<tr><td class="empty">No results scheduled${tracked ? " for large caps" : ""}. If the NSE and BSE sources show as failing in System, add dates to data\\earnings_manual.csv.</td></tr>`;
}
function renderReported(rows) {
  S.reportedRows = rows.map((r) => ({ id: "rep-" + r.symbol, title: r.title, link: r.link, source: "", published: r.published,
    a: { score: 5, sentiment: r.effect > 0 ? "bullish" : r.effect < 0 ? "bearish" : "mixed", stocks: [{ symbol: r.symbol, effect: r.effect, sector: r.sector }], sectors: [], events: [], category: "Corporate", expected_impact: "Company results in the news." } }));
  $("#reported").innerHTML = rows.length ? rows.map((r) => `<li class="row sev-med" style="cursor:default">
    <time>${istTime(r.published)}</time><div><div class="hl"><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a></div>
    <div class="meta">${fx(r.symbol, r.effect)}<span>${esc(r.sector)}</span></div></div></li>`).join("")
    : wireEmpty("No results coverage in the last 48 hours.");
}
function renderSources(rows) {
  $("#srcTable").innerHTML = `<tr><th>Source</th><th>Status</th><th class="r">Items</th><th>Checked</th><th>Problem</th></tr>` +
    rows.map((s) => `<tr><td>${esc(s.name)}</td><td class="${s.ok ? "up" : "down"}">${s.ok ? "Working" : "Failing"}</td>
      <td class="r">${s.count}</td><td>${ago(s.checked_at)}</td><td class="hl-cell">${esc(s.error)}</td></tr>`).join("");
}

/* ------------------------------------------------------------------ alerts */
function alertItem(al, fresh = false) {
  return `<li class="al${fresh ? " fresh" : ""}">
    <span class="when">${istStamp(al.ts)}</span>
    <div><span class="lvl ${esc(al.level)}">${LEVEL_NAME[al.level] || esc(al.level)}</span>
      <div class="t">${al.link ? `<a href="${esc(al.link)}" target="_blank" rel="noopener">${esc(al.title)}</a>` : esc(al.title)}</div></div>
    ${al.body ? `<div class="b">${esc(al.body)}</div>` : ""}
  </li>`;
}
function renderAlerts(freshIds = new Set()) {
  const items = S.alerts;
  $("#alertsMini").innerHTML = items.length ? items.slice(0, 15).map((a) => alertItem(a, freshIds.has(a.id))).join("")
    : `<li class="empty">No alerts yet. Alerts appear here for high-impact stories, big price moves and watchlist news.</li>`;
  $("#alertLog").innerHTML = items.length ? items.map((a) => alertItem(a, freshIds.has(a.id))).join("")
    : `<li class="empty">No alerts yet. Use <b>Send test alert</b> to check sound, notifications and Telegram.</li>`;
}
function setUnseen(n) {
  S.unseen = n;
  const c = $("#alertCount"); c.hidden = !n; c.textContent = n;
  document.title = n ? `(${n}) NSE Wire` : "NSE Wire";
}
async function pollAlerts(initial = false) {
  const rows = await api(`/api/alerts?since=${S.lastAlertId}&limit=100`);
  if (!rows.length) return;
  S.lastAlertId = Math.max(S.lastAlertId, ...rows.map((r) => r.id));
  S.alerts = [...rows, ...S.alerts].slice(0, 200);
  if (initial) { renderAlerts(); return; }
  renderAlerts(new Set(rows.map((r) => r.id)));
  if (S.view !== "alerts") setUnseen(S.unseen + rows.length);
  const top = rows.slice().sort((a, b) => rank(b.level) - rank(a.level))[0];
  if (top.level === "critical" || top.level === "vix") showBanner(top);
  rows.slice(0, 3).forEach(toast);
  beep(top.level);
  rows.slice(0, 3).forEach(notify);
  loadWire().catch(() => {});
}
const rank = (l) => ({ critical: 4, vix: 3, high: 2, move: 2, watch: 1 }[l] || 0);
function showBanner(al) {
  $("#bannerLevel").textContent = LEVEL_NAME[al.level] || al.level;
  $("#bannerTime").textContent = istTime(al.ts) + " IST";
  $("#bannerTitle").textContent = al.title;
  $("#bannerBody").textContent = al.body || "";
  const b = $("#banner"); b.hidden = false; b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash");
}
function toast(al) {
  const t = document.createElement("div");
  t.className = `toast ${al.level}`;
  t.innerHTML = `<span class="lvl ${esc(al.level)}">${LEVEL_NAME[al.level] || esc(al.level)}</span><div class="t">${esc(al.title)}</div>`;
  t.onclick = () => { t.remove(); showView("alerts"); };
  $("#toasts").prepend(t);
  setTimeout(() => t.remove(), 12000);
}
let audioCtx;
function beep(level) {
  if (S.muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = level === "critical" || level === "vix" ? [880, 660, 880] : level === "watch" ? [520] : [740, 990];
    tones.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime + i * 0.16;
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.15);
    });
  } catch {}
}
function notify(al) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(`${LEVEL_NAME[al.level] || al.level}: ${al.title}`, { body: al.body || "", tag: "nsewire-" + al.id });
    n.onclick = () => { window.focus(); showView("alerts"); n.close(); };
  } catch {}
}
function renderChannels() {
  const d = S.dash || {};
  const perm = !("Notification" in window) ? "Not supported by this browser"
    : !window.isSecureContext ? "Unavailable on this address" : Notification.permission === "granted" ? "On" : Notification.permission === "denied" ? "Blocked in browser settings" : "Off";
  $("#alertChannels").innerHTML = `
    <dt>This page</dt><dd>On while the page is open: banner, pop-up and sound${S.muted ? " (sound is muted)" : ""}.</dd>
    <dt>Desktop</dt><dd>${perm}</dd>
    <dt>Telegram</dt><dd>${d.telegram_enabled ? "On" : "Off. Add a bot token and chat ID in settings.bat to get alerts on your phone."}</dd>`;
  const btn = $("#notifyBtn"), note = $("#notifyNote");
  btn.hidden = perm === "On" || perm.startsWith("Not");
  note.textContent = !window.isSecureContext
    ? "Browsers only allow desktop notifications on https or localhost addresses. Open the dashboard at http://localhost:8000 on the server, or use Telegram."
    : "";
}

/* ------------------------------------------------------------------ watchlist */
function renderWatch() {
  const mk = Object.fromEntries((S.dash?.volatility || []).filter((r) => r.market).map((r) => [r.symbol, r.market]));
  $("#watchList").innerHTML = S.watch.length ? S.watch.map((s) => { const m = mk[s]; return `<li>${esc(s)}
      ${m ? `<span class="px ${dirCls(m.chg_1d)}">${pct(m.chg_1d)}</span>` : ""}
      <button data-remove="${esc(s)}" aria-label="Remove ${esc(s)}">×</button></li>`; }).join("")
    : `<li class="empty" style="background:none;border:0;padding:4px 0;font-weight:400">No stocks yet.</li>`;
}
async function saveWatch(list) {
  const r = await api("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: list }) });
  S.watch = r.symbols; renderWatch();
  if (S.selected) openDrawer(findStory(S.selected));
}

/* ------------------------------------------------------------------ dashboard */
async function loadDashboard() {
  const d = await api("/api/dashboard?hours=24");
  S.dash = d; S.watch = d.watchlist || [];
  renderQuotes(d.macro || []);
  renderStrip(d.sectors);
  renderVolMini(d.volatility);
  renderVolTable(d.volatility);
  renderSecMini(d.sectors);
  renderSecTable(d.sectors);
  renderEarnings(d.earnings);
  renderReported(d.reported);
  renderSources(d.sources);
  renderWatch();
  renderChannels();
  tickFeed();
}

/* ------------------------------------------------------------------ views + wiring */
function showView(v) {
  S.view = v;
  $$("#views button[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("on", s.id === `v-${v}`));
  if (v === "news") loadNews().catch(() => {});
  if (v === "alerts") setUnseen(0);
  try { localStorage.setItem("view", v); } catch {}
}
$("#views").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) showView(b.dataset.view); });
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]"); if (go) { showView(go.dataset.goto); return; }
  const add = e.target.closest("[data-add]"); if (add) { saveWatch([...S.watch, add.dataset.add]); return; }
  const rm = e.target.closest("[data-remove]"); if (rm) { saveWatch(S.watch.filter((s) => s !== rm.dataset.remove)); return; }
  const row = e.target.closest(".row[data-id]");
  if (row && !e.target.closest("a")) openDrawer(findStory(row.dataset.id));
});
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (e.key === "Escape") { if (!$("#drawer").hidden) closeDrawer(); else $("#banner").hidden = true; return; }
  if (typing) return;
  if (e.key === "/") { e.preventDefault(); showView("monitor"); $("#wireSearch").focus(); return; }
  const views = ["monitor", "news", "vol", "sectors", "earnings", "alerts", "system"];
  if (/^[1-7]$/.test(e.key)) { showView(views[Number(e.key) - 1]); return; }
  if (e.key === "Enter" && document.activeElement?.matches(".row[data-id]")) { openDrawer(findStory(document.activeElement.dataset.id)); return; }
  if (e.key === "j" || e.key === "k") {
    const list = S.view === "news" ? "#newsList" : "#wire";
    const rows = $$(`${list} .row[data-id]`); if (!rows.length) return;
    let i = rows.findIndex((r) => r.dataset.id === S.selected);
    i = e.key === "j" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    rows[i].focus(); rows[i].scrollIntoView({ block: "nearest" }); openDrawer(findStory(rows[i].dataset.id)); rows[i].focus();
  }
});
$("#drawerClose").onclick = closeDrawer;
$("#bannerClose").onclick = () => ($("#banner").hidden = true);
$("#alertBtn").onclick = () => showView("alerts");
const soundBtn = $("#soundBtn");
function paintSound() { soundBtn.setAttribute("aria-pressed", String(!S.muted)); soundBtn.textContent = S.muted ? "Sound off" : "Sound on"; }
soundBtn.onclick = () => { S.muted = !S.muted; try { localStorage.setItem("muted", S.muted ? "1" : "0"); } catch {} paintSound(); if (!S.muted) beep("high"); renderChannels(); };
paintSound();
$("#wireFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]"); if (!b) return;
  S.wireFilter = b.dataset.f; $$("#wireFilter button").forEach((x) => x.classList.toggle("on", x === b));
  loadWire().catch(() => {});
});
let tmr;
const debounce = (fn) => () => { clearTimeout(tmr); tmr = setTimeout(() => fn().catch(() => {}), 250); };
$("#wireSearch").addEventListener("input", debounce(loadWire));
["#newsSearch", "#newsCat", "#newsKind", "#newsHours", "#newsSort"].forEach((s) => $(s).addEventListener("input", debounce(loadNews)));
$("#newsMin").addEventListener("input", () => { $("#newsMinV").textContent = $("#newsMin").value; debounce(loadNews)(); });
$("#trackedOnly").addEventListener("change", () => S.dash && renderEarnings(S.dash.earnings));
$("#refreshBtn").onclick = async () => {
  const b = $("#refreshBtn"); b.disabled = true; b.textContent = "Checking";
  await api("/api/refresh", { method: "POST" }).catch(() => {});
  if (S.dash) S.dash.refreshing = true; tickFeed();
  setTimeout(async () => { await refreshAll(); b.disabled = false; b.textContent = "Check now"; }, 6000);
};
$("#testAlert").onclick = async () => {
  const r = await api("/api/alerts/test", { method: "POST" });
  await pollAlerts();
  toast({ level: "test", title: `Test alert created. Telegram: ${r.telegram}.` });
};
$("#notifyBtn").onclick = async () => {
  if (!("Notification" in window) || !window.isSecureContext) { renderChannels(); return; }
  await Notification.requestPermission(); renderChannels();
  if (Notification.permission === "granted") new Notification("NSE Wire notifications are on", { body: "You will be notified of new alerts while this page is open." });
};
$("#watchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#watchInput").value.trim().toUpperCase(); if (!v) return;
  $("#watchInput").value = ""; saveWatch([...S.watch, v]);
});
$("#tryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = $("#tryText").value.trim(); if (!t) return;
  const a = await api(`/api/analyze?text=${encodeURIComponent(t)}`);
  const n = { id: "try", title: t, link: "#", source: "Your headline", published: new Date().toISOString(), a };
  S.tryRow = n;
  $("#tryOut").innerHTML = `<ol class="wire">${wireRow(n, 0)}</ol>`;
});

async function refreshAll() {
  await Promise.allSettled([loadDashboard(), loadWire(), pollAlerts()]);
  if (S.view === "news") loadNews().catch(() => {});
}

/* ------------------------------------------------------------------ boot */
(async function boot() {
  tickClock(); setInterval(tickClock, 1000);
  try { const v = localStorage.getItem("view"); if (v && $(`#v-${v}`)) showView(v); } catch {}
  await Promise.allSettled([loadDashboard(), loadWire(), pollAlerts(true)]);
  api("/api/watchlist").then((w) => { S.known = w.known; $("#knownSymbols").innerHTML = w.known.map((s) => `<option value="${esc(s)}">`).join(""); }).catch(() => {});
  setInterval(() => pollAlerts().catch(() => {}), 15000);
  setInterval(() => loadWire().catch(() => {}), 30000);
  setInterval(() => loadDashboard().catch(() => {}), 60000);
})();
