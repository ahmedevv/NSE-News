"use strict";
/* NSE Wire front end. No framework, no build step.
   Timers: clock every 1s, alerts every 15s, feed every 20s, desk (prices, calendar, status) every 30s. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  desk: null, feed: [], seen: new Set(), firstFeed: true,
  alerts: [], lastAlertId: 0,
  view: "desk", filter: "", open: null,
  muted: false, watch: [], cache: new Map(),
};
try { S.muted = localStorage.getItem("muted") === "1"; } catch {}

/* ------------------------------------------------------------------ formatting */
const TZ = "Asia/Kolkata";
const IST_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const IST_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const IST_WD = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
const istTime = (iso) => IST_FMT.format(new Date(iso));
const istDay = (iso) => IST_DAY.format(new Date(iso));
const isToday = (iso) => istDay(iso) === IST_DAY.format(new Date());
const istStamp = (iso) => (isToday(iso) ? istTime(iso) : `${IST_WD.format(new Date(iso))} ${istTime(iso)}`);
const num = (v, d = 2) => (v == null ? "–" : Number(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`);
const dirCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
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

/* ------------------------------------------------------------------ session clock + next up */
function istParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: Number(p.hour) * 60 + Number(p.minute) };
}
const PRE = 540, OPEN = 555, CLOSE = 930; // 09:00, 09:15, 15:30 IST
const WDS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* The next few session milestones as real instants (IST is a fixed +05:30 offset) */
function sessionMilestones() {
  const out = [], now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  for (let i = 0; i < 5 && out.length < 3; i++) {
    const day = new Date(now.getTime() + i * 86400000);
    if (["Sat", "Sun"].includes(IST_WD.format(day))) continue;
    const d = ymd.format(day);
    [["09:00", "NSE pre-open", "Market opens 09:15"], ["09:15", "Market open", "Cash and F&O session starts"],
     ["15:30", "Market close", "Session ends 15:30"]].forEach(([t, title, sub]) => {
      const ts = new Date(`${d}T${t}:00+05:30`);
      if (ts > now) out.push({ ts: ts.toISOString(), title, sub, session: true });
    });
  }
  return out;
}

function tickClock() {
  const now = new Date();
  $("#sessionClock").textContent = `${IST_FMT.format(now)} IST`;
  const { wd, min } = istParts(now);
  const weekday = !["Sat", "Sun"].includes(wd);
  let state = "Market closed", cls = "closed";
  if (weekday && min >= PRE && min < OPEN) { state = `Pre-open · opens in ${dur(OPEN - min)}`; cls = "pre"; }
  else if (weekday && min >= OPEN && min < CLOSE) { state = `Market open · ${dur(CLOSE - min)} left`; cls = "open"; }
  else if (weekday && min < PRE) { state = `Pre-open in ${dur(PRE - min)}`; cls = "pre"; }
  $("#sessionState").textContent = state;
  $("#session").className = `session ${cls}`;
  tickNext();
  tickCountdowns();
}

function nextUp() {
  const d = S.desk || {}, now = Date.now();
  const ev = (d.events || []).filter((e) => e.impact === "high" && new Date(e.ts) > now)
    .map((e) => ({ ts: e.ts, title: e.title, sub: `${istStamp(e.ts)} IST${e.forecast ? ` · forecast ${e.forecast}` : ""}${e.previous ? ` · previous ${e.previous}` : ""}` }));
  return [...ev, ...sessionMilestones()].sort((a, b) => new Date(a.ts) - new Date(b.ts))[0];
}
function tickNext() {
  const n = nextUp(), box = $("#nextUp");
  if (!n) { box.hidden = true; return; }
  const secs = Math.max(0, Math.round((new Date(n.ts) - Date.now()) / 1000));
  const mins = Math.floor(secs / 60);
  box.hidden = false;
  box.classList.toggle("calm", secs > 3600);
  $("#nextTitle").textContent = n.title;
  $("#nextSub").textContent = n.session ? `${istStamp(n.ts)} IST · ${n.sub}` : n.sub;
  $("#nextCd").textContent = secs <= 3600 ? `${String(mins).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`
    : mins < 1440 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m` : istDay(n.ts);
}

function renderStatus() {
  const d = S.desk; if (!d) return;
  const last = d.last || {}, src = d.sources || [];
  const news = src.filter((s) => !/filings|calendar|CSV|ban list|results/i.test(s.name));
  const ok = news.filter((s) => s.ok).length;
  const parts = [d.refreshing && !last.news ? "Checking sources now" : `Headlines checked ${ago(last.news)}`,
    `${ok} of ${news.length} news sources working`, "prices may lag 15 min"];
  if (d.filings_blocked) parts.push("exchange filings off (NSE and BSE block this server)");
  $("#statusLine").textContent = parts.join(" · ");
}

/* ------------------------------------------------------------------ quotes + global cues */
const INVERT = new Set(["^INDIAVIX", "USDINR=X", "BZ=F", "^TNX", "DX-Y.NYB"]); // rising = bad for Indian equities
const decimals = (m) => (m.symbol === "USDINR=X" ? 2 : ["^INDIAVIX", "^TNX"].includes(m.symbol) ? 2 : m.price > 1000 ? 0 : 2);
function renderQuotes(rows) {
  $("#quotes").innerHTML = rows.map((m) => {
    const ch = m.chg_1d, eff = INVERT.has(m.symbol) ? -ch : ch;
    return `<div class="q" title="${INVERT.has(m.symbol) ? "Coloured by effect on Indian equities: a rise is negative. " : ""}${m.asof ? `Last bar ${esc(m.asof)}` : ""}">
      <div class="q-name">${esc(m.name)}</div>
      <div class="q-row"><span class="q-px">${m.price != null ? num(m.price, decimals(m)) : "–"}</span>
      <span class="q-ch ${ch == null ? "flat" : dirCls(eff)}">${ch == null ? "" : pct(ch)}</span></div>
    </div>`;
  }).join("");
}
function renderGlobal(rows) {
  $("#globalTbl").innerHTML = rows.map((m) => {
    const ch = m.chg_1d, eff = INVERT.has(m.symbol) ? -ch : ch;
    return `<div class="cue" title="${m.price != null ? esc(num(m.price, decimals(m))) : ""}"><span>${esc(m.name)}</span>
      <span class="${ch == null ? "flat" : dirCls(eff)}">${pct(ch)}</span></div>`;
  }).join("") || `<div class="ev-none">No prices yet.</div>`;
}

/* ------------------------------------------------------------------ today: events, expiry, results, ban list */
function countdown(iso) {
  const m = Math.round((new Date(iso) - Date.now()) / 60000);
  if (m < -1) return ["done", "Done"];
  if (m <= 1) return ["now", "Now"];
  if (m <= 60) return ["soon", `in ${m} min`];
  return ["", `in ${dur(m)}`];
}
function renderToday(d) {
  $("#todayTitle").textContent = `Today · ${IST_DAY.format(new Date())}`;
  const ev = (d.events || []).filter((e) => e.kind !== "expiry");
  $("#events").innerHTML = ev.length ? ev.map((e) => {
    const [cls, txt] = countdown(e.ts);
    const extra = [e.forecast && `forecast ${e.forecast}`, e.previous && `previous ${e.previous}`].filter(Boolean).join(" · ");
    return `<div class="ev ${cls}">
      <span class="ev-t">${istStamp(e.ts)}</span>
      <span class="ev-x">${esc(e.title)}<span class="dim" data-ts="${esc(e.ts)}" data-extra="${esc(extra)}">${txt}${extra ? ` · ${esc(extra)}` : ""}</span></span>
      <span class="impact ${e.impact === "high" ? "hi" : ""}">${e.impact === "high" ? "HIGH" : e.kind === "india" ? "IND" : "MED"}</span></div>`;
  }).join("") : `<div class="ev-none">No scheduled releases in the next 36 hours.</div>`;

  const x = d.next_expiry;
  $("#expiry").textContent = x ? `${/Monthly/.test(x.title) ? "Monthly" : "Weekly"} · ${istDay(x.ts)}` : "–";
  $("#expirySub").textContent = x ? (/Monthly/.test(x.title) ? "Nifty, Bank Nifty and stock F&O" : "Nifty weekly options") : "";

  $("#ban").innerHTML = d.ban == null ? `<span class="dim">Not available</span>`
    : d.ban.length ? d.ban.map((s) => `<span class="chip ban">${esc(s)}</span>`).join("") : `<span class="dim">None today</span>`;
  $("#results").innerHTML = (d.results || []).map((r) => `<button class="chip" data-sym="${esc(r.symbol)}">${esc(r.symbol)} <i>${esc(r.when)}</i></button>`).join("")
    || `<span class="dim">No tracked stock reports today or tomorrow</span>`;
}
function tickCountdowns() {
  $$("#events [data-ts]").forEach((el) => {
    const [cls, txt] = countdown(el.dataset.ts);
    const full = txt + (el.dataset.extra ? ` · ${el.dataset.extra}` : "");
    if (el.textContent !== full) {
      el.textContent = full;
      const row = el.closest(".ev"); row.classList.remove("done", "now", "soon"); if (cls) row.classList.add(cls);
    }
  });
}

/* ------------------------------------------------------------------ feed */
const FILTERS = {
  "": () => true,
  stock: (it) => !it.market_wide,
  market: (it) => it.market_wide,
  watch: (it) => it.symbols.some((s) => S.watch.includes(s)),
};
function kindBadge(it) {
  if (it.type === "filing") return `<span class="kind filing">${esc(it.source)} FILING</span>`;
  if (it.market_wide) return `<span class="kind mw">MARKET-WIDE</span>`;
  if (it.symbols.some((s) => S.watch.includes(s))) return `<span class="kind watch">WATCHLIST</span>`;
  return `<span class="kind">STOCK</span>`;
}
function symTags(it) {
  return it.symbols.map((s) => {
    const mv = it.moves?.[s];
    return `<span class="stk${S.watch.includes(s) ? " w" : ""}"><b>${esc(s)}</b>${mv != null ? `<span class="${dirCls(mv)}">${pct(mv)}</span>` : ""}</span>`;
  }).join("");
}
function feedRow(it) {
  const isNew = !S.firstFeed && !S.seen.has(it.id);
  const day = isToday(it.ts) ? "" : `<small>${IST_WD.format(new Date(it.ts))}</small>`;
  const src = it.type === "news" ? it.source : it.company || "";
  return `<li class="row${it.importance === "high" && !it.market_wide ? " imp" : ""}${it.market_wide ? " mw" : ""}${isNew ? " new" : ""}"
      data-id="${esc(it.id)}" data-type="${it.type}" tabindex="0" aria-expanded="false">
    <time datetime="${esc(it.ts)}">${day}${istTime(it.ts)}</time>
    <div class="body">
      <div class="tags">${kindBadge(it)}${it.label ? `<span class="tag">${esc(it.label)}</span>` : ""}${symTags(it)}</div>
      <h2 class="hl">${esc(it.title)}</h2>
      ${it.snippet ? `<div class="snip">${esc(it.snippet)}${it.snippet.length >= 260 ? "…" : ""}</div>` : ""}
      <div class="src">${esc(src)}${it.similar ? ` · +${it.similar} similar ${it.similar === 1 ? "story" : "stories"}` : ""}</div>
    </div>
  </li>`;
}
const feedParams = () => new URLSearchParams({ window: $("#feedWindow").value, kind: "", routine: "false",
  q: $("#feedSearch").value.trim(), limit: 400 });

async function loadFeed() {
  S.feed = await api(`/api/feed?${feedParams()}`);
  renderFeed();
}
function renderFeed() {
  const all = S.feed, rows = all.filter(FILTERS[S.filter] || FILTERS[""]);
  $$("#feedFilter button").forEach((b) => { b.querySelector("span").textContent = all.filter(FILTERS[b.dataset.f]).length; });

  const w = $("#feedWindow").value;
  $("#feedTitle").textContent = w === "close" ? "Since the last close" : `Last ${w} hours`;
  const syms = new Set(all.flatMap((i) => i.symbols)), mw = all.filter((i) => i.market_wide).length;
  const from = w === "close" && S.desk?.last_close ? `From ${istTime(S.desk.last_close)} IST ${istDay(S.desk.last_close)} · ` : "";
  $("#feedSummary").textContent = `${from}${all.length} ${all.length === 1 ? "story" : "stories"} on ${syms.size} ${syms.size === 1 ? "stock" : "stocks"} · ${mw} market-wide`;

  const el = $("#feedList");
  if (!rows.length) {
    el.innerHTML = `<li class="empty">${S.filter === "watch" && !S.watch.length
      ? "Your watchlist is empty. <b>Add symbols under Alerts.</b>"
      : $("#feedSearch").value.trim() ? "Nothing matches the search." : "Nothing yet in this window."}</li>`;
  } else {
    el.innerHTML = rows.map(feedRow).join("");
  }
  all.forEach((n) => S.seen.add(n.id));
  if (S.open) { // keep an opened story open across refreshes
    const row = rowFor(S.open.id);
    if (row) expand(row, S.open.type, S.open.id, false);
  }
  if (S.firstFeed) {
    const m = location.hash.match(/^#(filing|news)=(.+)$/);
    if (m) openItem(m[1], decodeURIComponent(m[2]));
  }
  S.firstFeed = false;
}
const rowFor = (id) => $(`#feedList .row[data-id="${CSS.escape(id)}"]`);

/* ------------------------------------------------------------------ inline detail */
async function getDetail(type, id) {
  const key = `${type}:${id}`;
  if (!S.cache.has(key)) S.cache.set(key, await api(`/api/item?kind=${type}&id=${encodeURIComponent(id)}`));
  return S.cache.get(key);
}
async function expand(row, type, id, scroll = true) {
  let d;
  try { d = await getDetail(type, id); } catch { return; }
  $$("#feedList .row.open").forEach((r) => { if (r !== row) collapse(r); });
  $(".why", row)?.remove();
  $(".body", row).insertAdjacentHTML("beforeend", type === "filing" ? filingDetail(d) : newsDetail(d));
  row.classList.add("open"); row.setAttribute("aria-expanded", "true");
  S.open = { type, id };
  history.replaceState(null, "", `#${type}=${encodeURIComponent(id)}`);
  if (scroll) row.scrollIntoView({ block: "nearest" });
}
function collapse(row) {
  $(".why", row)?.remove();
  row.classList.remove("open"); row.setAttribute("aria-expanded", "false");
}
function closeOpen() {
  $$("#feedList .row.open").forEach(collapse);
  S.open = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
}
async function openItem(type, id) {
  showView("desk");
  let row = rowFor(id);
  if (!row) { // older than the window or filtered out: show it at the top of the feed
    let d;
    try { d = await getDetail(type, id); } catch { return; }
    $("#feedList").insertAdjacentHTML("afterbegin", feedRow({ id, type, ts: d.ts, title: d.title, source: d.source, company: d.company,
      label: d.label, symbols: d.symbols || (d.symbol ? [d.symbol] : []), market_wide: !!d.market_wide, importance: d.importance, moves: {} }));
    row = rowFor(id);
  }
  expand(row, type, id);
}
function stockList(list) {
  if (!list?.length) return "";
  return `<div class="eyebrow">Stocks named</div><div class="why-links">${list.map((s) => `<span class="stk"><b>${esc(s.symbol)}</b>
    ${s.price != null ? `<span>${num(s.price)}</span>` : ""}<span class="${dirCls(s.chg)}">${pct(s.chg)}</span></span>
    ${S.watch.includes(s.symbol) ? "" : `<button class="add-watch" data-add="${esc(s.symbol)}">Watch ${esc(s.symbol)}</button>`}`).join("")}</div>`;
}
function filingDetail(d) {
  return `<div class="why">
    ${d.detail ? `<div class="eyebrow">What the company filed</div><p class="pre">${esc(d.detail)}</p>` : ""}
    ${stockList(d.stocks)}
    <div class="why-links">
      ${d.link ? `<a href="${esc(d.link)}" target="_blank" rel="noopener">Open the filing (PDF)</a>` : ""}
      <span class="dim">${esc(d.source)} · ${istStamp(d.ts)} IST${d.category && d.category !== d.title ? ` · ${esc(d.category)}` : ""}</span>
    </div></div>`;
}
function newsDetail(d) {
  const why = (d.drivers || []).map((e) => e.why).filter(Boolean);
  const exp = (d.exposure || []).map((x) => `<div class="ex">
      <div class="ex-h"><span>${esc(x.sector)}</span><span class="${x.effect > 0 ? "up" : "down"}">${x.effect > 0 ? "▲ gains" : "▼ hurt"}</span></div>
      <div class="ex-s">${x.stocks.map((s) => `<span>${esc(s.symbol)} <span class="${dirCls(s.chg)}">${s.chg == null ? "" : pct(s.chg)}</span></span>`).join("")}</div>
    </div>`).join("");
  return `<div class="why">
    ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
    ${why.length ? `<div class="eyebrow">Why it matters today</div>${why.map((w) => `<p>${esc(w)}</p>`).join("")}` : ""}
    ${exp ? `<div class="eyebrow">Who is exposed</div><div class="grid">${exp}</div>` : ""}
    ${stockList(d.stocks)}
    <div class="why-links">
      ${d.link ? `<a href="${esc(d.link)}" target="_blank" rel="noopener">Open the original story</a>` : ""}
      <span class="dim">${esc(d.source)} · ${istStamp(d.ts)} IST</span>
    </div></div>`;
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
const LEVELS = ["critical", "high", "stock", "filing", "event", "vix", "watch"];
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
  const unread = isUnread(al), name = LEVEL_NAME[al.level] || al.level;
  return `<li class="al${unread ? " unread" : ""}${fresh ? " fresh" : ""}" data-alert="${al.id}" tabindex="0" role="button"
      aria-label="${esc((unread ? "Unread. " : "") + name + ": " + al.title)}">
    <span class="pip ${esc(al.level)}" aria-hidden="true"></span>
    <span><span class="t">${esc(al.title)}</span><br><span class="m">${esc(name)}</span></span>
    <span class="when">${istStamp(al.ts)}</span>
    ${al.body ? `<div class="b">${esc(al.body)}</div>` : ""}
  </li>`;
}
function renderAlerts(freshIds = new Set()) {
  const items = S.alerts;
  const none = `<li class="empty">No alerts yet. They appear for market-wide shocks, stock catalysts, scheduled releases, VIX spikes and watchlist news.</li>`;
  $("#alertsMini").innerHTML = items.length ? items.slice(0, 5).map((a) => alertItem(a, freshIds.has(a.id))).join("") : none;
  $("#alertLog").innerHTML = items.length ? items.map((a) => alertItem(a, freshIds.has(a.id))).join("") : none;
  $("#notifList").innerHTML = items.length ? items.slice(0, 40).map((a) => alertItem(a, freshIds.has(a.id))).join("") : none;
  const unread = items.filter(isUnread).length;
  const c = $("#alertCount"); c.hidden = !unread; c.textContent = unread > 99 ? "99+" : unread;
  $("#alertBtn").setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications");
  $("#markAllRead").disabled = !unread;
  $("#notifSummary").textContent = unread ? `${unread} unread` : "All caught up";
  document.title = unread ? `(${unread}) NSE Wire` : "NSE Wire";
}

function openAlert(al) {
  if (!al) return;
  markRead(al);
  closePanel();
  if (al.article_id && (al.kind === "filing" || al.kind === "news")) { openItem(al.kind, al.article_id); return; }
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
  $("#notifyNote").textContent = note + (S.muted ? " Sound is muted with the speaker button in the top bar." : "");
}

/* ------------------------------------------------------------------ watchlist */
function renderWatch() {
  $("#watchList").innerHTML = S.watch.length
    ? S.watch.map((s) => `<li>${esc(s)}<button data-remove="${esc(s)}" aria-label="Remove ${esc(s)}">×</button></li>`).join("")
    : `<li class="empty">No stocks yet.</li>`;
}
async function saveWatch(list) {
  const r = await api("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: list }) });
  S.watch = r.symbols; renderWatch();
  S.cache.clear();
  renderFeed();
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
  renderStatus();
  tickNext();
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
  if (e.target.closest(".why")) return; // clicks inside an opened story (links, text selection) don't close it
  const row = e.target.closest("#feedList .row[data-id]");
  if (row && !e.target.closest("a")) {
    if (row.classList.contains("open")) closeOpen(); else expand(row, row.dataset.type, row.dataset.id);
  }
});
document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (e.key === "Escape") { if (panelOpen()) closePanel(); else if (S.open) closeOpen(); else $("#banner").hidden = true; return; }
  if (e.key === "Enter" && document.activeElement?.matches("[data-alert]")) { openAlert(alertById(document.activeElement.dataset.alert)); return; }
  if (typing) return;
  if (e.key === "/") { e.preventDefault(); showView("desk"); $("#feedSearch").focus(); return; }
  const views = ["desk", "alerts", "system"];
  if (/^[1-3]$/.test(e.key)) { showView(views[Number(e.key) - 1]); return; }
  if (e.key === "Enter" && document.activeElement?.matches(".row[data-id]")) {
    const r = document.activeElement;
    if (r.classList.contains("open")) closeOpen(); else expand(r, r.dataset.type, r.dataset.id);
    return;
  }
  if (e.key === "j" || e.key === "k") {
    const rows = $$("#feedList .row[data-id]"); if (!rows.length) return;
    let i = rows.findIndex((r) => r.dataset.id === S.open?.id);
    i = e.key === "j" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    expand(rows[i], rows[i].dataset.type, rows[i].dataset.id); rows[i].focus({ preventScroll: true });
  }
});
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
function paintSound() {
  soundBtn.setAttribute("aria-pressed", String(!S.muted));
  soundBtn.setAttribute("aria-label", S.muted ? "Alert sound off" : "Alert sound on");
  soundBtn.title = S.muted ? "Alert sound off" : "Alert sound on";
}
soundBtn.onclick = () => { S.muted = !S.muted; try { localStorage.setItem("muted", S.muted ? "1" : "0"); } catch {} paintSound(); if (!S.muted) beep("high"); renderPrefs(); };
paintSound();
$("#feedFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]"); if (!b) return;
  S.filter = b.dataset.f; $$("#feedFilter button").forEach((x) => x.classList.toggle("on", x === b));
  try { localStorage.setItem("filter", S.filter); } catch {}
  renderFeed();
});
let tmr;
const debounce = (fn) => () => { clearTimeout(tmr); tmr = setTimeout(() => fn().catch(() => {}), 250); };
$("#feedSearch").addEventListener("input", debounce(loadFeed));
$("#feedSearch").addEventListener("focus", () => showView("desk"));
$("#feedWindow").addEventListener("change", () => loadFeed().catch(() => {}));
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
    if (f != null && f in FILTERS) { S.filter = f; $$("#feedFilter button").forEach((x) => x.classList.toggle("on", x.dataset.f === f)); }
  } catch {}
  tickClock(); setInterval(tickClock, 1000);
  await loadDesk().catch(() => {});
  await Promise.allSettled([loadFeed(), pollAlerts(true)]);
  api("/api/watchlist").then((w) => { $("#knownSymbols").innerHTML = w.known.map((s) => `<option value="${esc(s)}">`).join(""); }).catch(() => {});
  setInterval(() => pollAlerts().catch(() => {}), 15000);
  setInterval(() => loadFeed().catch(() => {}), 20000);
  setInterval(() => loadDesk().catch(() => {}), 30000);
  setInterval(() => renderStatus(), 5000);
})();
