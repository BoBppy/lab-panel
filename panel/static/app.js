"use strict";
// Lab server console (no external dependencies). Visible text goes through _() from i18n.js; English is the source.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const GiB = 1024 ** 3;
const LOC = I18N.locale;
const fmtB = (b) => b == null ? "–" : b >= 1024 ** 4 ? (b / 1024 ** 4).toFixed(2) + " TB" : b >= GiB ? (b / GiB).toFixed(b >= 100 * GiB ? 0 : 1) + " GB" : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(0) + " MB" : b > 0 ? (b / 1024).toFixed(0) + " KB" : "0";
const fmtN = (n) => n == null ? "–" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : Math.round(n).toLocaleString(LOC);
const hrs = (h) => !h ? _("{n} h", { n: 0 }) : h < 0.1 ? _("{n} min", { n: Math.round(h * 60) }) : _("{n} h", { n: h < 10 ? h.toFixed(1) : Math.round(h) });
const fmtT = (ts) => ts ? new Date(ts * 1000).toLocaleString(LOC, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
const ago = (ts) => { if (!ts) return _("never"); const s = Date.now() / 1000 - ts; if (s < 90) return _("just now"); if (s < 5400) return _("{n} min ago", { n: Math.round(s / 60) }); if (s < 129600) return _("{n} h ago", { n: Math.round(s / 3600) }); return _("{n} days ago", { n: Math.round(s / 86400) }); };
const memStr = (m) => { if (!m) return _("no memory limit"); const n = parseInt(m); return _("{n} GB memory", { n: m.endsWith("g") ? n : (n / 1024).toFixed(1) }); };
const gb = (mib) => (mib / 1024).toFixed(1) + " GB";
const cores = (n) => _("{n} cores", { n });
const FSN = {};   // filesystem path -> disk label, filled from /api/me
const ROLE = () => ({ owner: _("owner"), admin: _("admin"), viewer: _("viewer") });
// Disk names the server makes up ("NVMe SSD, 916 GB") are translated; names someone typed are shown as they are.
const KIND = () => ({ "NVMe SSD": _("NVMe SSD"), SSD: "SSD", "Hard disk": _("Hard disk"), "USB disk": _("USB disk"), "Virtual disk": _("Virtual disk"), "Network storage": _("Network storage"), Disk: _("Disk") });
const baseName = (v) => v.replace(/^(.*) \((.*)\)$/, (m, l, p) => `${diskName(l)} (${p})`);
const diskName = (label) => { const m = /^(.+?), ([\d.]+ [KMGTP]?B)$/.exec(label || ""); return m && KIND()[m[1]] ? KIND()[m[1]] + _(", ") + m[2] : label; };
// lab name and logo: sign-in card, sidebar, browser tab
const MARK = $(".brand .mark").innerHTML, ICON = $('link[rel="icon"]').href;
const markHTML = (logo) => logo ? `<img src="${esc(logo)}" alt="">` : MARK;
function applyBrand(b) {
  document.title = _("{org} server", { org: b.org });
  $$(".login-card h1, .side .brand b").forEach((x) => (x.textContent = b.org));
  if (b.subtitle) $("#hostName").textContent = b.subtitle_custom || _("{host} server", { host: b.subtitle_default.replace(/ server$/, "") });
  $$(".login-card .mark, .side .brand .mark").forEach((m) => { m.classList.toggle("logo", !!b.logo); m.innerHTML = markHTML(b.logo); });
  $('link[rel="icon"]').href = b.logo || ICON;
}
const PALETTE = ["--p2", "--p3", "--p4", "--p5", "--p6"];

let PREFS = { mode: "auto", scheme: "pine", font: "field", lang: "auto", refresh: 5 }, LAST = 0;
let ME = null, TAB = "overview", OV = null, USERS = [], timer = null, ENG = null, ENG_RENDERED = false;

async function api(method, path, body) {
  const r = await fetch("/api/" + path, { method, credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-RL": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = {};
  try { d = await r.json(); } catch (e) { /* empty body */ }
  if (r.status === 401 && !d.need_code) { showLogin(); throw new Error(_("Your session ended. Sign in again.")); }
  if (!r.ok) { const err = new Error(_s(d.error || r.statusText)); err.data = d; throw err; }
  return d;
}
function toast(msg, bad) {
  const d = document.createElement("div"); d.textContent = msg; if (bad) d.className = "bad";
  $("#toast").appendChild(d); setTimeout(() => d.remove(), bad ? 8000 : 3500);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg); return r; }
  catch (e) { toast(e.message, true); throw e; }
}
// A note the server adds after a change ("rebuild the container to apply") is English; translate it when we know it.
const noteText = (r) => r.note ? I18N.space + _s(r.note[0].toUpperCase() + r.note.slice(1)) + (/[.!]$/.test(r.note) ? "" : ".") : "";

// ------------------------------------------------------------------ small renderers
function spark(vals, max, color = "var(--p1)") {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return '<svg viewBox="0 0 200 30"></svg>';
  const m = max || Math.max(...v, 1), n = vals.length, W = 200, H = 30;
  const pts = vals.map((x, i) => [(i / (n - 1)) * W, H - 2 - ((x ?? 0) / m) * (H - 4)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d} L${W} ${H} L0 ${H} Z" fill="${color}" opacity=".13"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
function bars(days, keys, colors, labels, o = {}) {
  const unit = o.unit ?? _("tokens"), fmt = o.fmt || fmtN;
  if (!days.some((d) => keys.some((k) => d[k]))) return `<p class="empty" style="padding:4px 0">${esc(o.empty || _("No requests in the last 30 days."))}</p>`;
  const W = 900, H = 170, pad = 30, bw = (W - pad) / days.length;
  const tot = days.map((d) => keys.reduce((s, k) => s + (d[k] || 0), 0)), m = Math.max(...tot, 1);
  let g = `<line x1="${pad}" x2="${W}" y1="${H - 18}" y2="${H - 18}" stroke="var(--rule)"/>`;
  days.forEach((d, i) => {
    let y = H - 18;
    keys.forEach((k, j) => {
      const h = ((d[k] || 0) / m) * (H - 34);
      y -= h;
      if (h > 0) g += `<rect x="${pad + i * bw + 2}" y="${y.toFixed(1)}" width="${Math.max(2, bw - 4).toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[j]}" rx="1.5"><title>${esc(d.d)}: ${fmt(d[k])} ${esc(labels[j])} ${esc(unit)}</title></rect>`;
    });
    if (i % 5 === 0 || i === days.length - 1) g += `<text x="${pad + i * bw + bw / 2}" y="${H - 3}" text-anchor="middle">${esc(new Date(d.d + "T00:00").toLocaleDateString(LOC, { month: "short", day: "numeric" }))}</text>`;
  });
  g += `<text x="0" y="12">${fmt(m)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${esc(o.aria || _("Tokens per day"))}">${g}</svg><div class="legend">${labels.map((l, j) => `<span><i style="background:${colors[j]}"></i>${esc(l)}</span>`).join("")}</div>`;
}
function meter(used, total, label, note) {
  const p = total ? Math.min(100, (100 * used) / total) : 0;
  const cls = p > 90 ? "bad" : p > 75 ? "warn" : "";
  return `<div class="meter"><div class="t">${label}${note ? `<span class="sub">${note}</span>` : ""}</div><div class="bar ${cls}"><i style="width:${p.toFixed(1)}%"></i></div></div>`;
}
function pill(state, disabled) {
  if (disabled) return `<span class="pill bad">${_("Disabled")}</span>`;
  const m = { running: ["ok", _("Running")], exited: ["warn", _("Stopped")], created: ["warn", _("Created")], paused: ["warn", _("Paused")], restarting: ["warn", _("Restarting")], none: ["", _("Not created yet")] };
  const [c, label] = m[state] || ["", state || "–"];
  return `<span class="pill ${c}">${esc(label)}</span>`;
}
const diskTotal = (d) => !d ? null : d.fs ? Object.values(d.fs).reduce((a, x) => a + x.used, 0) : d.at ? Object.entries(d).reduce((a, [k, v]) => a + (k !== "at" && typeof v === "number" ? v : 0), 0) : null;
const limitsText = (e) => [memStr(e.MEMORY), e.CPUS ? _("{n} CPUs", { n: e.CPUS }) : _("all CPUs"), e.CPUSET ? _("pinned to {cpus}", { cpus: e.CPUSET }) : "", e.GPU === "none" ? _("no GPU") : "GPU"].filter(Boolean).join(_(", "));

// ------------------------------------------------------------------ login / navigation
function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); clearTimeout(timer); }
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#loginErr").textContent = "";
  try { await api("POST", "login", { user: f.get("user"), password: f.get("password"), code: f.get("code") || undefined }); start(); }
  catch (err) { if (err.data?.need_code) { $("#codeRow").classList.remove("hidden"); $("#loginForm [name=code]").focus(); } $("#loginErr").textContent = err.message; }
});
$("#logoutBtn").addEventListener("click", async () => { await api("POST", "logout", {}).catch(() => {}); location.reload(); });
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) show(b.dataset.tab); });
// language on the sign-in page, before anyone has an account preference
function renderLoginLang() {
  $("#loginLang").innerHTML = I18N.langs.filter(([v]) => v !== "auto").map(([v, n]) =>
    `<button type="button" data-lang="${v}" lang="${{ zh: "zh-CN" }[v] || v}" aria-current="${v === I18N.lang}">${n}</button>`).join("");
}
$("#loginLang").addEventListener("click", (e) => { const b = e.target.closest("[data-lang]"); if (b && b.dataset.lang !== I18N.lang) { window.labLook({ lang: b.dataset.lang }); location.reload(); } });

async function start() {
  try { ME = await api("GET", "me"); } catch (e) { return; }
  PREFS = ME.prefs || PREFS;
  if (window.labLook(PREFS) !== I18N.lang) return location.reload();     // this account reads another language
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#adminName").textContent = ME.user + _(", ") + (ROLE()[ME.role] || ME.role);
  applyBrand(ME);
  $("#sideMode").innerHTML = modeSwitch("sideModeR");
  ME.storage.forEach((d) => (FSN[d.path] = d.label));
  api("GET", "system/updates").then((u) => ($("#updCount").textContent = u.upgradable.length || "")).catch(() => {});
  $$(".hostip").forEach((x) => (x.textContent = location.hostname));
  keepPort();
  show(TAB);
}
// ------------------------------------------------------------------ refreshing: on a timer the person chooses, or by hand
// The next refresh is planned when the last one finishes, so the ring around the button fills exactly once per wait.
function schedule() {
  clearTimeout(timer);
  const ring = $("#refreshBtn"), auto = PREFS.refresh && TAB !== "settings";
  ring.classList.remove("run");
  if (auto) {
    ring.style.setProperty("--every", PREFS.refresh + "s");
    void ring.offsetWidth;                // restart the fill animation
    ring.classList.add("run");
    timer = setTimeout(() => (document.hidden || $("#dlg").open ? schedule() : refresh().finally(schedule)), PREFS.refresh * 1000);
  }
  noteRefresh();
}
function noteRefresh() {
  $("#refreshTime").textContent = LAST ? new Date(LAST).toLocaleTimeString(LOC, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–";
  $("#refreshEvery").textContent = TAB === "settings" ? _("Paused here") : !PREFS.refresh ? _("Manual")
    : PREFS.refresh < 60 ? _("Every {n} s", { n: PREFS.refresh }) : _("Every minute");
  const why = TAB === "settings" ? _("Settings never refresh on their own, so nothing you type is lost.") : !PREFS.refresh ? _("Automatic refresh is off.") : "";
  $("#refreshBtn").title = (LAST ? _("Updated at {time}. Refresh now (R)", { time: $("#refreshTime").textContent }) : _("Refresh now (R)")) + (why ? I18N.space + why : "");
}
async function refreshNow() {
  const b = $("#refreshBtn");
  if (b.classList.contains("busy")) return;
  b.classList.add("busy");
  try { await reload(); } finally { b.classList.remove("busy"); schedule(); }
}
$("#refreshBtn").addEventListener("click", refreshNow);
document.addEventListener("keydown", (e) => {
  if (e.key !== "r" || e.ctrlKey || e.metaKey || e.altKey || $("#app").classList.contains("hidden") || $("#dlg").open) return;
  if (e.target.closest("input, textarea, select, [contenteditable]")) return;
  e.preventDefault(); refreshNow();
});
function show(tab) {
  TAB = tab;
  if (tab === "llm") ENG_RENDERED = false;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$("main > section").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + tab));
  reload().finally(schedule);
}
// redraw the current tab now (after an action or the Refresh button); the timer uses refresh(), which leaves Settings alone
function reload() { return TAB === "settings" ? loadSettings().then(stamp, () => {}) : refresh(); }
// Settings holds forms only and is not redrawn on the timer, so nothing typed there is lost; jobs poll their own logs.
function refresh() {
  if (TAB === "settings") return Promise.resolve();
  return ({ overview: loadOverview, users: loadUsers, llm: loadLLM, audit: loadAudit })[TAB]().then(stamp, () => {});
}
function stamp() { LAST = Date.now(); noteRefresh(); }

// ------------------------------------------------------------------ light / automatic / dark switch (sidebar and Settings)
const MODE_ICON = {
  light: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1"/></svg>',
  auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4"/><path class="solid" d="M8 2.6a5.4 5.4 0 0 1 0 10.8z"/></svg>',
  dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3z"/></svg>',
};
const MODES = () => [["light", _("Light")], ["auto", _("Automatic")], ["dark", _("Dark")]];
function modeSwitch(name) {
  return `<div class="mode-switch" role="radiogroup" aria-label="${esc(_("Light or dark"))}">${MODES().map(([v, n]) =>
    `<label title="${esc(n)}"><input type="radio" name="${name}" value="${v}" data-mode-pick ${PREFS.mode === v ? "checked" : ""} aria-label="${esc(n)}">${MODE_ICON[v]}</label>`).join("")}</div>`;
}
document.addEventListener("change", (e) => { if (e.target.matches("[data-mode-pick]")) savePrefs({ mode: e.target.value }); });
// Preferences apply at once and are saved to the account; a new language needs the page loaded again.
async function savePrefs(change) {
  const before = { ...PREFS };
  Object.assign(PREFS, change);
  const lang = window.labLook(PREFS);
  $$("[data-mode-pick]").forEach((i) => (i.checked = i.value === PREFS.mode));
  schedule();
  if (TAB === "settings") loadLook(Object.keys(change)[0]);
  try {
    PREFS = await api("PUT", "me/prefs", change);
    if (lang !== I18N.lang) location.reload();
  } catch (e) {
    PREFS = before; window.labLook(PREFS); $$("[data-mode-pick]").forEach((i) => (i.checked = i.value === PREFS.mode));
    schedule(); if (TAB === "settings") loadLook(); toast(e.message, true);
  }
}

// ------------------------------------------------------------------ overview: the shared-pool ledger
function ledgerRow(name, sub, total, segs, totalText, totalSub) {
  const used = segs.reduce((a, s) => a + s.v, 0);
  const html = segs.filter((s) => s.v > 0).map((s) => {
    const w = (100 * s.v) / total;
    return `<i class="${s.light ? "light" : ""}" style="width:${w.toFixed(2)}%;background:${s.c}" title="${esc(s.n)}: ${esc(s.t)}">${w > 18 ? `<span>${esc(s.n)}</span>` : ""}</i>`;
  }).join("");
  const keys = segs.filter((s) => s.v > total * 0.001).map((s) => `<span><em style="background:${s.c}"></em>${esc(s.n)} <b>${esc(s.t)}</b></span>`).join("")
    + `<span><em style="background:var(--rule-soft);border:1px solid var(--rule)"></em>${_("free")} <b>${esc(totalSub.free)}</b></span>`;
  return `<div class="lrow"><div class="name">${name}<small>${sub}</small></div>
    <div><div class="stack" role="img" aria-label="${esc(_("{name}: {pct}% in use", { name, pct: Math.round((100 * used) / total) }))}">${html}</div><div class="keys">${keys}</div></div>
    <div class="total">${totalText}<small>${esc(totalSub.of)}</small></div></div>`;
}
function renderLedger() {
  const s = OV.sys, g = s.gpu || {}, C = OV.containers;
  const people = Object.entries(C).filter(([k, c]) => k.startsWith("lab-") && c.state === "running").map(([k, c]) => ({ name: k.slice(4), ...c }));
  const color = (i) => `var(${PALETTE[i % PALETTE.length]})`;
  const eng = C.engine || {}, LM = _("language model"), SYS = _("system");
  const gTot = g.mem_total || 1, gUsers = people.map((p, i) => ({ n: p.name, v: p.gpu_mib || 0, c: color(i), t: gb(p.gpu_mib || 0) }));
  const gKnown = (eng.gpu_mib || 0) + gUsers.reduce((a, x) => a + x.v, 0), gOther = Math.max(0, (g.mem_used || 0) - gKnown);
  const gSegs = [{ n: LM, v: eng.gpu_mib || 0, c: "var(--s-engine)", t: gb(eng.gpu_mib || 0) }, ...gUsers, { n: _("other"), v: gOther, c: "var(--s-cache)", t: gb(gOther), light: true }];
  const mTot = s.mem_total, mUsers = people.map((p, i) => ({ n: p.name, v: p.mem_anon || 0, c: color(i), t: fmtB(p.mem_anon || 0) }));
  const mKnown = (eng.mem_anon || 0) + mUsers.reduce((a, x) => a + x.v, 0), mOther = Math.max(0, s.mem_used - mKnown);
  const mSegs = [{ n: LM, v: eng.mem_anon || 0, c: "var(--s-engine)", t: fmtB(eng.mem_anon || 0) }, ...mUsers, { n: SYS, v: mOther, c: "var(--s-cache)", t: fmtB(mOther), light: true }];
  const cTot = s.ncpu, cUsers = people.map((p, i) => ({ n: p.name, v: (p.cpu || 0) / 100, c: color(i), t: cores(((p.cpu || 0) / 100).toFixed(1)) }));
  const cAll = (s.cpu / 100) * cTot, cKnown = (eng.cpu || 0) / 100 + cUsers.reduce((a, x) => a + x.v, 0), cOther = Math.max(0, cAll - cKnown);
  const cSegs = [{ n: LM, v: (eng.cpu || 0) / 100, c: "var(--s-engine)", t: cores(((eng.cpu || 0) / 100).toFixed(1)) }, ...cUsers, { n: SYS, v: cOther, c: "var(--s-cache)", t: cores(cOther.toFixed(1)), light: true }];
  $("#ledger").innerHTML =
    ledgerRow(_("GPU memory"), esc((g.name || "GPU").replace("NVIDIA ", "").replace(" Workstation Edition", "")), gTot, gSegs, gb(g.mem_used || 0), { of: _("of {total}", { total: gb(gTot) }), free: gb(Math.max(0, gTot - (g.mem_used || 0))) }) +
    ledgerRow(_("Memory"), _("shared; limits are caps, not reservations"), mTot, mSegs, fmtB(s.mem_used), { of: _("of {total}", { total: fmtB(mTot) }), free: fmtB(mTot - s.mem_used) }) +
    ledgerRow("CPU", cpuSummary(), cTot, cSegs, cAll.toFixed(1), { of: _("of {n} cores busy", { n: cTot }), free: cores((cTot - cAll).toFixed(1)) });
}
async function loadOverview() {
  OV = await api("GET", "overview");
  const s = OV.sys, g = s.gpu || {}, h = OV.hist, col = (i) => h.map((r) => r[i]);
  $("#userCount").textContent = OV.users.length || "";
  renderLedger();
  const up = s.uptime / 86400;
  const every = !PREFS.refresh ? _("Readings refresh when you press Refresh.") : PREFS.refresh >= 60 ? _("Readings refresh every minute.") : _("Readings refresh every {n} seconds.", { n: PREFS.refresh });
  $("#ovLede").textContent = every + I18N.space + (up >= 1 ? _("Up {n} days since the last restart.", { n: up.toFixed(1) }) : _("Up {n} hours since the last restart.", { n: (s.uptime / 3600).toFixed(1) }));
  $("#tiles").innerHTML = [
    [_("GPU load"), `${g.util ?? 0}<small>%</small>`, _("{temp} °C, fan {fan}%", { temp: g.temp ?? "–", fan: g.fan ?? "–" }), spark(col(3), 100, "var(--p2)")],
    [_("GPU power"), `${g.power != null ? g.power.toFixed(0) : "–"}<small>W</small>`, _("limit {n} W", { n: g.power_limit?.toFixed(0) ?? "–" }), spark(col(5), g.power_limit, "var(--p6)")],
    ["CPU", `${(s.cpu ?? 0).toFixed(0)}<small>%</small>`, _("load {n} over 1 min", { n: s.load?.[0] ?? "–" }), spark(col(1), 100, "var(--p1)")],
    [_("Memory in use"), `${(100 * s.mem_used / s.mem_total).toFixed(0)}<small>%</small>`, _("swap {size} used", { size: fmtB(s.swap_used) }), spark(col(2), 100, "var(--p3)")],
  ].map(([k, v, sub, sv]) => `<div class="reading"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${esc(sub)}</div>${sv}</div>`).join("");
  $("#strataPill").innerHTML = enginePill(OV.strata, OV.containers.engine);
  $("#strataBox").innerHTML = engineSummary(OV.strata, OV.containers.engine);
  $("#diskBox").innerHTML = (s.disks || []).filter((d) => d.total).map((d) =>
    `<div class="disk">${meter(d.used, d.total, `<b>${esc(diskName(FSN[d.path] || d.label))}</b> <span class="sub">${esc(d.path)}</span>`, esc(_("{used} of {total}", { used: fmtB(d.used), total: fmtB(d.total) })))}
      ${d.model ? `<span class="model" title="${esc(d.model)}">${esc(d.model)}</span>` : ""}</div>`).join("");
  const rows = OV.users.map((u) => {
    const c = u.container || {}, run = c.state === "running";
    return `<tr class="click" data-user="${esc(u.name)}"><td class="who"><b>${esc(u.name)}</b><small>${esc(u.full_name)}</small></td><td>${pill(c.state, u.disabled)}</td>
      <td class="num">${run ? cores(((c.cpu ?? 0) / 100).toFixed(1)) : "–"}</td>
      <td>${run ? meter(c.mem, c.mem_limit || s.mem_total, fmtB(c.mem), c.mem_limit ? esc(_("of {total}", { total: fmtB(c.mem_limit) })) : "") : "–"}</td>
      <td class="num">${c.gpu_mib ? gb(c.gpu_mib) : "–"}</td>
      <td class="num">${fmtN(u.llm_today.prompt + u.llm_today.completion)}${u.daily_tokens ? ` <span class="sub">${esc(_("of {total}", { total: fmtN(u.daily_tokens) }))}</span>` : ""}</td>
      <td>${ago(u.last_login)}</td></tr>`;
  });
  $("#usageTable").innerHTML = `<thead><tr><th>${_("Person")}</th><th>${_("Container")}</th><th class="num">CPU</th><th>${_("Memory")}</th><th class="num">${_("GPU memory")}</th><th class="num">${_("Model tokens today")}</th><th>${_("Last sign-in")}</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="7" class="empty">${_("Nobody has an account yet. Add people on the People page.")}</td></tr>`}</tbody>`;
}
function enginePill(st, cont) {
  if (!cont || cont.state !== "running") return `<span class="pill bad">${_("Stopped")}</span>`;
  if (!st.reachable) return `<span class="pill warn">${_("Loading")}</span>`;
  return st.running ? `<span class="pill ok">${_("Answering {n} of {total}", { n: st.running, total: st.parallel })}</span>` : `<span class="pill ok">${_("Ready")}</span>`;
}
function engineSummary(st, cont) {
  if (!st.reachable) return `<p class="sub" style="margin:0">${cont && cont.state === "running" ? _("The model is loading. This takes one to two minutes after a start.") : _("The engine is stopped. Start it on the Language model page.")}</p>`;
  const slots = (st.slots || []).map((x, i) => {
    const busy = x.state && x.state !== "idle";
    const what = x.state === "reading" && x.prompt_total ? _("reading {n} of {total}", { n: fmtN(x.prompt_read), total: fmtN(x.prompt_total) }) : busy ? `${esc(x.state)}${x.tok_s ? `, ${x.tok_s.toFixed(0)} tok/s` : ""}` : _("free");
    return `<div class="slot ${busy ? "busy" : ""}"><b>${_("Slot {n}", { n: i + 1 })}</b>${what}</div>`;
  }).join("");
  const last = (st.recent || []).filter((r) => r.decode_tok_s).slice(-1)[0];
  return `<dl class="kv"><dt>${_("Model")}</dt><dd>${esc(st.model)}</dd>
    <dt>${_("Context")}</dt><dd>${_("{n} tokens per request", { n: fmtN(st.context) })}${st.kv ? esc(_(", {kv} cache", { kv: st.kv })) : ""}</dd>
    <dt>${_("Engine")}</dt><dd>${st.engine === "custom" ? _("custom image") : esc(_("Strata engine {version}, {drafting} drafting", { version: st.engine, drafting: st.drafting }))}</dd>
    <dt>${_("Queue")}</dt><dd>${_("{n} answering, {m} waiting", { n: st.running || 0, m: st.waiting || 0 })}</dd>
    <dt>${_("Last answer")}</dt><dd>${last ? _("{speed} tokens/s over {n} tokens", { speed: last.decode_tok_s.toFixed(0), n: fmtN(last.output) }) : "–"}</dd></dl>${slots ? `<div class="slots">${slots}</div>` : ""}`;
}
$("#usageTable").addEventListener("click", (e) => { const r = e.target.closest("tr[data-user]"); if (r) openUser(r.dataset.user); });

// ------------------------------------------------------------------ people
async function loadUsers() { USERS = await api("GET", "users"); $("#userCount").textContent = USERS.length || ""; renderUsers(); }
function renderUsers() {
  const q = $("#userFilter").value.trim().toLowerCase();
  const list = USERS.filter((u) => !q || (u.name + " " + u.full_name + " " + u.email).toLowerCase().includes(q));
  const of = (x) => ` <span class="sub">${esc(_("of {total}", { total: x }))}</span>`;
  const rows = list.map((u) => {
    const c = u.container || {}, d = u.disk || {}, run = c.state === "running", dt = diskTotal(d);
    return `<tr class="click" data-user="${esc(u.name)}">
      <td class="who"><b>${esc(u.name)}</b><small>${esc(u.full_name || u.email || "")}</small></td>
      <td>${pill(c.state, u.disabled)}</td>
      <td class="sub">${esc(limitsText(u.effective))}</td>
      <td class="num">${run ? ((c.cpu ?? 0) / 100).toFixed(1) : "–"}</td>
      <td class="num">${run ? fmtB(c.mem) : "–"}</td>
      <td class="num">${c.gpu_mib ? gb(c.gpu_mib) : "–"}</td>
      <td class="num">${u.gpu_30d?.held_h ? `${hrs(u.gpu_30d.busy_h)}${of(hrs(u.gpu_30d.held_h))}` : "–"}</td>
      <td class="num">${dt != null ? fmtB(dt) : "…"}</td>
      <td class="sub">${esc(diskName(FSN[u.home_fs] || ""))}</td>
      <td class="num">${u.llm_enabled ? fmtN(u.llm_today.prompt + u.llm_today.completion) + (u.daily_tokens ? of(fmtN(u.daily_tokens)) : "") : `<span class="sub">${_("off")}</span>`}</td>
      <td>${ago(u.last_login)}</td></tr>`;
  });
  $("#usersTable").innerHTML = `<thead><tr><th>${_("Person")}</th><th>${_("Container")}</th><th>${_("Limits")}</th><th class="num">${_("CPU cores")}</th><th class="num">${_("Memory")}</th><th class="num">${_("GPU memory")}</th><th class="num" title="${esc(_("Hours the GPU spent computing for them, of the hours they held GPU memory, over 30 days"))}">${_("GPU time, 30 days")}</th><th class="num">${_("Disk used")}</th><th>${_("Home on")}</th><th class="num">${_("Model tokens today")}</th><th>${_("Last sign-in")}</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="11" class="empty">${USERS.length ? _("Nobody matches that search.") : _("No accounts yet. Add the first person with “Add person”.")}</td></tr>`}</tbody>`;
}
$("#userFilter").addEventListener("input", renderUsers);
$("#usersTable").addEventListener("click", (e) => { const r = e.target.closest("tr[data-user]"); if (r) openUser(r.dataset.user); });

function dialog(html, kind = "drawer") { const d = $("#dlg"); d.className = kind; $("#dlgBody").innerHTML = html; if (!d.open) d.showModal(); return d; }
function closeDlg() { $("#dlg").close(); if (ME && !$("#app").classList.contains("hidden")) reload(); }
$("#dlg").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === $("#dlg")) closeDlg(); });
const closeX = () => `<button class="x" data-close aria-label="${esc(_("Close"))}">×</button>`;

function randomPw() {
  const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = new Uint32Array(14);
  crypto.getRandomValues(b); return [...b].map((x) => a[x % a.length]).join("");
}
const coreKind = (k) => ({ performance: _("performance"), efficiency: _("efficiency") }[k] || k);
const cpuHint = () => (ME.cpu.groups.length > 1 ? ME.cpu.groups.map((g) => _("{cpus} are {kind} cores", { cpus: g.cpus, kind: coreKind(g.kind) })).join(_(", ")) + _(". ") : _("CPUs 0-{n}. ", { n: ME.ncpu - 1 })) + _("Leave empty for any.");
const cpuSummary = () => cores(ME.cpu.ncpu) + (ME.cpu.groups.length > 1 ? ": " + ME.cpu.groups.map((g) => `${g.count} ${coreKind(g.kind)}`).join(_(", ")) : "");
// One row per disk: can the person use it (their data folder is mounted), and how much space may they fill there.
// The limit stays editable when the disk holds their home folder or container system files, even without data access.
function storageRows(st) {
  const rows = ME.storage.map((d) => {
    const sys = ME.container_fs === d.path, quota = (ME.quota_fs || []).includes(d.path);
    const access = d.data ? st.data.includes(d.data) : false, lim = st.quotas?.[d.path] ?? 0;
    const why = [sys && _("container system files"), d.data && _("data folder {path}", { path: `${d.data}/${st.name || _("name")}` })].filter(Boolean).join(_(", "));
    return `<div class="disk-row" data-path="${esc(d.path)}" data-homes="${esc(d.homes || "")}">
      <div title="${esc(d.model || "")}"><b>${esc(diskName(d.label))}</b> <span class="sub">${esc(d.path)}</span><div class="hint"><span class="homehere">${_("home folder")}${why ? _(", ") : ""}</span>${esc(why)}</div></div>
      <label class="check">${d.data ? `<input type="checkbox" class="acc" data-root="${esc(d.data)}" ${access ? "checked" : ""}> ${_("Data folder")}` : `<span class="sub">${_("no data folder")}</span>`}</label>
      ${quota ? `<span class="inline lim"><input type="number" min="1" class="cap" value="${lim || ""}" placeholder="GB" aria-label="${esc(_("Limit in GB on {path}", { path: d.path }))}"><label class="check"><input type="checkbox" class="unl" ${lim ? "" : "checked"}> ${_("No limit")}</label></span>` : `<span class="sub">${_("no disk accounting")}</span>`}
    </div>`;
  }).join("");
  return `<div class="disks">${rows}</div>`;
}
function wireStorage(root, getHomeBase) {
  const sync = () => $$(".disk-row", root).forEach((r) => {
    const home = !!(r.dataset.homes && getHomeBase() === r.dataset.homes);
    const sys = ME.container_fs === r.dataset.path, acc = !!$(".acc", r)?.checked;
    const usable = home || sys || acc, cap = $(".cap", r), unl = $(".unl", r);
    $(".homehere", r).classList.toggle("hidden", !home);
    r.classList.toggle("off", !usable);
    if (!cap) return;
    unl.disabled = !usable; cap.disabled = !usable || unl.checked;
  });
  root.addEventListener("change", sync); sync();
  return sync;
}
function readStorage(root) {
  const data = $$(".acc", root).filter((x) => x.checked).map((x) => x.dataset.root), quotas = {};
  $$(".disk-row", root).forEach((r) => { const cap = $(".cap", r); if (cap) quotas[r.dataset.path] = $(".unl", r).checked || cap.disabled ? 0 : +cap.value || 0; });
  return { data: data.length ? data.join(",") : "none", quotas };
}

$("#addUserBtn").addEventListener("click", () => {
  dialog(`<div class="dlg-h"><div><h2>${_("Add a person")}</h2><p class="sub">${_("They can sign in as soon as you save. Their container is created at the first sign-in.")}</p></div>${closeX()}</div>
  <form id="addForm"><div class="dlg-b"><div class="form">
    <div class="form-sec">${_("Account")}</div>
    <label>${_("User name")}<input name="name" required pattern="[a-z_][a-z0-9_\\-]{0,31}" placeholder="jsmith" autocomplete="off"><span class="hint">${_("lowercase letters, digits, - and _")}</span></label>
    <label>${_("Full name")}<input name="full_name"></label>
    <label>${_("Email")}<input name="email" type="email"></label>
    <label>${_("Password")}<span class="inline"><input name="password" minlength="8" autocomplete="new-password" placeholder="${esc(_("at least 8 characters"))}"><button type="button" class="btn sm" id="genPw">${_("Generate")}</button></span></label>
    <label class="full">${_("SSH public key")}<textarea name="pubkey" rows="2" placeholder="${esc(_("ssh-ed25519 AAAA… (a password, a key, or both)"))}"></textarea></label>
    <label class="full">${_("Note")}<input name="note" placeholder="${esc(_("project, advisor, end date"))}"></label>
    <div class="form-sec">${_("Resources")}</div>
    <label>${_("Memory limit")}<input name="memory" placeholder="${esc(memStr(USERS[0]?.effective.MEMORY || "24g"))}" pattern="[0-9]+[mg]"><span class="hint">${_("a cap such as 32g; nothing is reserved up front")}</span></label>
    <label>${_("CPU limit")}<input name="cpus" placeholder="${esc(_("no limit"))}" pattern="[0-9.]+"><span class="hint">${_("cores' worth of time, such as 8")}</span></label>
    <label>${_("Pin to CPUs")}<input name="cpuset" placeholder="${esc(_("any"))}" pattern="[0-9,\\-]+"><span class="hint">${esc(cpuHint())}</span></label>
    <label>GPU<select name="gpu"><option value="all">${_("Shared GPU")}</option><option value="none">${_("No GPU")}</option></select></label>
    <label class="check full"><input type="checkbox" name="sudo_on" ${ME.default_sudo ? "checked" : ""}> ${_("Admin rights inside their container (sudo, apt install). Without them, pip, uv and conda still work.")}</label>
    <div class="form-sec">${_("Storage")}</div>
    <label>${_("Home folder on")}<select name="home_base">${Object.entries(ME.home_bases || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(baseName(v))}</option>`).join("")}</select><span class="hint">${_("NVMe is far faster for code, environments and many small files")}</span></label>
    <span></span>
    <div class="full" id="addDisks">${storageRows({ homeBase: Object.keys(ME.home_bases)[0], data: ME.data_roots, quotas: ME.default_quota_gb })}</div>
    <div class="form-sec">${_("Language model")}</div>
    <label>${_("Tokens per day")}<input name="daily_tokens" type="number" min="0" value="0"><span class="hint">${_("0 for no limit")}</span></label>
    <label>${_("Requests at once")}<input name="concurrency" type="number" min="1" max="8" value="2"><span class="hint">${_("the engine answers {n} at once for everyone", { n: ENG?.serving?.concurrency || 4 })}</span></label>
  </div></div>
  <div class="dlg-f"><button type="button" class="btn" data-close>${_("Cancel")}</button><button class="btn primary" type="submit">${_("Add person")}</button></div></form>`, "center");
  $("#genPw").addEventListener("click", () => { const i = $("#addForm [name=password]"); i.value = randomPw(); i.type = "text"; });
  const hb = $("#addForm [name=home_base]");
  const syncDisks = wireStorage($("#addDisks"), () => hb.value);
  hb.addEventListener("change", syncDisks);
  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.daily_tokens = +f.daily_tokens || 0; f.concurrency = +f.concurrency || 2;
    Object.assign(f, readStorage($("#addDisks")));
    f.sudo = e.target.sudo_on.checked ? "yes" : "no"; delete f.sudo_on;
    if (f.gpu === "all") f.gpu = "";
    await act(() => api("POST", "users", f), _("Added {name}. They can sign in with {cmd}", { name: f.name, cmd: `ssh ${f.name}@${location.hostname}` }));
    closeDlg(); show("users");
  });
});

async function openUser(name, sub = "settings") {
  const [list, det] = await Promise.all([api("GET", "users"), api("GET", "users/" + encodeURIComponent(name))]);
  USERS = list;
  const u = list.find((x) => x.name === name);
  if (!u) return toast(_("{name} no longer exists.", { name }), true);
  const c = u.container || {}, L = u.limits, d = u.disk || {}, run = c.state === "running";
  const fsRows = Object.entries((d && d.fs) || {});
  const N = esc(name);
  const tabs = [["settings", _("Settings")], ["access", _("Sign-in and keys")], ["storage", _("Storage")], ["usage", _("Usage")], ["container", _("Container")]];
  const body = {
    settings: `<form id="editForm" class="form">
      <div class="form-sec">${_("Profile")}</div>
      <label>${_("Full name")}<input name="full_name" value="${esc(u.full_name)}"></label>
      <label>${_("Email")}<input name="email" value="${esc(u.email)}"></label>
      <label class="full">${_("Note")}<input name="note" value="${esc(u.note)}"></label>
      <div class="form-sec">${_("Resources")}</div>
      <label>${_("Memory limit")}<input name="memory" value="${esc(L.MEMORY)}" placeholder="${esc(_("default, {value}", { value: memStr(u.effective.MEMORY) }))}" pattern="[0-9]+[mg]"></label>
      <label>${_("CPU limit")}<input name="cpus" value="${esc(L.CPUS)}" placeholder="${esc(_("no limit"))}" pattern="[0-9.]+"><span class="hint">${_("cores' worth of time")}</span></label>
      <label>${_("Pin to CPUs")}<input name="cpuset" value="${esc(L.CPUSET)}" placeholder="${esc(_("any"))}" pattern="[0-9,\\-]*"><span class="hint">${esc(cpuHint())}</span></label>
      <label>GPU<select name="gpu"><option value="">${_("Shared GPU")}</option><option value="none" ${L.GPU === "none" ? "selected" : ""}>${_("No GPU")}</option></select></label>
      <label class="check full"><input type="checkbox" name="sudo_on" ${u.effective.SUDO === "yes" ? "checked" : ""}> ${_("Admin rights inside the container (sudo, apt install). Takes effect after a rebuild.")}</label>
      <div class="form-sec">${_("Language model")}</div>
      <label class="check full"><input type="checkbox" name="llm_enabled" ${u.llm_enabled ? "checked" : ""}> ${_("Can use the lab's language model")}</label>
      <label>${_("Tokens per day")}<input name="daily_tokens" type="number" min="0" value="${u.daily_tokens}"><span class="hint">${_("0 for no limit; {n} used today", { n: fmtN(u.llm_today.prompt + u.llm_today.completion) })}</span></label>
      <label>${_("Requests at once")}<input name="concurrency" type="number" min="1" max="8" value="${u.concurrency}"></label>
      <div class="full actions" style="margin-top:2px"><button class="btn primary" type="submit">${_("Save changes")}</button></div></form>
      <div class="part ${u.disabled ? "" : "danger"}"><h3>${u.disabled ? _("This account is disabled") : _("Disable the account")}</h3>
        <p class="sub">${u.disabled ? _("Sign-in and the model key are blocked. Files are kept.") : _("Blocks sign-in and the model key and stops the container. Files are kept.")}</p>
        <div><button class="btn ${u.disabled ? "primary" : "quiet-danger"}" id="toggleDis">${u.disabled ? _("Enable the account") : _("Disable the account")}</button></div></div>
      <div class="part danger"><h3>${_("Delete {name}", { name: N })}</h3>
        <label class="check"><input type="checkbox" id="purge"> ${_("Also delete their files: home folder{others}", { others: ME.data_roots.map((r) => `, ${esc(r)}/${N}`).join("") })}</label>
        <div class="inline"><input id="delConfirm" placeholder="${esc(_("Type {name} to confirm", { name }))}" aria-label="${esc(_("Type the user name to confirm"))}"><button class="btn danger" id="delBtn">${_("Delete")}</button></div></div>`,
    access: `<div class="part"><h3>${_("Password")}</h3><div class="inline"><input id="newPw" placeholder="${esc(_("new password, at least 8 characters"))}" autocomplete="new-password"><button class="btn sm" id="genPw2">${_("Generate")}</button><button id="setPw" class="btn primary">${_("Set password")}</button></div></div>
      <div class="part"><h3>${_("SSH keys")}</h3>${det.ssh_keys.length ? `<table><tbody>${det.ssh_keys.map((k) => `<tr><td>${esc(k.comment || _("no comment"))}</td><td class="sub">${esc(_("{type}, ends …{end}", { type: k.type, end: k.fingerprint }))}</td><td class="num"><button class="btn sm quiet-danger" data-rmkey="${k.index}">${_("Remove")}</button></td></tr>`).join("")}</tbody></table>` : `<p class="sub">${_("No keys yet.")}</p>`}
        <textarea id="newKey" rows="2" placeholder="ssh-ed25519 AAAA… name@laptop" aria-label="${esc(_("New SSH public key"))}"></textarea><div><button class="btn" id="addKey">${_("Add key")}</button></div></div>
      <div class="part"><h3>${_("Language model key")}</h3><p class="sub">${_("Already set as {var} in {name}'s container. From a laptop on the lab network, use {url}.", { var: "<code>$OPENAI_API_KEY</code>", name: N, url: `<code>http://${esc(location.hostname)}:${ME.gateway_port}/v1</code>` })}</p>
        <div class="inline"><code class="key" id="keyShow">${esc(u.key_prefix || "rl-")}…</code><button class="btn sm" id="showKey">${_("Show")}</button><button class="btn sm" id="copyKey">${_("Copy")}</button><button class="btn sm quiet-danger" id="regenKey">${_("Replace key")}</button></div></div>`,
    storage: `<div class="part"><dl class="kv"><dt>${_("Home folder")}</dt><dd>${_("{path} on {disk}", { path: `<code>${esc(u.home)}</code>`, disk: esc(diskName(FSN[u.home_fs] || u.home_fs)) })}</dd>
        <dt>${_("Data folders")}</dt><dd>${u.effective.DATA.length ? u.effective.DATA.map((r) => `<code>${esc(r)}/${N}</code>`).join(", ") : _("none")}</dd></dl></div>
      <div class="part"><h3>${_("Space used")}</h3>${fsRows.length ? fsRows.map(([fs, x]) => meter(x.used, x.limit || 0, `<b>${esc(fs)}</b>`, esc(x.limit ? _("{used} of {total}", { used: fmtB(x.used), total: fmtB(x.limit) }) : _("{used} used, no limit", { used: fmtB(x.used) })))).join("") : `<p class="sub">${_("Disk accounting is not available.")}</p>`}
        <p class="hint">${_("Counts every file {name} owns on that disk, including packages they install in their container.", { name: N })}</p></div>
      <form id="quotaForm" class="part"><h3>${_("Disk access and limits")}</h3>
        <div id="userDisks">${storageRows({ name, homeBase: Object.keys(ME.home_bases).find((b) => u.home.startsWith(b + "/")), data: u.effective.DATA, quotas: Object.fromEntries(fsRows.map(([fs, x]) => [fs, Math.round(x.limit / GiB)])) })}</div>
        <p class="hint">${_("A limit counts every file {name} owns on that disk. Data-folder changes take effect after a rebuild.", { name: N })}</p>
        <div><button class="btn primary" type="submit">${_("Save disk settings")}</button></div></form>
      <div class="part"><h3>${_("Move the home folder")}</h3><p class="sub">${_("Closes {name}'s sessions, copies the folder, then removes the old copy.", { name: N })}</p>
        <div class="inline"><select id="moveBase" aria-label="${esc(_("New location"))}">${Object.entries(ME.home_bases || {}).filter(([k]) => !u.home.startsWith(k + "/")).map(([k, v]) => `<option value="${esc(k)}">${esc(baseName(v))}</option>`).join("")}</select><button class="btn" id="moveBtn">${_("Move home folder")}</button></div><pre id="moveLog" class="joblog hidden"></pre></div>`,
    usage: `<div class="part"><h3>${_("GPU, last 30 days")}</h3>${bars(det.gpu_days, ["busy", "idle"], ["var(--p1)", "var(--p3)"], [_("computing"), _("holding memory, idle")], { unit: _("hours"), fmt: hrs, empty: _("No GPU use in the last 30 days."), aria: _("GPU hours per day") })}
        <p class="hint">${_("Computing counts the share of the GPU their programs kept busy, so two hours at 50% is one hour.")}${I18N.space}${(() => { const p = Math.max(0, ...det.gpu_days.map((x) => x.peak_gib)); return p ? _("Most GPU memory held at once: {n} GB.", { n: p }) : ""; })()}</p></div>
      <div class="part"><h3>${_("Language model, last 30 days")}</h3>${bars(det.usage_days, ["p", "c"], ["var(--p3)", "var(--p1)"], [_("prompt"), _("answer")])}</div>
      <div class="part"><h3>${_("Container, last hour")}</h3><div class="form">
        <div><div class="hint">${_("CPU, % of one core")}</div>${spark(det.history.map((r) => r[1]), null, "var(--p1)")}</div>
        <div><div class="hint">${_("Memory")}</div>${spark(det.history.map((r) => r[2]), null, "var(--p3)")}</div>
        <div><div class="hint">${_("GPU memory")}</div>${spark(det.history.map((r) => r[3]), null, "var(--p4)")}</div></div></div>
      <div class="part"><h3>${_("Recent requests")}</h3><div class="table-wrap tall">${reqTable(det.recent, false)}</div></div>`,
    container: `<div class="part"><dl class="kv"><dt>${_("State")}</dt><dd>${pill(c.state, u.disabled)} <span class="sub">${esc(c.status || "")}</span></dd>
        <dt>${_("Image")}</dt><dd>${esc(c.image || "–")}</dd>
        <dt>${_("Limits")}</dt><dd>${esc(limitsText(u.effective))}</dd>
        <dt>${_("Right now")}</dt><dd>${run ? esc(_("{cpu}, {mem} memory, {pids} processes, {gpu} GPU memory", { cpu: cores(((c.cpu ?? 0) / 100).toFixed(1)), mem: fmtB(c.mem), pids: c.pids, gpu: gb(c.gpu_mib) })) : "–"}</dd>
        <dt>${_("Last sign-in")}</dt><dd>${u.last_login ? fmtT(u.last_login) : _("never")}</dd></dl>
      <div class="actions"><button class="btn" data-cact="start">${_("Start")}</button><button class="btn" data-cact="restart">${_("Restart")}</button><button class="btn" data-cact="stop">${_("Stop")}</button>
        <button class="btn quiet-danger" data-cact="rebuild">${_("Rebuild")}</button></div>
      <p class="hint">${_("Rebuild recreates the container from the current image at the next sign-in, picking up image and GPU changes. Home and data folders are kept; system packages installed inside the container are not.")}</p></div>`,
  };
  dialog(`<div class="dlg-h"><div><h2>${N}</h2><p class="sub">${esc([u.full_name, u.email].filter(Boolean).join(", ") || _("No name on file"))}</p></div>${closeX()}</div>
    <div class="subtabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-sub="${k}" class="${k === sub ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="dlg-b">${body[sub]}</div>`);
  const D = $("#dlgBody"), reopen = (s = sub) => openUser(name, s), P = "users/" + encodeURIComponent(name);
  $$("[data-sub]", D).forEach((b) => b.addEventListener("click", () => openUser(name, b.dataset.sub)));
  $(".subtabs .on", D)?.scrollIntoView({ block: "nearest", inline: "nearest" });   // on phones the strip scrolls
  if (sub === "settings") {
    $("#editForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      delete f.sudo_on;
      const r = await act(() => api("PATCH", P, { ...f, sudo: e.target.sudo_on.checked ? "yes" : "no", llm_enabled: e.target.llm_enabled.checked ? 1 : 0, daily_tokens: +f.daily_tokens || 0, concurrency: +f.concurrency || 1 }),
        (r) => _("Saved.") + noteText(r));
      if (r) reopen();
    });
    $("#toggleDis").addEventListener("click", async () => { await act(() => api("PATCH", P, { disabled: !u.disabled }), u.disabled ? _("Enabled {name}.", { name }) : _("Disabled {name}.", { name })); reopen(); });
    $("#delBtn").addEventListener("click", async () => {
      if ($("#delConfirm").value !== name) return toast(_("Type {name} in the box to confirm.", { name }), true);
      await act(() => api("DELETE", P + ($("#purge").checked ? "?purge=1" : "")), _("Deleted {name}.", { name })); closeDlg();
    });
  }
  if (sub === "access") {
    $("#genPw2").addEventListener("click", () => ($("#newPw").value = randomPw()));
    $("#setPw").addEventListener("click", () => act(() => api("POST", P + "/password", { password: $("#newPw").value }), _("Password set.")));
    $("#addKey").addEventListener("click", async () => { await act(() => api("POST", P + "/keys", { pubkey: $("#newKey").value }), _("Key added.")); reopen(); });
    $$("[data-rmkey]", D).forEach((b) => b.addEventListener("click", async () => { await act(() => api("DELETE", P + "/keys/" + b.dataset.rmkey), _("Key removed.")); reopen(); }));
    let key = null;
    const getKey = async () => (key ||= (await api("GET", P + "/llm-key")).key);
    $("#showKey").addEventListener("click", async () => ($("#keyShow").textContent = await getKey()));
    $("#copyKey").addEventListener("click", async () => { const k = await getKey(); try { await navigator.clipboard.writeText(k); toast(_("Key copied.")); } catch (e) { $("#keyShow").textContent = k; toast(_("The browser blocked copying, so the key is shown instead.")); } });
    $("#regenKey").addEventListener("click", async () => {
      if (!confirm(_("Replace {name}'s key? The old key stops working right away. New shells in their container pick up the new one.", { name }))) return;
      key = (await act(() => api("POST", P + "/llm-key", {}), _("Key replaced."))).key; $("#keyShow").textContent = key;
    });
  }
  if (sub === "storage") {
    wireStorage($("#userDisks"), () => Object.keys(ME.home_bases).find((b) => u.home.startsWith(b + "/")));
    $("#quotaForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await act(() => api("PATCH", P, readStorage($("#userDisks"))), (r) => _("Disk settings saved.") + noteText(r));
      if (r) setTimeout(() => reopen(), 1200);
    });
    $("#moveBtn")?.addEventListener("click", async () => {
      const base = $("#moveBase").value;
      if (!confirm(_("Move {name}'s home folder to {path}? Their sessions close while it copies.", { name, path: `${base}/${name}` }))) return;
      await act(() => api("POST", "storage/move-home", { user: name, base }), _("Moving the home folder…"));
      const log = $("#moveLog"); log.classList.remove("hidden");
      const poll = setInterval(async () => {
        const j = (await api("GET", "jobs"))[0];
        if (j) log.textContent = j.log.join("\n");
        if (!j || j.state !== "running") { clearInterval(poll); toast(j && j.state === "done" ? _("Home folder moved.") : _("The move failed. See the log."), !j || j.state !== "done"); }
      }, 2000);
    });
  }
  if (sub === "container") {
    $$("[data-cact]", D).forEach((b) => b.addEventListener("click", async () => {
      const a = b.dataset.cact, done = { start: _("Started {c}."), stop: _("Stopped {c}."), restart: _("Restarted {c}."), rebuild: _("Rebuilt {c}.") }[a];
      if ((a === "rebuild" || a === "stop") && !confirm(_("{action} lab-{name}? {name}'s open sessions will close.", { action: b.textContent, name }))) return;
      b.disabled = true;
      await act(() => api("POST", P + "/container", { action: a }), I18N.fill(done, { c: "lab-" + name })).catch(() => {});
      setTimeout(() => reopen(), 800);
    }));
  }
}

// ------------------------------------------------------------------ language model
function reqTable(rows, withUser = true) {
  if (!rows.length) return `<p class="empty">${_("No requests yet.")}</p>`;
  return `<table><thead><tr><th>${_("Time")}</th>${withUser ? `<th>${_("Person")}</th>` : ""}<th>API</th><th class="num">${_("Prompt")}</th><th class="num">${_("Answer")}</th><th class="num">${_("First token")}</th><th class="num">${_("Total")}</th><th>${_("Result")}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtT(r.ts)}</td>${withUser ? `<td>${esc(r.user)}</td>` : ""}<td>${esc(r.endpoint.replace("/v1/", ""))}${r.stream ? ` <span class="sub">${_("streamed")}</span>` : ""}</td><td class="num">${fmtN(r.prompt)}</td><td class="num">${fmtN(r.completion)}</td><td class="num">${r.ttft_ms != null ? (r.ttft_ms / 1000).toFixed(1) + " s" : "–"}</td><td class="num">${(r.ms / 1000).toFixed(1)} s</td><td>${r.status === 499 ? `<span class="pill warn">${_("Cancelled")}</span>` : r.status >= 400 ? `<span class="pill bad">${_("Error {code}", { code: r.status })}</span>` : '<span class="pill ok">OK</span>'}</td></tr>`).join("")}</tbody></table>`;
}
async function loadLLM() {
  const [d, ov] = await Promise.all([api("GET", "llm"), api("GET", "overview")]);
  OV = ov;
  const cont = ov.containers.engine;
  $("#strataPill2").innerHTML = enginePill(d.strata, cont);
  $("#strataDetail").innerHTML = engineSummary(d.strata, cont) + (cont ? `<p class="hint" style="margin:12px 0 0">${esc(_("Holding {gpu} of GPU memory and {ram} of RAM. Container {status}.", { gpu: gb(cont.gpu_mib), ram: fmtB(cont.mem_anon), status: cont.status.toLowerCase() }))}</p>` : "");
  const g = d.gateway, base = `http://${location.hostname}:${g.port}`;
  $("#gwBox").innerHTML = `<dl class="kv"><dt>${_("Gateway")}</dt><dd>${g.active === "active" ? `<span class="pill ok">${_("Running")}</span>` : `<span class="pill bad">${esc(g.active)}</span>`}</dd>
    <dt>${_("OpenAI style")}</dt><dd><code>${esc(base)}/v1</code></dd><dt>${_("Anthropic style")}</dt><dd><code>${esc(base)}</code></dd>
    <dt>${_("Model name")}</dt><dd><code>${esc(g.model)}</code></dd>
    <dt>${_("Keys")}</dt><dd>${_("One per person, under People, Sign-in and keys. Daily limits and requests at once are set per person.")}</dd>
    <dt>${_("In containers")}</dt><dd>${_("Already set up: {vars}, and the person's key.", { vars: "<code>$OPENAI_BASE_URL</code>, <code>$ANTHROPIC_BASE_URL</code>" })}</dd></dl>`;
  loadEngPage().catch(() => {});
  if (!ENG_RENDERED) await loadEngine();
  else updateJobs(await api("GET", "jobs"));
  $("#llmChart").innerHTML = bars(d.days, ["p", "c"], ["var(--p3)", "var(--p1)"], [_("prompt"), _("answer")]);
  $("#llmUsers").innerHTML = `<thead><tr><th>${_("Person")}</th><th class="num">${_("Requests")}</th><th class="num">${_("Prompt tokens")}</th><th class="num">${_("Answer tokens")}</th><th class="num">${_("Average speed")}</th><th class="num">${_("Errors")}</th></tr></thead><tbody>${d.per_user.map((r) => `<tr><td>${esc(r.user)}</td><td class="num">${fmtN(r.n)}</td><td class="num">${fmtN(r.p)}</td><td class="num">${fmtN(r.c)}</td><td class="num">${r.tps ? r.tps.toFixed(0) + " tok/s" : "–"}</td><td class="num">${r.err}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">${_("No requests yet.")}</td></tr>`}</tbody>`;
  $("#llmRecent").innerHTML = reqTable(d.recent);
}
$$("[data-strata]").forEach((b) => b.addEventListener("click", async () => {
  const a = b.dataset.strata, done = { start: _("Started the engine."), stop: _("Stopped the engine."), restart: _("Restarted the engine.") }[a];
  if (a !== "start" && !confirm(_("{action}? Answers in progress are cut off, and loading takes one to two minutes.", { action: b.textContent }))) return;
  b.disabled = true;
  await act(() => api("POST", "strata", { action: a }), done).catch(() => {});
  b.disabled = false; reload();
}));

// ------------------------------------------------------------------ the engine's own page, passed through on a port of its own
async function loadEngPage() {
  const p = await api("GET", "engine/page"), own = ME.role === "owner", box = $("#engPageBox");
  if (box.querySelector("input:focus")) return;            // a refresh must not wipe a port being typed
  const url = p.port ? `https://${location.hostname}${p.port === 443 ? "" : ":" + p.port}/` : "";
  const fw = p.port && p.firewall === "other" ? `<p class="hint">${_("This server's firewall is not managed by the panel: open port {port} in it for the networks that reach the panel.", { port: p.port })}</p>` : "";
  box.innerHTML = `<p class="sub" style="margin:0 0 12px">${_("The engine's built-in web page, if it has one (Strata's has a chat, a live monitor and the engine's own settings). It opens on a port of its own, so it cannot reach this panel. The panel signs you in to it and adds the engine's private key, which never reaches your browser. Only owners and admins can open it.")}</p>
    <p class="hint" style="margin:0 0 12px">${_("Settings changed there apply to everyone who uses the model, and its chats do not count toward anyone's daily limit.")}</p>
    <dl class="kv"><dt>${_("Address")}</dt><dd>${p.on ? `<code>${esc(url)}</code>` : p.port ? `<span class="pill bad">${_("Port {port} could not be opened", { port: p.port })}</span>` : _("Off")}</dd></dl>${fw}
    ${p.on && ME.role !== "viewer" ? `<div class="actions"><button class="btn primary" id="engPageOpen">${_("Open the engine's page")}</button></div>` : ""}
    ${own ? `<form id="engPageForm" class="part port-form"><label>${p.port ? _("Port") : _("Turn on at port")}<span class="inline"><input name="port" type="number" min="1" max="65535" required inputmode="numeric" value="${p.port || ""}" placeholder="${p.panel_port + 1}">
        <button class="btn" type="submit">${p.port ? _("Move it") : _("Turn on")}</button>${p.port ? `<button class="btn quiet-danger" type="button" id="engPageOff">${_("Turn off")}</button>` : ""}</span></label>
        <p class="hint">${p.firewall === "ufw" ? _("The port is opened to the same networks as the panel, and closed again when you turn it off.") : _("Any port that is free on this server.")}</p></form>` : ""}`;
  $("#engPageOpen")?.addEventListener("click", async () => {
    const w = window.open("about:blank", "_blank");           // opened now, while the click still counts, then sent on
    try {
      const t = await api("POST", "engine/page/open", {});
      if (!w) return toast(_("Your browser blocked the new tab. Allow pop-ups for this panel and try again."), true);
      w.opener = null;
      w.location = `https://${location.hostname}${t.port === 443 ? "" : ":" + t.port}/lab-enter?t=${encodeURIComponent(t.ticket)}`;
    } catch (e) { w?.close(); toast(e.message, true); }
  });
  const set = async (port, msg) => { await act(() => api("POST", "system/engine-page", { port }), msg).catch(() => {}); loadEngPage().catch(() => {}); };
  $("#engPageForm")?.addEventListener("submit", (e) => { e.preventDefault(); const port = +new FormData(e.target).get("port"); set(port, _("The engine's page is at port {port}.", { port })); });
  $("#engPageOff")?.addEventListener("click", () => confirm(_("Turn off the engine's page? Anyone using it is signed out of it.")) && set(0, _("The engine's page is off.")));
}

// ------------------------------------------------------------------ engine settings
const opt = (vals, cur, labels = {}) => vals.map((v) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(labels[v] ?? v)}</option>`).join("");
function updateJobs(jobs) {
  const j = jobs && jobs[0], box = $("#jobBox");
  if (!j || (j.state !== "running" && !(ENG && ENG._job === j.id) && Date.now() / 1000 - j.started > 3600)) return box.classList.add("hidden");
  box.classList.remove("hidden");
  const kind = { apply: _("Applying settings"), pull: _("Downloading"), "move-home": _("Moving home folder") }[j.kind] || j.kind;
  const state = { running: _("running"), done: _("done"), failed: _("failed") }[j.state] || j.state;
  box.textContent = `${kind}: ${state}\n` + j.log.join("\n");
  box.scrollTop = box.scrollHeight;
  $$("#engForm button").forEach((b) => (b.disabled = j.state === "running"));
  if (j.state !== "running" && ENG && ENG._job === j.id) { ENG._job = null; toast(j.state === "done" ? _("Done.") : _("That failed. See the log under Engine settings."), j.state !== "done"); ENG_RENDERED = false; }
}
async function loadEngine(refreshVersions) {
  ENG = await api("GET", "engine" + (refreshVersions ? "?refresh=1" : ""));
  ENG_RENDERED = true;
  const c = ENG.config, s = c.strata, x = c.custom, ch = ENG.choices, v = ENG.versions || { remote: [], local: [] };
  const running = ENG.container?.image || "";
  const tags = [...new Set([...v.local, ...v.remote])];
  const tagLabel = Object.fromEntries(tags.map((tg) => [tg, `${tg}, ${running.endsWith(":" + tg) ? _("running now") : v.local.includes(tg) ? _("downloaded") : _("downloads when applied")}`]));
  const models = ENG.models.map((m) => m.path), mLabel = Object.fromEntries(ENG.models.map((m) => [m.path, `${m.name} (${fmtB(m.size)})`]));
  const sv = ENG.serving;
  const serving = _("Serving {model}", { model: `<b>${esc(sv.model || _("nothing"))}</b>` }) + (sv.concurrency ? _(", {n} requests at once", { n: sv.concurrency }) : "") + (sv.context ? _(", {n} tokens of context", { n: fmtN(sv.context) }) : "");
  $("#engForm").innerHTML = `<p class="sub" style="margin:0 0 16px">${serving}${_(". ")}${_("Applying restarts the engine: answers in progress are cut off and Strata takes one to two minutes to load. The previous settings stay available for rolling back.")}</p>
  <form id="engF" class="form">
    <label class="full">${_("Engine")}<select name="engine">${opt(["strata", "custom"], c.engine, { strata: _("Strata, for GGUF builds of Qwen3.8-Flash-Next and Qwen3.6"), custom: _("Another engine image, such as SGLang, vLLM or llama.cpp") })}</select></label>
    <div class="full form" data-eng="strata">
      <div class="form-sec">${_("Version and model")}</div>
      <label>${_("Strata version")}<span class="inline"><select name="s:tag">${opt(tags, s.tag, tagLabel)}</select><button type="button" class="btn sm" id="pullBtn">${_("Download now")}</button></span></label>
      <label>${_("Model files")}<select name="s:model_dir">${opt(["", ...models], s.model_dir, { "": _("Let Strata download by family and size"), ...mLabel })}</select></label>
      <label>${_("Family")}<input name="s:family" value="${esc(s.family)}"><span class="hint">${_("swift, qwen, unsloth, nvfp4, gyro, coder or qwen36")}</span></label>
      <label>${_("Size")}<input name="s:model" value="${esc(s.model)}"><span class="hint">${_("such as IQ3_S, IQ3_XXS or UD-Q4_K_XL")}</span></label>
      <div class="form-sec">${_("Capacity")}</div>
      <label>${_("Requests at once")}<input name="s:parallel" type="number" min="1" max="8" value="${s.parallel}"><span class="hint">${_("each needs GPU memory for its context; Strata reports what fits")}</span></label>
      <label>${_("Context")}<select name="s:context">${opt(ch.context, s.context, { "32k": _("32k tokens"), "64k": _("64k tokens"), "128k": _("128k tokens"), "256k": _("256k tokens (the model's maximum)") })}</select></label>
      <label>${_("Context memory format")}<select name="s:kv">${opt(ch.kv, s.kv, { int8: _("int8, the default"), q4_0: _("q4_0, half the memory"), k8v4: "k8v4", fp16: "fp16" })}</select></label>
      <label>${_("Pictures")}<select name="s:vision">${opt(ch.vision, s.vision, { off: _("Off"), gpu: _("On, read on the GPU"), cpu: _("On, read on the CPU") })}</select></label>
      <div class="form-sec">${_("Speed")}</div>
      <label>${_("Draft model")}<select name="s:drafting">${opt(ch.drafting, s.drafting, { auto: _("Automatic"), mtp: "MTP", dflash2: "DFlash2", off: _("Off") })}</select></label>
      <label>${_("Skip rarely used experts")}<select name="s:route_tail_skip">${opt([0, 7], s.route_tail_skip, { 0: _("Off: exact answers (default)"), 7: _("On: about 15% faster with several users, answers differ slightly") })}</select></label>
      <label class="check"><input type="checkbox" name="s:resident_experts" ${s.resident_experts ? "checked" : ""}> ${_("Keep experts only in GPU memory, saving about 47 GB of RAM")}</label>
      <label class="check"><input type="checkbox" name="s:batch_mtp" ${s.batch_mtp ? "checked" : ""}> ${_("Draft ahead for every request, faster with several users")}</label>
      <label class="full">${_("Extra engine settings")}<input name="s:extra_set" value="${esc(s.extra_set)}" placeholder="${esc(_("key=value pairs separated by spaces, such as prefill=16384"))}"></label>
    </div>
    <div class="full form" data-eng="custom">
      <div class="form-sec">${_("Engine image")}</div>
      <label>${_("Start from")}<select id="tpl"><option value="">${_("Choose a starting point")}</option>${opt(Object.keys(ENG.templates), "", { sglang: "SGLang", vllm: "vLLM", "llama.cpp": _("llama.cpp server") })}</select><span class="hint">${_("untested starting points; adjust the model path and options")}</span></label>
      <label>${_("Docker image")}<input name="c:image" value="${esc(x.image)}" placeholder="lmsysorg/sglang:latest"></label>
      <label>${_("Port inside the container")}<input name="c:port" type="number" value="${x.port}"></label>
      <label>${_("Model files, mounted at /models")}<select name="c:model_dir">${opt(["", ...models], x.model_dir, { "": _("None"), ...mLabel })}</select></label>
      <label>${_("Shared memory")}<input name="c:shm" value="${esc(x.shm)}"></label>
      <label class="full">${_("Command and options")}<textarea name="c:args" rows="3">${esc(x.args)}</textarea><span class="hint">${_("{key} becomes the engine's private key. People keep using their own keys through the gateway.")}</span></label>
      <label class="full">${_("Environment, one NAME=value per line")}<textarea name="c:env" rows="2">${esc(x.env)}</textarea></label>
    </div>
    <div class="full actions"><button class="btn primary" type="submit">${_("Apply and restart the engine")}</button>${ENG.has_prev ? `<button type="button" class="btn" id="rollBtn">${_("Roll back to the previous settings")}</button>` : ""}</div>
  </form>`;
  const F = $("#engF");
  const sync = () => $$("[data-eng]", F).forEach((d) => d.classList.toggle("hidden", d.dataset.eng !== F.engine.value));
  F.engine.addEventListener("change", sync); sync();
  $("#tpl").addEventListener("change", (e) => { const tp = ENG.templates[e.target.value]; if (!tp) return; F["c:image"].value = tp.image; F["c:port"].value = tp.port; F["c:args"].value = tp.args; F["c:shm"].value = tp.shm; });
  const runJob = async (fn, msg) => { const j = await act(fn, msg); ENG._job = j.id; updateJobs([j]); };
  F.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cfg = { engine: F.engine.value, strata: {}, custom: {} };
    for (const el of F.elements) {
      if (!el.name || !el.name.includes(":")) continue;
      const [sec, key] = el.name.split(":"), dst = sec === "s" ? cfg.strata : cfg.custom;
      dst[key] = el.type === "checkbox" ? el.checked : el.type === "number" || key === "route_tail_skip" ? +el.value : el.value;
    }
    if (!confirm(_("Apply these settings and restart the engine now? Answers in progress are cut off."))) return;
    await runJob(() => api("POST", "engine/apply", { config: cfg }), _("Applying the new settings…"));
  });
  $("#pullBtn").addEventListener("click", () => runJob(() => api("POST", "engine/pull", { tag: F["s:tag"].value }), _("Downloading…")));
  $("#rollBtn")?.addEventListener("click", () => confirm(_("Apply the previous engine settings again?")) && runJob(() => api("POST", "engine/rollback", {}), _("Rolling back…")));
  updateJobs(ENG.jobs);
}
$("#engReload").addEventListener("click", () => loadEngine(false));
$("#engVersions").addEventListener("click", async () => { await loadEngine(true); toast(_("Version list updated.")); });

// ------------------------------------------------------------------ activity log
const ACTIONS = () => ({ "user-add": _("Added person"), "user-edit": _("Changed settings"), "user-delete": _("Deleted person"), "user-disable": _("Disabled account"), "user-enable": _("Enabled account"),
  password: _("Set password"), "ssh-key-add": _("Added SSH key"), "ssh-key-remove": _("Removed SSH key"), "llm-key-regenerate": _("Replaced model key"), "llm-key-view": _("Viewed model key"),
  quota: _("Changed disk limits"), "home-move": _("Moved home folder"), login: _("Signed in"), "login-failed": _("Failed sign-in"), "engine-apply": _("Applied engine settings"),
  "engine-apply-failed": _("Engine settings failed"), "engine-pull": _("Downloaded engine version"), "admin-password": _("Set admin password"), "admin-save": _("Changed panel admin"), "admin-delete": _("Removed panel admin"),
  "two-factor-on": _("Turned on two-factor sign-in"), "two-factor-off": _("Turned off two-factor sign-in"), storage: _("Changed disk settings"), brand: _("Changed the lab name or logo"), "disk-limits": _("Turned on disk limits"), "system-upgrade": _("Installed server updates"), reboot: _("Restarted the server"),
  "panel-restart": _("Restarted the panel"), "panel-port-try": _("Tried a new panel port"), "panel-port": _("Changed the panel port"), "panel-port-undo": _("Undid a panel port change"),
  "engine-page": _("Opened the engine's page"), "engine-page-port": _("Changed the engine page port") });
async function loadAudit() {
  const rows = await api("GET", "audit"), A = ACTIONS();
  $("#auditTable").innerHTML = `<thead><tr><th>${_("Time")}</th><th>${_("By")}</th><th>${_("What")}</th><th>${_("Who or what")}</th><th>${_("Details")}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtT(r.ts)}</td><td>${esc(r.actor)}</td><td>${esc(A[r.action] || r.action.replace(/-/g, " "))}</td><td>${esc(r.target)}</td><td class="sub" style="white-space:normal;max-width:520px;overflow-wrap:anywhere">${esc(r.detail)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">${_("Nothing yet.")}</td></tr>`}</tbody>`;
}

// ------------------------------------------------------------------ settings: account, admins, server software
const ROLE_TEXT = () => ({ owner: _("Owner: everything, including admins and server updates"), admin: _("Admin: people and the language model"), viewer: _("Viewer: can look, cannot change anything") });
async function loadSettings() {
  $("#myRole").innerHTML = `<span class="pill ok">${esc(ROLE()[ME.role] || ME.role)}</span>`;
  $("#meBox").innerHTML = `<div class="part"><h3>${_("Password")}</h3><div class="form">
      <label>${_("Current password")}<input type="password" id="pwCur" autocomplete="current-password"></label>
      <label>${_("New password")}<input type="password" id="pwNew" autocomplete="new-password" placeholder="${esc(_("at least 10 characters"))}"></label></div>
      <div><button class="btn" id="pwSave">${_("Change password")}</button></div></div>
    <div class="part"><h3>${_("Two-factor sign-in")}</h3>${ME.two_factor
      ? `<p class="sub">${_("On. Sign-in asks for a code from your authenticator app.")}</p><div class="inline"><input id="tfOff" inputmode="numeric" placeholder="${esc(_("current 6-digit code"))}"><button class="btn quiet-danger" id="tfOffBtn">${_("Turn off")}</button></div>`
      : `<p class="sub">${_("Off. Turn it on so a stolen password is not enough to get in.")}</p><div><button class="btn" id="tfStart">${_("Set up two-factor sign-in")}</button></div><div id="tfSetup"></div>`}</div>`;
  $("#pwSave").addEventListener("click", async () => { await act(() => api("POST", "me/password", { current: $("#pwCur").value, new: $("#pwNew").value }), _("Password changed.")); $("#pwCur").value = $("#pwNew").value = ""; });
  $("#tfOffBtn")?.addEventListener("click", async () => { await act(() => api("POST", "me/totp/off", { code: $("#tfOff").value }), _("Two-factor sign-in is off.")); ME.two_factor = false; loadSettings(); });
  $("#tfStart")?.addEventListener("click", async () => {
    const tf = await api("POST", "me/totp/start", {});
    $("#tfSetup").innerHTML = `<p class="sub">${_("In your authenticator app (Google Authenticator, 1Password, Authy …), add an account by entering this key, then type the code it shows.")}</p>
      <div class="inline"><code class="key">${esc(tf.secret.match(/.{1,4}/g).join(" "))}</code></div>
      <div class="inline"><input id="tfCode" inputmode="numeric" placeholder="${esc(_("6-digit code"))}"><button class="btn primary" id="tfConfirm">${_("Turn on")}</button></div>`;
    $("#tfConfirm").addEventListener("click", async () => { await act(() => api("POST", "me/totp/confirm", { code: $("#tfCode").value }), _("Two-factor sign-in is on.")); ME.two_factor = true; loadSettings(); });
  });
  loadBrand();
  loadLook();
  loadTls().catch(() => {});
  loadPanel().catch(() => {});
  loadDisks(false).catch(() => {});
  if (ME.role === "owner") {
    const admins = await api("GET", "admins"), R = ROLE();
    $("#adminsTable").innerHTML = `<thead><tr><th>${_("Name")}</th><th>${_("Role")}</th><th>${_("Two-factor")}</th><th>${_("Added")}</th><th></th></tr></thead><tbody>${admins.map((a) => `<tr><td><b>${esc(a.name)}</b>${a.name === ME.user ? ` <span class="sub">${_("you")}</span>` : ""}</td>
      <td><select data-role="${esc(a.name)}" aria-label="${esc(_("Role of {name}", { name: a.name }))}">${["owner", "admin", "viewer"].map((r) => `<option value="${r}" ${r === a.role ? "selected" : ""}>${esc(R[r])}</option>`).join("")}</select></td>
      <td>${a.two_factor ? `<span class="pill ok">${_("On")}</span>` : `<span class="pill">${_("Off")}</span>`}</td><td>${fmtT(a.created)}</td>
      <td class="num">${a.name === ME.user ? "" : `<button class="btn sm" data-reset="${esc(a.name)}">${_("New password")}</button> <button class="btn sm quiet-danger" data-deladmin="${esc(a.name)}">${_("Remove")}</button>`}</td></tr>`).join("")}</tbody>`;
    $$("[data-role]").forEach((sel) => sel.addEventListener("change", () => act(() => api("PATCH", "admins/" + sel.dataset.role, { role: sel.value }), _("{name} is now {role}.", { name: sel.dataset.role, role: R[sel.value] })).catch(loadSettings)));
    $$("[data-reset]").forEach((b) => b.addEventListener("click", async () => { const pw = randomPw(); await act(() => api("PATCH", "admins/" + b.dataset.reset, { password: pw }), _("New password for {name}: {pw}", { name: b.dataset.reset, pw })); }));
    $$("[data-deladmin]").forEach((b) => b.addEventListener("click", async () => { if (confirm(_("Remove {name} from the panel?", { name: b.dataset.deladmin }))) { await act(() => api("DELETE", "admins/" + b.dataset.deladmin), _("Removed.")); loadSettings(); } }));
    loadUpdates(false);
  } else {
    $("#adminsTable").innerHTML = `<tbody><tr><td class="empty">${_("Only an owner can manage panel admins.")}</td></tr></tbody>`;
    $("#updBox").innerHTML = `<p class="sub">${_("Only an owner can update the server.")}</p>`;
  }
}
// ------------------------------------------------------------------ settings: appearance, language and refresh (per admin)
const SCHEMES = () => [["pine", _("Pine")], ["lake", _("Lake")], ["heather", _("Heather")], ["graphite", _("Graphite")]];
const FACES = () => [["field", _("Field"), _("Bitter and Public Sans")], ["book", _("Book"), _("Source Serif and Hanken Grotesk")], ["system", _("System"), _("Your computer's own fonts")]];
const EVERY = () => [[0, _("Never, only by hand")], [2, _("2 seconds")], [5, _("5 seconds")], [10, _("10 seconds")], [30, _("30 seconds")], [60, _("Minute")]];
function loadLook(focus) {
  const mode = document.documentElement.dataset.mode;
  const modeName = Object.fromEntries(MODES())[PREFS.mode];
  $("#lookBox").innerHTML = `<div class="look">
    <div><h3>${_("Light or dark")}</h3><div class="mode-row">${modeSwitch("lookMode")}
      <p class="hint"><b>${esc(modeName)}</b>${_(". ")}${PREFS.mode === "auto" ? _("Follows the light or dark setting of your computer.") : _("Stays this way whatever your computer is set to.")}</p></div></div>
    <div><h3 id="schemeH">${_("Colours")}</h3><div class="swatches" role="radiogroup" aria-labelledby="schemeH">${SCHEMES().map(([v, n]) =>
      `<label class="swatch" data-scheme="${v}" data-mode="${mode}"><input type="radio" name="lookScheme" value="${v}" ${PREFS.scheme === v ? "checked" : ""}>
        <span class="sw-art" aria-hidden="true"><i class="sw-side"><b></b><b></b></i><i class="sw-page"><u></u><u></u><u></u></i></span>${esc(n)}</label>`).join("")}</div></div>
    <div><h3 id="faceH">${_("Typeface")}</h3><div class="faces" role="radiogroup" aria-labelledby="faceH">${FACES().map(([v, n, d]) =>
      `<label class="face" data-font="${v}"><input type="radio" name="lookFont" value="${v}" ${PREFS.font === v ? "checked" : ""}>
        <span class="ag" aria-hidden="true">${_("Ag 128")}</span><span class="body" aria-hidden="true">${esc(d)}</span><span class="nm">${esc(n)}</span></label>`).join("")}</div></div>
    <div class="form">
      <label>${_("Language")}<select id="lookLang">${I18N.langs.map(([v, n]) => `<option value="${v}" ${PREFS.lang === v ? "selected" : ""}>${esc(v === "auto" ? _("Automatic, as the browser") : n)}</option>`).join("")}</select></label>
      <label>${_("Refresh pages every")}<select id="lookRefresh">${EVERY().map(([v, n]) => `<option value="${v}" ${PREFS.refresh === v ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <p class="hint full" style="margin:0">${_("Press R or use the ring at the bottom of the sidebar to refresh at any time.")}${I18N.space}${_("Settings never refresh on their own, so nothing you type is lost.")}</p></div></div>`;
  $$('input[name="lookScheme"]').forEach((i) => i.addEventListener("change", () => savePrefs({ scheme: i.value })));
  $$('input[name="lookFont"]').forEach((i) => i.addEventListener("change", () => savePrefs({ font: i.value })));
  $("#lookLang").addEventListener("change", (e) => savePrefs({ lang: e.target.value }));
  $("#lookRefresh").addEventListener("change", (e) => savePrefs({ refresh: +e.target.value }));
  if (focus) ({ mode: $('input[name="lookMode"]:checked'), scheme: $('input[name="lookScheme"]:checked'), font: $('input[name="lookFont"]:checked'), lang: $("#lookLang"), refresh: $("#lookRefresh") })[focus]?.focus();
}
// ------------------------------------------------------------------ browser certificate: why browsers warn, and how to stop it
function osGuess() {
  const u = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1) ? "ios" : /Android/.test(u) ? "android" : /Mac/.test(u) ? "mac" : /Win/.test(u) ? "win" : "linux";
}
function trustHTML(sha) {
  const steps = [
    ["mac", "macOS", _("Open the downloaded file; Keychain Access adds it. Double-click the certificate there, open Trust, set “When using this certificate” to “Always Trust”, then close the window and confirm with your password.")],
    ["win", "Windows", _("Open the downloaded file and choose Install Certificate. Pick Current User, then “Place all certificates in the following store”, Browse, “Trusted Root Certification Authorities”, and finish.")],
    ["linux", "Linux", _("In Chrome or Edge: Settings › Privacy and security › Security › Manage certificates, then import it under Authorities and tick “Trust this certificate for identifying websites”.")],
    ["ios", "iPhone, iPad", _("Open the download in Safari and allow it. In Settings › General › VPN & Device Management, install the profile, then turn on full trust in Settings › General › About › Certificate Trust Settings.")],
    ["android", "Android", _("In Settings, search for “CA certificate” (under Security › Encryption & credentials › Install a certificate) and choose the downloaded file. Menu names vary by maker.")],
    ["firefox", "Firefox", _("Firefox keeps its own list: Settings › Privacy & Security › Certificates › View Certificates › Authorities › Import, then tick “Trust this CA to identify websites”.")],
  ];
  const os = osGuess();
  return `<div class="trust">
    <p>${_("Browsers warn because the panel is reached by a local address or name, which public certificate authorities do not cover. This server has its own lab certificate instead: install it once on each computer and phone, and the warning goes away.")}</p>
    <p><a class="btn primary" href="/lab-ca.crt" download>${_("Download the lab certificate")}</a></p>
    <div class="trust-steps">${steps.map(([k, n, t]) => `<details ${k === os ? "open" : ""}><summary>${n}</summary><p>${t}</p></details>`).join("")}</div>
    <p class="hint">${_("Restart the browser afterwards. Before trusting the file, check that your system shows this SHA-256 fingerprint. An owner can print it on the server with {cmd}.", { cmd: "<code>sudo python3 /opt/lab/panel/labtls.py</code>" })}</p>
    <code class="fp">${esc(sha).replace(/:/g, ":<wbr>")}</code>
    <p class="hint">${_("The lab certificate can only vouch for local addresses and names, never for public websites, so installing it does not weaken anything else.")}</p></div>`;
}
async function loadTls() {
  const t = await api("GET", "system/tls"), date = (d) => d ? new Date(d + "T00:00").toLocaleDateString(LOC, { year: "numeric", month: "long", day: "numeric" }) : "–";
  $("#tlsBox").innerHTML = t.mode === "lab"
    ? `<dl class="kv"><dt>${_("Panel certificate")}</dt><dd>${esc(_("Issued by this server's lab certificate and renewed automatically. Valid until {date}.", { date: date(t.expires) }))}</dd>
        <dt>${_("Works at")}</dt><dd>${t.names.map((n) => `<code>${esc(n)}</code>`).join(" ")}</dd></dl>${trustHTML(t.ca_sha256)}`
    : `<p class="sub">${esc(_("This server uses its own certificate, issued by {issuer}, valid until {date}. Browsers trust it when they trust that authority.", { issuer: t.issuer, date: date(t.expires) }))}</p>`;
}
$("#trustLink").addEventListener("click", () => dialog(`<div class="dlg-h"><div><h2>${_("Seeing a browser warning?")}</h2></div>${closeX()}</div><div class="dlg-b">${trustHTML(BRAND.ca_sha256 || "")}</div>`, "center"));
let BRAND = {};
// ------------------------------------------------------------------ panel port (tried, then kept or undone) and restart
const panelURL = (port) => `${location.protocol}//${location.hostname}${+port === 443 ? "" : ":" + port}/`;
async function loadPanel() {
  const p = await api("GET", "system/panel"), own = ME.role === "owner";
  const fw = { ufw: _("ufw. Trying a port opens it to the same networks as the current one; keeping it closes the old one."),
    other: _("A firewall the panel does not manage. Open the new port in it first, or the new address cannot be reached and the change is undone."),
    "": _("None found.") }[p.firewall];
  $("#panelBox").innerHTML = `<dl class="kv"><dt>${_("Address")}</dt><dd><code>${esc(panelURL(p.port))}</code></dd><dt>${_("Firewall")}</dt><dd>${esc(fw)}</dd></dl>
    ${own ? `<form id="portForm" class="part port-form"><label>${_("New port")}<span class="inline"><input name="port" type="number" min="1" max="65535" required inputmode="numeric">
        <button class="btn" type="submit">${_("Try this port")}</button></span></label>
      <p class="hint">${_("The current address keeps working while you try. The new port is kept only if you open the panel there within {n} seconds; otherwise everything stays as it is.", { n: p.trial_seconds })}</p></form>
      <div class="actions"><button class="btn quiet-danger" id="panelRestart">${_("Restart the panel")}</button></div>`
    : `<p class="sub">${_("Only an owner can change the port or restart the panel.")}</p>`}`;
  if (!own) return;
  if (p.trial) trialDialog(p.trial);
  $("#portForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await act(() => api("POST", "system/panel/port", { port: +new FormData(e.target).get("port") })).catch(() => null);
    if (r) trialDialog(r.trial);
  });
  $("#panelRestart").addEventListener("click", async () => {
    if (!confirm(_("Restart the panel? Everyone signed in to it, you included, signs in again. Containers and the language model keep running."))) return;
    if (!(await act(() => api("POST", "system/panel/restart", {}), _("The panel is restarting…")).catch(() => null))) return;
    const t0 = Date.now();
    const wait = setInterval(async () => {          // the old process answers for a moment, so start looking after 3 s
      if (Date.now() - t0 < 3000) return;
      if (Date.now() - t0 > 90000) { clearInterval(wait); return toast(_("The panel has not come back yet. Reload this page in a minute."), true); }
      try { if ((await fetch("/api/brand", { cache: "no-store" })).ok) { clearInterval(wait); location.reload(); } } catch (err) { /* still down */ }
    }, 1500);
  });
}
// The page that started the trial stays on the old address and counts down; the new tab keeps the port on arrival.
function trialDialog(t) {
  const url = panelURL(t.port) + "?keep-port=" + t.port;
  dialog(`<div class="dlg-h"><div><h2>${_("Try port {port}", { port: t.port })}</h2></div>${closeX()}</div>
    <div class="dlg-b"><p>${_("The panel now also answers at the new address. Open it there to keep the new port; this address then stops working.")}</p>
      <p><a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">${_("Open the panel at port {port}", { port: t.port })}</a></p>
      <p class="hint" id="trialLeft" aria-live="polite"></p></div>
    <div class="dlg-f"><button class="btn" id="trialCancel">${_("Cancel the change")}</button></div>`, "center");
  const left = $("#trialLeft"), end = Date.now() + t.seconds_left * 1000;
  let over = false;
  const done = (msg, bad) => { if (over) return; over = true; clearInterval(poll); left.textContent = msg; $("#trialCancel")?.remove(); toast(msg, bad); };
  const tick = () => (left.textContent = _("If the new address does not open, the change is undone in {n} s and the panel stays at port {old}.", { n: Math.max(0, Math.round((end - Date.now()) / 1000)), old: t.old }));
  tick();
  let busy = false;
  const poll = setInterval(async () => {
    if (!$("#dlg").open) return clearInterval(poll);
    tick();
    if (busy || over) return;
    busy = true;
    try {
      const p = await api("GET", "system/panel");
      if (!p.trial && p.last?.result === "kept") done(_("Port {port} is kept. Continue in the new tab.", { port: p.last.port }));
      else if (!p.trial && p.last?.result === "timeout") done(_("Port {port} was not opened in time, so nothing changed.", { port: t.port }), true);
      else if (!p.trial) done(_("The port change was cancelled."));
    } catch (e) {        // this address closes once the new port is kept
      done(_("This address has stopped answering, as it does once the new port is kept. Continue at {url}", { url: panelURL(t.port) }));
    } finally { busy = false; }
  }, 2000);
  $("#trialCancel").addEventListener("click", async () => {
    if (await act(() => api("POST", "system/panel/port/cancel", {})).catch(() => null)) done(_("The port change was cancelled."));
  });
}
// arriving at the new address from that link: keep the port (an owner must be signed in; the cookie carries over)
async function keepPort() {
  const want = new URLSearchParams(location.search).get("keep-port");
  if (!want) return;
  history.replaceState(null, "", location.pathname + location.hash);
  if (+want !== +(location.port || 443)) return;
  await act(() => api("POST", "system/panel/port/keep", {}), _("The panel now uses port {port}. The old address no longer works.", { port: want })).catch(() => {});
}
// ------------------------------------------------------------------ settings: lab name and logo
function loadBrand() {
  const own = ME.role === "owner";
  let logo = ME.logo, pending;          // pending: undefined = unchanged, "" = built-in mark, data URL = new image
  const preview = () => {
    const name = ($("#brandName")?.value || "").trim() || ME.org, l = pending === undefined ? logo : pending;
    const sub = $("#brandSub") ? ($("#brandSub").value.trim() || _("{host} server", { host: ME.subtitle_default.replace(/ server$/, "") })) : $("#hostName").textContent;
    $("#brandPreview").innerHTML = `<div class="brand"><div class="mark ${l ? "logo" : ""}">${markHTML(l)}</div>
      <div><b>${esc(name)}</b><span>${esc(sub)}</span></div></div>`;
    $("#brandReset") && ($("#brandReset").disabled = !l);
  };
  $("#brandBox").innerHTML = `<div id="brandPreview" class="brand-preview" aria-label="${esc(_("Preview of the sidebar"))}"></div>
    <div class="brand-fields">${own ? `
      <label>${_("Lab name")}<input id="brandName" value="${esc(ME.org)}" maxlength="60" autocomplete="organization"></label>
      <label>${_("Line under the name")}<input id="brandSub" value="${esc(ME.subtitle_custom)}" maxlength="60" placeholder="${esc(_("{host} server", { host: ME.subtitle_default.replace(/ server$/, "") }))}">
        <span class="hint">${_("For example the server's purpose or room. Leave it empty to show the server's host name.")}</span></label>
      <div class="brand-logo"><span class="label">${_("Logo")}</span>
        <div class="inline"><label class="btn file">${_("Choose image")}<input type="file" id="brandFile" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label>
          <button class="btn" id="brandReset">${_("Use the built-in mark")}</button></div>
        <span class="hint">${_("A square PNG, JPEG, WebP or SVG up to 512 KB. It appears on the sign-in page, in the sidebar and on the browser tab.")}</span></div>
      <div><button class="btn primary" id="brandSave">${_("Save name and logo")}</button></div>`
    : `<p class="sub">${_("Only an owner can change the lab name and logo.")}</p>`}</div>`;
  preview();
  if (!own) return;
  $("#brandName").addEventListener("input", preview);
  $("#brandSub").addEventListener("input", preview);
  $("#brandFile").addEventListener("change", (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 512 * 1024) return toast(_("That image is larger than 512 KB. Export a smaller one, 256 × 256 pixels is plenty."), true);
    const rd = new FileReader();
    rd.onload = () => { pending = rd.result; preview(); };
    rd.readAsDataURL(f);
  });
  $("#brandReset").addEventListener("click", () => { pending = ""; preview(); });
  $("#brandSave").addEventListener("click", async () => {
    const body = { org: $("#brandName").value, subtitle: $("#brandSub").value };
    if (pending !== undefined) body.logo = pending;
    const b = await act(() => api("PUT", "system/brand", body), _("Lab name and logo saved."));
    Object.assign(ME, b); logo = b.logo; pending = undefined; applyBrand(b); preview();
  });
}
// ------------------------------------------------------------------ settings: disks found on this server
async function loadDisks(refresh) {
  const r = await api("GET", "system/disks" + (refresh ? "?refresh=1" : ""));
  const own = ME.role === "owner";
  const lim = (d) => d.limits === "on" ? `<span class="pill ok">${_("On")}</span>`
    : d.limits === "unsupported" ? `<span class="sub">${d.network ? _("Not on network storage") : esc(_("Not on {fs}", { fs: d.fstype }))}</span>`
    : own && (d.homes || d.data || d.path === r.container_fs) ? `<button class="btn sm" data-limits="${esc(d.path)}">${_("Turn on")}</button>` : `<span class="sub">${_("Off")}</span>`;
  const rows = r.disks.map((d) => `<tr data-disk="${esc(d.path)}">
      <td class="disk-name">${own ? `<input class="dlabel" value="${esc(d.custom_label)}" placeholder="${esc(diskName(d.label))}" maxlength="40" aria-label="${esc(_("Name for {path}", { path: d.path }))}">` : `<b>${esc(d.custom_label || diskName(d.label))}</b>`}
        ${d.model ? `<span class="model" title="${esc(d.model)}">${esc(d.model)}</span>` : ""}
        <span class="sub">${esc(d.path)}, ${esc(d.fstype)}${d.path === r.container_fs ? esc(_(", holds container system files")) : ""}</span></td>
      <td style="min-width:180px">${meter(d.used, d.size, "", esc(_("{free} free of {total}", { free: fmtB(d.avail), total: fmtB(d.size) })))}</td>
      <td><label class="check"><input type="checkbox" class="dhomes" ${d.homes ? "checked" : ""} ${own ? "" : "disabled"} aria-label="${esc(_("Home folders on {path}", { path: d.path }))}"> ${_("Allowed")}</label>
        ${d.homes ? `<span class="sub">${esc(d.homes_dir)}, ${esc(d.people === 1 ? _("1 person") : _("{n} people", { n: d.people }))}</span>` : ""}</td>
      <td><label class="check"><input type="checkbox" class="ddata" ${d.data ? "checked" : ""} ${own && d.path !== "/home" ? "" : "disabled"} aria-label="${esc(_("Data folders on {path}", { path: d.path }))}"> ${_("Allowed")}</label>
        ${d.data ? `<span class="sub">${esc(d.data_dir)}/<i>${_("name")}</i></span>` : ""}</td>
      <td>${lim(d)}</td></tr>`);
  $("#disksTable").innerHTML = `<thead><tr><th>${_("Disk")}</th><th>${_("Space")}</th><th>${_("Home folders")}</th><th>${_("Data folders")}</th><th>${_("Disk limits")}</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="5" class="empty">${_("No usable disks found.")}</td></tr>`}</tbody>`;
  const slow = r.disks.some((d) => d.rotational && d.homes);
  $("#diskFoot").innerHTML = (own ? `<button class="btn primary" id="diskSave">${_("Save disk settings")}</button> ` : "") +
    `<span class="hint">${_("Names come from the drive itself; type your own to replace one. Disk limits need ext4.")}${slow ? I18N.space + _("A hard disk holds home folders: code, environments and many small files are much faster on an SSD.") : ""}</span>`;
  $("#diskSave")?.addEventListener("click", async () => {
    const disks = $$("#disksTable tr[data-disk]").map((tr) => ({ path: tr.dataset.disk, homes: $(".dhomes", tr).checked, data: $(".ddata", tr).checked, label: $(".dlabel", tr).value }));
    await act(() => api("PUT", "system/disks", { disks }), _("Disk settings saved."));
    ME = await api("GET", "me"); Object.keys(FSN).forEach((k) => delete FSN[k]); ME.storage.forEach((d) => (FSN[d.path] = d.label));
    loadDisks(true);
  });
  $$("[data-limits]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(_("Turn on disk limits for {path}? The disk is remounted and checked once, which can take a few minutes on a large, full disk.", { path: b.dataset.limits }))) return;
    const j = await act(() => api("POST", "system/disks/limits", { path: b.dataset.limits }), _("Turning on disk limits…"));
    const log = $("#diskLog"); log.classList.remove("hidden");
    const poll = setInterval(async () => {
      const x = (await api("GET", "jobs")).find((y) => y.id === j.id) || j;
      log.textContent = x.log.join("\n");
      if (x.state !== "running") { clearInterval(poll); toast(x.state === "done" ? _("Disk limits are on.") : _("Turning on disk limits failed. See the log."), x.state !== "done"); loadDisks(true); }
    }, 1500);
  }));
}
$("#diskRefresh").addEventListener("click", () => loadDisks(true));
async function loadUpdates(refresh) {
  const u = await api("GET", "system/updates" + (refresh ? "?refresh=1" : ""));
  $("#updCount").textContent = u.upgradable.length || "";
  $("#updBox").innerHTML = `<dl class="kv"><dt>${_("Waiting")}</dt><dd>${u.upgradable.length ? _("{n} packages", { n: u.upgradable.length }) : _("Everything is up to date.")}</dd>
      <dt>${_("Automatic")}</dt><dd>${_("Security updates install daily by themselves")}${u.last_auto_run ? esc(_("; last run {when}", { when: u.last_auto_run })) : ""}${_(". ")}${_("GPU driver and Docker updates wait for you, because they need a restart.")}</dd>
      ${u.driver_or_docker.length ? `<dt>${_("Needs care")}</dt><dd>${esc(_("{pkgs}: plan a restart after installing.", { pkgs: u.driver_or_docker.join(", ") }))}</dd>` : ""}
      <dt>${_("Restart")}</dt><dd>${u.reboot_required ? `<span class="pill warn">${_("Needed")}</span> <span class="sub">${esc(u.reboot_pkgs.slice(0, 4).join(", "))}</span>` : _("Not needed")}</dd></dl>
    ${u.upgradable.length ? `<p class="hint">${esc(u.upgradable.slice(0, 30).join(", "))}${u.upgradable.length > 30 ? " …" : ""}</p>` : ""}
    <div class="actions">${u.upgradable.length ? `<button class="btn primary" id="updRun">${_("Install all updates")}</button>` : ""}${u.reboot_required ? `<button class="btn quiet-danger" id="rebootBtn">${_("Restart the server")}</button>` : ""}</div>`;
  $("#updRun")?.addEventListener("click", async () => {
    if (!confirm(_("Install all updates now? Running jobs keep running; a restart may be needed afterwards."))) return;
    const j = await act(() => api("POST", "system/upgrade", {}), _("Installing updates…"));
    const log = $("#updLog"); log.classList.remove("hidden");
    const poll = setInterval(async () => {
      const x = (await api("GET", "jobs")).find((y) => y.id === j.id) || j;
      log.textContent = x.log.join("\n"); log.scrollTop = log.scrollHeight;
      if (x.state !== "running") { clearInterval(poll); toast(x.state === "done" ? _("Updates installed.") : _("Updating failed. See the log."), x.state !== "done"); loadUpdates(false); }
    }, 2000);
  });
  $("#rebootBtn")?.addEventListener("click", async () => {
    if (prompt(_("Restarting stops every container and the language model for a few minutes. Type reboot to continue.")) !== "reboot") return;
    await act(() => api("POST", "system/reboot", { confirm: "reboot" }), _("The server restarts in a few seconds."));
  });
}
$("#updCheck").addEventListener("click", () => loadUpdates(true).then(() => toast(_("Checked for updates."))));
$("#addAdminBtn").addEventListener("click", () => {
  if (ME.role !== "owner") return toast(_("Only an owner can add admins."), true);
  const RT = ROLE_TEXT();
  dialog(`<div class="dlg-h"><div><h2>${_("Add a panel admin")}</h2><p class="sub">${_("Panel admins manage this server. They are separate from the people who use it.")}</p></div>${closeX()}</div>
    <form id="adminForm"><div class="dlg-b"><div class="form">
      <label>${_("Name")}<input name="name" required pattern="[a-z_][a-z0-9_\\-]{0,31}" autocomplete="off"></label>
      <label>${_("Role")}<select name="role">${["admin", "viewer", "owner"].map((r) => `<option value="${r}">${esc(RT[r])}</option>`).join("")}</select></label>
      <label class="full">${_("Password")}<span class="inline"><input name="password" minlength="10" required autocomplete="new-password"><button type="button" class="btn sm" id="genAp">${_("Generate")}</button></span><span class="hint">${_("share it privately; they can change it under Settings")}</span></label>
    </div></div><div class="dlg-f"><button type="button" class="btn" data-close>${_("Cancel")}</button><button class="btn primary" type="submit">${_("Add admin")}</button></div></form>`, "center");
  $("#genAp").addEventListener("click", () => ($("#adminForm [name=password]").value = randomPw()));
  $("#adminForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await act(() => api("POST", "admins", f), _("Added {name} as {role}.", { name: f.name, role: ROLE()[f.role] })); closeDlg();
  });
});

// ------------------------------------------------------------------ boot: language first, then the sign-in check
I18N.ready.then(() => {
  translateStatic(document.body);
  document.title = _("Lab server");
  renderLoginLang();
  fetch("/api/brand").then((r) => r.json()).then((b) => { BRAND = b; applyBrand(b); $("#trustLink").classList.toggle("hidden", !b.lab_ca); }).catch(() => {});
  start();
});
