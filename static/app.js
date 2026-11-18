"use strict";
/* NSE Wire front end. No framework, no build step.
   Timers: clock every 1s, alerts every 15s, feed every 20s, desk (prices, calendar, status) every 30s. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  desk: null, feed: [], seen: new Set(), firstFeed: true,
  alerts: [], lastAlertId: 0,
  view: "desk", filter: "", selected: null,
  muted: false, watch: [], cache: new Map(),
};
try { S.muted = localStorage.getItem("muted") === "1"; } catch {}

/* ------------------------------------------------------------------ formatting */
const IST_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const IST_FULL = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const IST_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
const istTime = (iso) => IST_FMT.format(new Date(iso));
function istStamp(iso) {
  const day = IST_DAY.format(new Date(iso));
  return day === IST_DAY.format(new Date()) ? istTime(iso) : `${day.replace(/^\w+ /, "")} ${istTime(iso)}`;
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
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
const LEVEL_NAME = { critical: "Critical", high: "Market-wide", filing: "Filing", stock: "Stock news", event: "Scheduled",
  vix: "Volatility", watch: "Watchlist", test: "Test" };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} on ${path}`);
  return r.json();
}

/* ------------------------------------------------------------------ session clock + status */
function istParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: Number(p.hour) * 60 + Number(p.minute) };
}
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
  tickStatus();
  tickCountdowns();
}

function tickStatus() {
  const d = S.desk; if (!d) return;
  const el = $("#feed"), last = d.last || {};
  const age = (iso) => iso ? (Date.now() - new Date(iso)) / 60000 : Infinity;
  const worst = Math.min(age(last.filings), age(last.news));
  el.className = "feed " + (d.refreshing || worst < 12 ? "live" : worst < 40 ? "late" : "dead");
  $("#feedText").textContent = d.refreshing && !last.news ? "Checking sources now"
    : !last.news && !last.filings ? "Waiting for first update"
    : `Filings ${ago(last.filings)}, news ${ago(last.news)}`;
}

/* ------------------------------------------------------------------ top bar */
const INVERT = new Set(["^INDIAVIX", "USDINR=X", "BZ=F", "^TNX", "DX-Y.NYB"]); // rising = bad for Indian equities
const decimals = (m) => m.symbol === "USDINR=X" ? 3 : ["^INDIAVIX", "^TNX"].includes(m.symbol) ? 2 : m.price > 1000 ? 1 : 2;
function renderQuotes(rows) {
  $("#quotes").innerHTML = rows.map((m) => {
    const ch = m.chg_1d, eff = INVERT.has(m.symbol) ? -ch : ch;
    return `<div class="q" title="${INVERT.has(m.symbol) ? "Coloured by effect on Indian equities: a rise is negative. " : ""}${m.asof ? `Last bar ${esc(m.asof)}` : ""}">
      <span class="q-name">${esc(m.name)}</span>
      <span class="q-row"><span class="q-px">${m.price != null ? num(m.price, decimals(m)) : "–"}</span>
      <span class="q-ch ${ch == null ? "flat" : dirCls(eff)}">${ch == null ? "" : `${ch > 0 ? "▲" : ch < 0 ? "▼" : ""} ${pct(ch)}`}</span></span>
    </div>`;
  }).join("");
}
function renderGlobal(rows) {
  $("#globalTbl").innerHTML = rows.map((m) => {
    const ch = m.chg_1d, eff = INVERT.has(m.symbol) ? -ch : ch;
    return `<tr><td>${esc(m.name)}</td><td class="r">${m.price != null ? num(m.price, decimals(m)) : "–"}</td>
      <td class="r ${ch == null ? "flat" : dirCls(eff)}">${pct(ch)}</td></tr>`;
  }).join("");
}

/* ------------------------------------------------------------------ today: events, results, ban list */
function countdown(iso) {
  const m = Math.round((new Date(iso) - Date.now()) / 60000);
  if (m < -1) return ["done", "Done"];
  if (m <= 1) return ["now", "Now"];
  if (m <= 60) return ["soon", `in ${m} min`];
  return ["", `in ${dur(m)}`];
}
function renderToday(d) {
  const ev = d.events || [];
  const rows = ev.map((e) => {
    const [cls, txt] = countdown(e.ts);
    const fc = e.forecast || e.previous ? `<span class="sub">${e.forecast ? `Forecast ${esc(e.forecast)}` : ""}${e.forecast && e.previous ? ", " : ""}${e.previous ? `previous ${esc(e.previous)}` : ""}</span>` : "";
    return `<div class="ev ${e.impact === "high" ? "hi" : ""} ${cls}">
      <span class="ev-t">${istStamp(e.ts)}</span>
      <span class="ev-x">${esc(e.title)}${fc}</span>
      <span class="ev-c" data-ts="${esc(e.ts)}">${txt}</span></div>`;
  });
  const res = (d.results || []).map((r) => `<span class="chip" data-sym="${esc(r.symbol)}">${esc(r.symbol)} <i>${esc(r.when)}</i></span>`).join("");
  const ban = d.ban == null ? `<span class="sub">Not available (NSE blocked or not yet published)</span>`
    : d.ban.length ? d.ban.map((s) => `<span class="chip ban">${esc(s)}</span>`).join("") : `<span class="sub">No stocks in the ban period</span>`;
  $("#today").innerHTML = `
    <div class="t-sec">${rows.length ? rows.join("") : `<div class="empty">No scheduled releases in the next 36 hours.</div>`}</div>
    <div class="t-row"><span class="t-lbl">Results</span><span class="chips">${res || `<span class="sub">No tracked stock reports today or tomorrow</span>`}</span></div>
    <div class="t-row"><span class="t-lbl">F&amp;O ban</span><span class="chips">${ban}</span></div>`;
}
function tickCountdowns() {
  $$(".ev-c[data-ts]").forEach((el) => {
    const [cls, txt] = countdown(el.dataset.ts);
    if (el.textContent !== txt) { el.textContent = txt; el.parentElement.classList.remove("done", "now", "soon"); if (cls) el.parentElement.classList.add(cls); }
  });
}

/* ------------------------------------------------------------------ feed */
function symTags(it) {
  return it.symbols.map((s) => {
    const mv = it.moves?.[s];
    return `<span class="stk${S.watch.includes(s) ? " w" : ""}">${esc(s)}${mv != null ? ` <span class="${dirCls(mv)}">${pct(mv)}</span>` : ""}</span>`;
  }).join("");
}
function feedRow(it) {
  const isNew = !S.firstFeed && !S.seen.has(it.id);
  const kind = it.type === "filing" ? `<span class="badge filing">${esc(it.source)} filing</span>` : `<span class="badge news">News</span>`;
  return `<li class="row ${it.importance === "high" ? "imp" : ""}${it.market_wide ? " mw" : ""}${isNew ? " new" : ""}${S.selected === it.id ? " sel" : ""}"
      data-id="${esc(it.id)}" data-type="${it.type}" tabindex="0">
    <time datetime="${esc(it.ts)}">${istStamp(it.ts)}</time>
    <div>
      <div class="meta top">${kind}<span class="tag">${esc(it.label)}</span>${symTags(it)}</div>
      <div class="hl">${esc(it.title)}</div>
      ${it.snippet ? `<div class="snip">${esc(it.snippet)}${it.snippet.length >= 260 ? "…" : ""}</div>` : ""}
      <div class="meta">${esc(it.type === "news" ? it.source : it.company || "")}${it.similar ? `<span class="more">+${it.similar} similar ${it.similar === 1 ? "story" : "stories"}</span>` : ""}</div>
    </div>
  </li>`;
}
const feedParams = () => new URLSearchParams({ window: $("#feedWindow").value, kind: S.filter,
  routine: $("#feedRoutine").checked ? "true" : "false", q: $("#feedSearch").value.trim(), limit: 400 });

async function loadFeed() {
  const rows = await api(`/api/feed?${feedParams()}`);
  S.feed = rows;
  const el = $("#feedList");
  if (!rows.length) {
    el.innerHTML = `<li class="empty">${S.filter === "watch" && !S.watch.length
      ? "Your watchlist is empty. <b>Add symbols under Notifications and watchlist.</b>"
      : $("#feedSearch").value.trim() ? "Nothing matches the search." : "Nothing yet in this window."}</li>`;
  } else {
    el.innerHTML = rows.map(feedRow).join("");
  }
  rows.forEach((n) => S.seen.add(n.id));
  if (S.firstFeed) {
    const m = location.hash.match(/^#(filing|news)=(.+)$/);
    if (m) openItem(m[1], decodeURIComponent(m[2]));
  }
  S.firstFeed = false;
  renderFeedNote();
}
function renderFeedNote() {
  const src = Object.fromEntries((S.desk?.sources || []).map((s) => [s.name, s]));
  const nse = src["NSE filings"], bse = src["BSE filings"];
  const note = $("#feedNote");
  if (nse && bse && !nse.ok && !bse.ok) {
    note.hidden = false;
    note.innerHTML = `<b>Exchange filings are not reaching this server.</b> Both NSE and BSE refused the connection, so only news headlines are shown. See System for the error.`;
  } else note.hidden = true;
}

/* ------------------------------------------------------------------ detail drawer */
async function openItem(type, id) {
  const key = `${type}:${id}`;
  let d = S.cache.get(key);
  if (!d) {
    try { d = await api(`/api/item?kind=${type}&id=${encodeURIComponent(id)}`); S.cache.set(key, d); } catch { return; }
  }
  S.selected = id;
  $$(".row.sel").forEach((r) => r.classList.remove("sel"));
  $$(`.row[data-id="${CSS.escape(id)}"]`).forEach((r) => r.classList.add("sel"));
  $("#drawerBody").innerHTML = type === "filing" ? filingDetail(d) : newsDetail(d);
  history.replaceState(null, "", `#${type}=${encodeURIComponent(id)}`);
  $("#drawer").hidden = false;
  $("#drawerClose").focus({ preventScroll: true });
}
function stockTable(list) {
  if (!list?.length) return "";
  return `<table class="tbl"><tr><th>Stock</th><th class="r">Price</th><th class="r">Today</th><th></th></tr>
    ${list.map((s) => `<tr><td class="sym">${esc(s.symbol)}</td><td class="r">${num(s.price)}</td>
      <td class="r ${dirCls(s.chg)}">${pct(s.chg)}</td>
      <td class="r">${S.watch.includes(s.symbol) ? `<span class="sub">On watchlist</span>` : `<button class="add-watch" data-add="${esc(s.symbol)}">Watch</button>`}</td></tr>`).join("")}</table>`;
}
function filingDetail(d) {
  return `
    <div class="d-src">${esc(d.source)} filing, ${istStamp(d.ts)} IST</div>
    <div class="d-title">${esc(d.symbol || d.symbols[0])}: ${esc(d.title)}</div>
    <div class="meta top"><span class="tag">${esc(d.label)}</span><span>${esc(d.company)}</span>${d.sector ? `<span>${esc(d.sector)}</span>` : ""}</div>
    ${d.link ? `<p><a href="${esc(d.link)}" target="_blank" rel="noopener">Open the filing (PDF)</a></p>` : ""}
    ${d.detail ? `<h3>What the company filed</h3><p class="pre">${esc(d.detail)}</p>` : ""}
    ${d.category && d.category !== d.title ? `<p class="sub">Exchange category: ${esc(d.category)}</p>` : ""}
    <h3>Price</h3>${stockTable(d.stocks)}`;
}
function newsDetail(d) {
  const exp = (d.exposure || []).map((x) => `<tr><td>${esc(x.sector)}</td>
      <td class="${x.effect > 0 ? "up" : "down"}">${x.effect > 0 ? "Gains" : "Hurt"}${Math.abs(x.effect) >= 2 ? ", strongly" : ""}</td>
      <td>${x.stocks.map((s) => `<span class="stk">${esc(s.symbol)} <span class="${dirCls(s.chg)}">${s.chg == null ? "" : pct(s.chg)}</span></span>`).join(" ")}</td></tr>`).join("");
  return `
    <div class="d-src">${esc(d.source)}, ${istStamp(d.ts)} IST</div>
    <div class="d-title">${esc(d.title)}</div>
    ${d.label ? `<div class="meta top"><span class="tag">${esc(d.label)}</span></div>` : ""}
    ${d.link ? `<p><a href="${esc(d.link)}" target="_blank" rel="noopener">Open the original story</a></p>` : ""}
    ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
    ${d.drivers?.length ? `<h3>Why it matters</h3>${d.drivers.map((e) => `<div class="driver"><b>${esc(e.name)}</b>${["up", "down"].includes(e.direction) ? `, ${e.direction === "up" ? "rising" : "falling"}` : ""}<p>${esc(e.why)}</p></div>`).join("")}` : ""}
    ${exp ? `<h3>Who is exposed</h3><table class="tbl"><tr><th>Sector</th><th>Usual effect</th><th>Stocks today</th></tr>${exp}</table>` : ""}
    ${d.stocks?.length ? `<h3>Stocks named</h3>${stockTable(d.stocks)}` : ""}`;
}
function closeDrawer() {
  $("#drawer").hidden = true; S.selected = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
  $$(".row.sel").forEach((r) => r.classList.remove("sel"));
}

/* ------------------------------------------------------------------ sources */
function renderSources(rows) {
  $("#srcTable").innerHTML = `<tr><th>Source</th><th>Status</th><th class="r">Items</th><th>Checked</th><th>Problem</th></tr>` +
    rows.map((s) => `<tr><td>${esc(s.name)}</td><td class="${s.ok ? "up" : "down"}">${s.ok ? "Working" : "Failing"}</td>
      <td class="r">${s.count}</td><td>${ago(s.checked_at)}</td><td class="hl-cell">${esc(s.error)}</td></tr>`).join("");
}

/* ------------------------------------------------------------------ notification centre
   Alerts are created on the server. The browser decides how to show each one, per level:
   pop-up (with the amber banner for critical/volatility), sound, and desktop notification.
   Read state and preferences live in this browser's localStorage. */
const LEVELS = ["critical", "high", "filing", "stock", "event", "vix", "watch"];
const DEFAULT_PREFS = {
  critical: { popup: true, sound: true, desktop: true }, high: { popup: true, sound: true, desktop: true },
  filing: { popup: true, sound: true, desktop: true }, stock: { popup: true, sound: false, desktop: false },
  event: { popup: true, sound: true, desktop: true }, vix: { popup: true, sound: true, desktop: true },
  watch: { popup: true, sound: true, desktop: true },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("nw." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("nw." + k, JSON.stringify(v)); } catch {} },
};
S.prefs = JSON.parse(JSON.stringify(DEFAULT_PREFS));
Object.entries(store.get("prefs", {})).forEach(([l, v]) => { if (S.prefs[l]) Object.assign(S.prefs[l], v); });
S.readBase = store.get("readBase", null);      // every alert id <= this is read
S.readIds = new Set(store.get("readIds", []));  // individually read alerts above readBase
const pref = (level, kind) => (S.prefs[level] || S.prefs.high)[kind];
const isUnread = (al) => S.readBase != null && al.id > S.readBase && !S.readIds.has(al.id);
function saveRead() { store.set("readBase", S.readBase); store.set("readIds", [...S.readIds].slice(-500)); }
function markRead(al) { if (isUnread(al)) { S.readIds.add(al.id); saveRead(); renderAlerts(); } }
function markAllRead() { S.readBase = Math.max(S.readBase ?? 0, S.lastAlertId); S.readIds.clear(); saveRead(); renderAlerts(); }

function alertItem(al, fresh = false) {
  const unread = isUnread(al);
  return `<li class="al${unread ? " unread" : ""}${fresh ? " fresh" : ""}" data-alert="${al.id}" tabindex="0" role="button"
      aria-label="${esc((unread ? "Unread. " : "") + (LEVEL_NAME[al.level] || al.level) + ": " + al.title)}">
    <span class="when">${istStamp(al.ts)}</span>
    <div><span class="lvl ${esc(al.level)}">${LEVEL_NAME[al.level] || esc(al.level)}</span>${unread ? `<span class="unread-dot" aria-hidden="true"></span>` : ""}
      <div class="t">${esc(al.title)}</div></div>
    ${al.body ? `<div class="b">${esc(al.body)}</div>` : ""}
  </li>`;
}
function renderAlerts(freshIds = new Set()) {
  const items = S.alerts;
  const none = `<li class="empty">No notifications yet. They appear for market-wide shocks, important filings, scheduled releases, VIX spikes and watchlist news.</li>`;
  $("#alertsMini").innerHTML = items.length ? items.slice(0, 15).map((a) => alertItem(a, freshIds.has(a.id))).join("") : none;
  $("#alertLog").innerHTML = items.length ? items.map((a) => alertItem(a, freshIds.has(a.id))).join("") : none;
  $("#notifList").innerHTML = items.length ? items.slice(0, 40).map((a) => alertItem(a, freshIds.has(a.id))).join("") : none;
  const unread = items.filter(isUnread).length;
  const c = $("#alertCount"); c.hidden = !unread; c.textContent = unread > 99 ? "99+" : unread;
  $("#markAllRead").disabled = !unread;
  $("#notifSummary").textContent = unread ? `${unread} unread` : "All caught up";
  document.title = unread ? `(${unread}) NSE Wire` : "NSE Wire";
}

async function openAlert(al) {
  if (!al) return;
  markRead(al);
  closePanel();
  if (al.article_id && (al.kind === "filing" || al.kind === "news")) { showView("desk"); openItem(al.kind, al.article_id); return; }
  if (al.link) { window.open(al.link, "_blank", "noopener"); return; }
  showView(al.kind === "calendar" || al.kind === "price" ? "desk" : "alerts");
}
const alertById = (id) => S.alerts.find((a) => a.id === Number(id));

async function pollAlerts(initial = false) {
  const rows = await api(`/api/alerts?since=${S.lastAlertId}&limit=100`);
  if (rows.length) S.lastAlertId = Math.max(S.lastAlertId, ...rows.map((r) => r.id));
  if (S.readBase == null) { S.readBase = S.lastAlertId; saveRead(); } // first visit: past alerts count as read
  if (!rows.length) { if (initial) renderAlerts(); return; }
  S.alerts = [...rows, ...S.alerts].slice(0, 300);
  if (initial) { renderAlerts(); return; }
  renderAlerts(new Set(rows.map((r) => r.id)));
  deliver(rows);
  loadFeed().catch(() => {});
}
const rank = (l) => ({ critical: 5, vix: 4, filing: 3, event: 3, high: 3, watch: 2, stock: 1 }[l] || 0);
function deliver(rows) {
  const byRank = rows.slice().sort((a, b) => rank(b.level) - rank(a.level));
  const bannerAl = byRank.find((a) => (a.level === "critical" || a.level === "vix") && pref(a.level, "popup"));
  if (bannerAl) showBanner(bannerAl);
  byRank.filter((a) => pref(a.level, "popup")).slice(0, 3).forEach(toast);
  const loud = byRank.find((a) => pref(a.level, "sound"));
  if (loud) beep(loud.level);
  byRank.filter((a) => pref(a.level, "desktop")).slice(0, 3).forEach(notify);
}
function showBanner(al) {
  S.bannerAlert = al;
  $("#bannerLevel").textContent = LEVEL_NAME[al.level] || al.level;
  $("#bannerTime").textContent = istTime(al.ts) + " IST";
  $("#bannerTitle").textContent = al.title;
  $("#bannerBody").textContent = al.body || "";
  const b = $("#banner"); b.hidden = false; b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash");
}
function toast(al) {
  const t = document.createElement("div");
  t.className = `toast ${al.level}`;
  t.setAttribute("role", "button"); t.tabIndex = 0;
  t.innerHTML = `<span class="lvl ${esc(al.level)}">${LEVEL_NAME[al.level] || esc(al.level)}</span><span class="toast-time">${istTime(al.ts)}</span>
    <div class="t">${esc(al.title)}</div>${al.body ? `<div class="b">${esc(al.body)}</div>` : ""}`;
  t.onclick = () => { t.remove(); openAlert(al); };
  $("#toasts").prepend(t);
  while ($("#toasts").children.length > 4) $("#toasts").lastElementChild.remove();
  setTimeout(() => t.remove(), al.level === "critical" ? 30000 : 12000);
}
let audioCtx;
function beep(level) {
  if (S.muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = level === "critical" || level === "vix" ? [880, 660, 880] : level === "watch" || level === "stock" ? [520]
      : level === "event" ? [660, 660] : [740, 990];
    tones.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime + i * 0.16;
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.15);
    });
  } catch {}
}
// Browsers block sound until the person has interacted with the page once; unlock on the first click or key.
["click", "keydown"].forEach((ev) => document.addEventListener(ev, () => {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch {}
}, { once: true }));
function notify(al) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(`${LEVEL_NAME[al.level] || al.level}: ${al.title}`,
      { body: al.body || "", tag: "nsewire-" + al.id, requireInteraction: al.level === "critical" });
    n.onclick = () => { window.focus(); openAlert(al); n.close(); };
  } catch {}
}

/* bell panel */
function openPanel() { $("#notifPanel").hidden = false; $("#alertBtn").setAttribute("aria-expanded", "true"); }
function closePanel() { $("#notifPanel").hidden = true; $("#alertBtn").setAttribute("aria-expanded", "false"); }
const panelOpen = () => !$("#notifPanel").hidden;

/* preferences */
function desktopState() {
  if (!("Notification" in window)) return ["unsupported", "This browser does not support desktop notifications."];
  if (!window.isSecureContext) return ["insecure", "Browsers only allow desktop notifications on https or localhost. Open the dashboard at http://localhost:8000 on the server to use them. Pop-ups and sound work everywhere."];
  if (Notification.permission === "denied") return ["denied", "Desktop notifications are blocked for this site. Allow them in the browser's site settings, using the icon left of the address."];
  if (Notification.permission === "granted") return ["granted", "Desktop notifications are allowed. They appear even when this tab is in the background."];
  return ["default", "Allow desktop notifications to get alerts while this tab is in the background."];
}
function renderPrefs() {
  const [state, note] = desktopState(), canDesktop = state === "granted";
  $("#prefTable").innerHTML = `<tr><th>Alert</th><th>Pop-up</th><th>Sound</th><th>Desktop</th></tr>` +
    LEVELS.map((l) => `<tr><td><span class="lvl ${l}">${LEVEL_NAME[l]}</span></td>
      ${["popup", "sound", "desktop"].map((k) => `<td><input type="checkbox" data-pref="${l}.${k}" ${S.prefs[l][k] ? "checked" : ""}
        ${k === "desktop" && !canDesktop ? "disabled" : ""} aria-label="${LEVEL_NAME[l]} ${k}"></td>`).join("")}</tr>`).join("");
  $("#notifyBtn").hidden = state !== "default";
  $("#notifyNote").textContent = note + (S.muted ? " Sound is currently muted with the button in the top bar." : "");
}

/* ------------------------------------------------------------------ watchlist */
function renderWatch() {
  $("#watchList").innerHTML = S.watch.length
    ? S.watch.map((s) => `<li>${esc(s)}<button data-remove="${esc(s)}" aria-label="Remove ${esc(s)}">×</button></li>`).join("")
    : `<li class="empty" style="background:none;border:0;padding:4px 0;font-weight:400">No stocks yet.</li>`;
}
async function saveWatch(list) {
  const r = await api("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: list }) });
  S.watch = r.symbols; renderWatch();
  S.cache.clear();
  if (S.selected) { const row = $(`.row[data-id="${CSS.escape(S.selected)}"]`); if (row) openItem(row.dataset.type, S.selected); }
  loadFeed().catch(() => {});
}

/* ------------------------------------------------------------------ desk */
async function loadDesk() {
  const d = await api("/api/desk");
  S.desk = d; S.watch = d.watchlist || [];
  renderQuotes(d.quotes || []);
  renderGlobal(d.global || []);
  renderToday(d);
  renderSources(d.sources || []);
  renderWatch();
  renderPrefs();
  renderFeedNote();
  tickStatus();
}

/* ------------------------------------------------------------------ views + wiring */
function showView(v) {
  if (!$(`#v-${v}`)) v = "desk";
  S.view = v;
  $$("#views button[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("on", s.id === `v-${v}`));
  try { localStorage.setItem("view", v); } catch {}
}
$("#views").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) showView(b.dataset.view); });
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]"); if (go) { showView(go.dataset.goto); return; }
  const add = e.target.closest("[data-add]"); if (add) { saveWatch([...S.watch, add.dataset.add]); return; }
  const rm = e.target.closest("[data-remove]"); if (rm) { saveWatch(S.watch.filter((s) => s !== rm.dataset.remove)); return; }
  const chip = e.target.closest(".chip[data-sym]");
  if (chip) { $("#feedSearch").value = chip.dataset.sym; showView("desk"); loadFeed().catch(() => {}); return; }
  const row = e.target.closest(".row[data-id]");
  if (row && !e.target.closest("a")) openItem(row.dataset.type, row.dataset.id);
});
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (e.key === "Escape") { if (panelOpen()) closePanel(); else if (!$("#drawer").hidden) closeDrawer(); else $("#banner").hidden = true; return; }
  if (e.key === "Enter" && document.activeElement?.matches("[data-alert]")) { openAlert(alertById(document.activeElement.dataset.alert)); return; }
  if (typing) return;
  if (e.key === "/") { e.preventDefault(); showView("desk"); $("#feedSearch").focus(); return; }
  const views = ["desk", "alerts", "system"];
  if (/^[1-3]$/.test(e.key)) { showView(views[Number(e.key) - 1]); return; }
  if (e.key === "Enter" && document.activeElement?.matches(".row[data-id]")) { const r = document.activeElement; openItem(r.dataset.type, r.dataset.id); return; }
  if (e.key === "j" || e.key === "k") {
    const rows = $$("#feedList .row[data-id]"); if (!rows.length) return;
    let i = rows.findIndex((r) => r.dataset.id === S.selected);
    i = e.key === "j" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    rows[i].scrollIntoView({ block: "nearest" }); openItem(rows[i].dataset.type, rows[i].dataset.id); rows[i].focus();
  }
});
$("#drawerClose").onclick = closeDrawer;
$("#bannerClose").onclick = (e) => { e.stopPropagation(); $("#banner").hidden = true; };
$("#banner").onclick = () => { if (S.bannerAlert) { $("#banner").hidden = true; openAlert(S.bannerAlert); } };
$("#alertBtn").onclick = (e) => { e.stopPropagation(); panelOpen() ? closePanel() : openPanel(); };
$("#markAllRead").onclick = (e) => { e.stopPropagation(); markAllRead(); };
$("#panelSettings").onclick = () => { closePanel(); showView("alerts"); };
document.addEventListener("click", (e) => { if (panelOpen() && !e.target.closest("#notifPanel, #alertBtn")) closePanel(); });
document.addEventListener("click", (e) => {
  const li = e.target.closest("[data-alert]"); if (li) openAlert(alertById(li.dataset.alert));
});
$("#prefTable").addEventListener("change", (e) => {
  const k = e.target.dataset.pref; if (!k) return;
  const [level, kind] = k.split("."); S.prefs[level][kind] = e.target.checked; store.set("prefs", S.prefs);
});
const soundBtn = $("#soundBtn");
function paintSound() { soundBtn.setAttribute("aria-pressed", String(!S.muted)); soundBtn.textContent = S.muted ? "Sound off" : "Sound on"; }
soundBtn.onclick = () => { S.muted = !S.muted; try { localStorage.setItem("muted", S.muted ? "1" : "0"); } catch {} paintSound(); if (!S.muted) beep("high"); renderPrefs(); };
paintSound();
$("#feedFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]"); if (!b) return;
  S.filter = b.dataset.f; $$("#feedFilter button").forEach((x) => x.classList.toggle("on", x === b));
  try { localStorage.setItem("filter", S.filter); } catch {}
  loadFeed().catch(() => {});
});
let tmr;
const debounce = (fn) => () => { clearTimeout(tmr); tmr = setTimeout(() => fn().catch(() => {}), 250); };
$("#feedSearch").addEventListener("input", debounce(loadFeed));
["#feedWindow", "#feedRoutine"].forEach((s) => $(s).addEventListener("change", () => loadFeed().catch(() => {})));
$("#refreshBtn").onclick = async () => {
  const b = $("#refreshBtn"); b.disabled = true; b.textContent = "Checking";
  await api("/api/refresh", { method: "POST" }).catch(() => {});
  setTimeout(async () => { await refreshAll(); b.disabled = false; b.textContent = "Check now"; }, 8000);
};
$("#testAlert").onclick = async () => {
  const b = $("#testAlert"); b.disabled = true;
  try { await api("/api/alerts/test", { method: "POST" }); await pollAlerts(); } finally { b.disabled = false; }
};
$("#notifyBtn").onclick = async () => {
  if ("Notification" in window && window.isSecureContext) {
    await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification("NSE Wire desktop notifications are on", { body: "Alerts will appear here even when the tab is in the background." });
  }
  renderPrefs();
};
$("#watchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#watchInput").value.trim().toUpperCase(); if (!v) return;
  $("#watchInput").value = ""; saveWatch([...S.watch, v]);
});
$("#tryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = $("#tryText").value.trim(); if (!t) return;
  const r = await api(`/api/analyze?text=${encodeURIComponent(t)}`);
  const why = r.wrap ? "Hidden: it reads as a market wrap, preview or list, which carries no new information."
    : r.shown ? "Shown on the desk." : "Hidden: it names no tracked stock and no market-wide trigger.";
  $("#tryOut").innerHTML = `<p class="note"><b>${esc(why)}</b></p>
    ${r.item ? `<ol class="wire">${feedRow({ ...r.item, moves: {} })}</ol>` : ""}
    ${r.drivers.length ? `<dl class="kv">${r.drivers.map((d) => `<dt>${esc(d.name)}</dt><dd>${["up", "down"].includes(d.direction) ? (d.direction === "up" ? "Rising. " : "Falling. ") : ""}${esc(d.why)}</dd>`).join("")}</dl>` : ""}
    ${r.stocks.length ? `<p class="note">Stocks recognised: ${r.stocks.map(esc).join(", ")}</p>` : ""}`;
});

async function refreshAll() {
  await Promise.allSettled([loadDesk(), loadFeed(), pollAlerts()]);
}

/* ------------------------------------------------------------------ boot */
(async function boot() {
  try {
    const v = localStorage.getItem("view"); if (v) showView(v);
    const f = localStorage.getItem("filter");
    if (f != null) { S.filter = f; $$("#feedFilter button").forEach((x) => x.classList.toggle("on", x.dataset.f === f)); }
  } catch {}
  tickClock(); setInterval(tickClock, 1000);
  await Promise.allSettled([loadDesk(), loadFeed(), pollAlerts(true)]);
  api("/api/watchlist").then((w) => { $("#knownSymbols").innerHTML = w.known.map((s) => `<option value="${esc(s)}">`).join(""); }).catch(() => {});
  setInterval(() => pollAlerts().catch(() => {}), 15000);
  setInterval(() => loadFeed().catch(() => {}), 20000);
  setInterval(() => loadDesk().catch(() => {}), 30000);
})();
