"use strict";
// Lab server console (no external dependencies).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const GiB = 1024 ** 3;
const fmtB = (b) => b == null ? "–" : b >= 1024 ** 4 ? (b / 1024 ** 4).toFixed(2) + " TB" : b >= GiB ? (b / GiB).toFixed(b >= 100 * GiB ? 0 : 1) + " GB" : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(0) + " MB" : b > 0 ? (b / 1024).toFixed(0) + " KB" : "0";
const fmtN = (n) => n == null ? "–" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e4 ? (n / 1e3).toFixed(1) + "k" : Math.round(n).toLocaleString();
const hrs = (h) => !h ? "0 h" : h < 0.1 ? `${Math.round(h * 60)} min` : h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h)} h`;
const fmtT = (ts) => ts ? new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
const ago = (ts) => { if (!ts) return "never"; const s = Date.now() / 1000 - ts; if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + " min ago"; if (s < 129600) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " days ago"; };
const memStr = (m) => { if (!m) return "no memory limit"; const n = parseInt(m); return (m.endsWith("g") ? n : (n / 1024).toFixed(1)) + " GB memory"; };
const gb = (mib) => (mib / 1024).toFixed(1) + " GB";
const FSN = {};   // filesystem path -> disk label, filled from /api/me
// lab name and logo: sign-in card, sidebar, browser tab
const MARK = $(".brand .mark").innerHTML, ICON = $('link[rel="icon"]').href;
const markHTML = (logo) => logo ? `<img src="${esc(logo)}" alt="">` : MARK;
function applyBrand(b) {
  document.title = `${b.org} server`;
  $$(".login-card h1, .side .brand b").forEach((x) => (x.textContent = b.org));
  if (b.subtitle) $("#hostName").textContent = b.subtitle;
  $$(".login-card .mark, .side .brand .mark").forEach((m) => { m.classList.toggle("logo", !!b.logo); m.innerHTML = markHTML(b.logo); });
  $('link[rel="icon"]').href = b.logo || ICON;
}
fetch("/api/brand").then((r) => r.json()).then(applyBrand).catch(() => {});
const PALETTE = ["--p2", "--p3", "--p4", "--p5", "--p6"];

let PREFS = { mode: "auto", scheme: "pine", refresh: 5 }, LAST = 0;
let ME = null, TAB = "overview", OV = null, USERS = [], timer = null, ENG = null, ENG_RENDERED = false;

async function api(method, path, body) {
  const r = await fetch("/api/" + path, { method, credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-RL": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = {};
  try { d = await r.json(); } catch (e) { /* empty body */ }
  if (r.status === 401 && !d.need_code) { showLogin(); throw new Error("Your session ended. Sign in again."); }
  if (!r.ok) throw new Error(d.error || r.statusText);
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
  const unit = o.unit ?? "tokens", fmt = o.fmt || fmtN;
  if (!days.some((d) => keys.some((k) => d[k]))) return `<p class="empty" style="padding:4px 0">${esc(o.empty || "No requests in the last 30 days.")}</p>`;
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
    if (i % 5 === 0 || i === days.length - 1) g += `<text x="${pad + i * bw + bw / 2}" y="${H - 3}" text-anchor="middle">${esc(new Date(d.d + "T00:00").toLocaleDateString([], { month: "short", day: "numeric" }))}</text>`;
  });
  g += `<text x="0" y="12">${fmt(m)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${esc(o.aria || "Tokens per day")}">${g}</svg><div class="legend">${labels.map((l, j) => `<span><i style="background:${colors[j]}"></i>${esc(l)}</span>`).join("")}</div>`;
}
function meter(used, total, label, note) {
  const p = total ? Math.min(100, (100 * used) / total) : 0;
  const cls = p > 90 ? "bad" : p > 75 ? "warn" : "";
  return `<div class="meter"><div class="t">${label}${note ? `<span class="sub">${note}</span>` : ""}</div><div class="bar ${cls}"><i style="width:${p.toFixed(1)}%"></i></div></div>`;
}
function pill(state, disabled) {
  if (disabled) return '<span class="pill bad">Disabled</span>';
  const m = { running: ["ok", "Running"], exited: ["warn", "Stopped"], created: ["warn", "Created"], paused: ["warn", "Paused"], restarting: ["warn", "Restarting"], none: ["", "Not created yet"] };
  const [c, t] = m[state] || ["", state || "–"];
  return `<span class="pill ${c}">${esc(t)}</span>`;
}
const diskTotal = (d) => !d ? null : d.fs ? Object.values(d.fs).reduce((a, x) => a + x.used, 0) : d.at ? Object.entries(d).reduce((a, [k, v]) => a + (k !== "at" && typeof v === "number" ? v : 0), 0) : null;
const limitsText = (e) => [memStr(e.MEMORY), e.CPUS ? `${e.CPUS} CPUs` : "all CPUs", e.CPUSET ? `pinned to ${e.CPUSET}` : "", e.GPU === "none" ? "no GPU" : "GPU"].filter(Boolean).join(", ");

// ------------------------------------------------------------------ login / navigation
function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); clearInterval(timer); }
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#loginErr").textContent = "";
  try { await api("POST", "login", { user: f.get("user"), password: f.get("password"), code: f.get("code") || undefined }); start(); }
  catch (err) { if (/6-digit code/.test(err.message)) { $("#codeRow").classList.remove("hidden"); $("#loginForm [name=code]").focus(); } $("#loginErr").textContent = err.message; }
});
$("#logoutBtn").addEventListener("click", async () => { await api("POST", "logout", {}).catch(() => {}); location.reload(); });
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) show(b.dataset.tab); });

async function start() {
  try { ME = await api("GET", "me"); } catch (e) { return; }
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#adminName").textContent = `${ME.user}, ${ME.role}`; 
  applyBrand(ME);
  PREFS = ME.prefs || PREFS; window.labLook(PREFS);
  ME.storage.forEach((d) => (FSN[d.path] = d.label));
  api("GET", "system/updates").then((u) => ($("#updCount").textContent = u.upgradable.length || "")).catch(() => {});
  $$(".hostip").forEach((x) => (x.textContent = location.hostname));
  show(TAB);
  startTimer();
}
// ------------------------------------------------------------------ refreshing: on a timer the person chooses, or by hand
function startTimer() {
  clearInterval(timer);
  if (PREFS.refresh) timer = setInterval(() => { if (!document.hidden && !$("#dlg").open) refresh(); }, PREFS.refresh * 1000);
  noteRefresh();
}
const everyStr = (n) => !n ? "Refreshing by hand only" : n < 60 ? `Every ${n} s` : "Every minute";
function noteRefresh() {
  const t = LAST ? new Date(LAST).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  $("#refreshNote").innerHTML = (t ? `<b>Updated ${t}</b><br>` : "") + esc(TAB === "settings" ? "Settings refresh by hand only" : everyStr(PREFS.refresh));
}
async function refreshNow() {
  const b = $("#refreshBtn");
  if (b.classList.contains("busy")) return;
  b.classList.add("busy");
  try { await reload(); } finally { b.classList.remove("busy"); }
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
  reload();
}
// redraw the current tab now (after an action or the Refresh button); the timer uses refresh(), which leaves Settings alone
function reload() { return TAB === "settings" ? loadSettings().then(stamp, () => {}) : refresh(); }
// Settings holds forms only and is not redrawn on the timer, so nothing typed there is lost; jobs poll their own logs.
function refresh() {
  if (TAB === "settings") return Promise.resolve();
  return ({ overview: loadOverview, users: loadUsers, llm: loadLLM, audit: loadAudit })[TAB]().then(stamp, () => {});
}
function stamp() { LAST = Date.now(); noteRefresh(); }

// ------------------------------------------------------------------ overview: the shared-pool ledger
function ledgerRow(name, sub, total, segs, totalText, totalSub) {
  const used = segs.reduce((a, s) => a + s.v, 0);
  const html = segs.filter((s) => s.v > 0).map((s) => {
    const w = (100 * s.v) / total;
    return `<i class="${s.light ? "light" : ""}" style="width:${w.toFixed(2)}%;background:${s.c}" title="${esc(s.n)}: ${esc(s.t)}">${w > 18 ? `<span>${esc(s.n)}</span>` : ""}</i>`;
  }).join("");
  const keys = segs.filter((s) => s.v > total * 0.001).map((s) => `<span><em style="background:${s.c}"></em>${esc(s.n)} <b>${esc(s.t)}</b></span>`).join("")
    + `<span><em style="background:var(--rule-soft);border:1px solid var(--rule)"></em>free <b>${esc(totalSub.free)}</b></span>`;
  return `<div class="lrow"><div class="name">${name}<small>${sub}</small></div>
    <div><div class="stack" role="img" aria-label="${esc(name)}: ${Math.round((100 * used) / total)}% in use">${html}</div><div class="keys">${keys}</div></div>
    <div class="total">${totalText}<small>${esc(totalSub.of)}</small></div></div>`;
}
function renderLedger() {
  const s = OV.sys, g = s.gpu || {}, C = OV.containers;
  const people = Object.entries(C).filter(([k, c]) => k.startsWith("lab-") && c.state === "running").map(([k, c]) => ({ name: k.slice(4), ...c }));
  const color = (i) => `var(${PALETTE[i % PALETTE.length]})`;
  const eng = C.engine || {};
  const gTot = g.mem_total || 1, gUsers = people.map((p, i) => ({ n: p.name, v: p.gpu_mib || 0, c: color(i), t: gb(p.gpu_mib || 0) }));
  const gKnown = (eng.gpu_mib || 0) + gUsers.reduce((a, x) => a + x.v, 0), gOther = Math.max(0, (g.mem_used || 0) - gKnown);
  const gSegs = [{ n: "language model", v: eng.gpu_mib || 0, c: "var(--s-engine)", t: gb(eng.gpu_mib || 0) }, ...gUsers, { n: "other", v: gOther, c: "var(--s-cache)", t: gb(gOther), light: true }];
  const mTot = s.mem_total, mUsers = people.map((p, i) => ({ n: p.name, v: p.mem_anon || 0, c: color(i), t: fmtB(p.mem_anon || 0) }));
  const mKnown = (eng.mem_anon || 0) + mUsers.reduce((a, x) => a + x.v, 0), mOther = Math.max(0, s.mem_used - mKnown);
  const mSegs = [{ n: "language model", v: eng.mem_anon || 0, c: "var(--s-engine)", t: fmtB(eng.mem_anon || 0) }, ...mUsers, { n: "system", v: mOther, c: "var(--s-cache)", t: fmtB(mOther), light: true }];
  const cTot = s.ncpu, cUsers = people.map((p, i) => ({ n: p.name, v: (p.cpu || 0) / 100, c: color(i), t: ((p.cpu || 0) / 100).toFixed(1) + " cores" }));
  const cAll = (s.cpu / 100) * cTot, cKnown = (eng.cpu || 0) / 100 + cUsers.reduce((a, x) => a + x.v, 0), cOther = Math.max(0, cAll - cKnown);
  const cSegs = [{ n: "language model", v: (eng.cpu || 0) / 100, c: "var(--s-engine)", t: ((eng.cpu || 0) / 100).toFixed(1) + " cores" }, ...cUsers, { n: "system", v: cOther, c: "var(--s-cache)", t: cOther.toFixed(1) + " cores", light: true }];
  $("#ledger").innerHTML =
    ledgerRow("GPU memory", esc((g.name || "GPU").replace("NVIDIA ", "").replace(" Workstation Edition", "")), gTot, gSegs, gb(g.mem_used || 0), { of: `of ${gb(gTot)}`, free: gb(Math.max(0, gTot - (g.mem_used || 0))) }) +
    ledgerRow("Memory", "shared; limits are caps, not reservations", mTot, mSegs, fmtB(s.mem_used), { of: `of ${fmtB(mTot)}`, free: fmtB(mTot - s.mem_used) }) +
    ledgerRow("CPU", cpuSummary(), cTot, cSegs, cAll.toFixed(1), { of: `of ${cTot} cores busy`, free: (cTot - cAll).toFixed(1) + " cores" });
}
async function loadOverview() {
  OV = await api("GET", "overview");
  const s = OV.sys, g = s.gpu || {}, h = OV.hist, col = (i) => h.map((r) => r[i]);
  $("#userCount").textContent = OV.users.length || "";
  renderLedger();
  const up = s.uptime / 86400;
  const every = { 0: "Readings refresh when you press Refresh.", 60: "Readings refresh every minute." }[PREFS.refresh] || `Readings refresh every ${PREFS.refresh} seconds.`;
  $("#ovLede").textContent = `${every} Up ${up >= 1 ? up.toFixed(1) + " days" : (s.uptime / 3600).toFixed(1) + " hours"} since the last restart.`;
  $("#tiles").innerHTML = [
    ["GPU load", `${g.util ?? 0}<small>%</small>`, `${g.temp ?? "–"} °C, fan ${g.fan ?? "–"}%`, spark(col(3), 100, "var(--p2)")],
    ["GPU power", `${g.power != null ? g.power.toFixed(0) : "–"}<small>W</small>`, `limit ${g.power_limit?.toFixed(0) ?? "–"} W`, spark(col(5), g.power_limit, "var(--p6)")],
    ["CPU", `${(s.cpu ?? 0).toFixed(0)}<small>%</small>`, `load ${s.load?.[0]} over 1 min`, spark(col(1), 100, "var(--p1)")],
    ["Memory in use", `${(100 * s.mem_used / s.mem_total).toFixed(0)}<small>%</small>`, `swap ${fmtB(s.swap_used)} used`, spark(col(2), 100, "var(--p3)")],
  ].map(([k, v, sub, sv]) => `<div class="reading"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div>${sv}</div>`).join("");
  $("#strataPill").innerHTML = enginePill(OV.strata, OV.containers.engine);
  $("#strataBox").innerHTML = engineSummary(OV.strata, OV.containers.engine);
  $("#diskBox").innerHTML = (s.disks || []).filter((d) => d.total).map((d) =>
    `<div class="disk">${meter(d.used, d.total, `<b>${esc(FSN[d.path] || d.label)}</b> <span class="sub">${esc(d.path)}</span>`, `${fmtB(d.used)} of ${fmtB(d.total)}`)}
      ${d.model ? `<span class="model" title="${esc(d.model)}">${esc(d.model)}</span>` : ""}</div>`).join("");
  const rows = OV.users.map((u) => {
    const c = u.container || {}, run = c.state === "running";
    return `<tr class="click" data-user="${esc(u.name)}"><td class="who"><b>${esc(u.name)}</b><small>${esc(u.full_name)}</small></td><td>${pill(c.state, u.disabled)}</td>
      <td class="num">${run ? ((c.cpu ?? 0) / 100).toFixed(1) + " cores" : "–"}</td>
      <td>${run ? meter(c.mem, c.mem_limit || s.mem_total, fmtB(c.mem), c.mem_limit ? "of " + fmtB(c.mem_limit) : "") : "–"}</td>
      <td class="num">${c.gpu_mib ? gb(c.gpu_mib) : "–"}</td>
      <td class="num">${fmtN(u.llm_today.prompt + u.llm_today.completion)}${u.daily_tokens ? ` <span class="sub">of ${fmtN(u.daily_tokens)}</span>` : ""}</td>
      <td>${ago(u.last_login)}</td></tr>`;
  });
  $("#usageTable").innerHTML = `<thead><tr><th>Person</th><th>Container</th><th class="num">CPU</th><th>Memory</th><th class="num">GPU memory</th><th class="num">Model tokens today</th><th>Last sign-in</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="7" class="empty">Nobody has an account yet. Add people on the People page.</td></tr>'}</tbody>`;
}
function enginePill(st, cont) {
  if (!cont || cont.state !== "running") return '<span class="pill bad">Stopped</span>';
  if (!st.reachable) return '<span class="pill warn">Loading</span>';
  return st.running ? `<span class="pill ok">Answering ${st.running} of ${st.parallel}</span>` : '<span class="pill ok">Ready</span>';
}
function engineSummary(st, cont) {
  if (!st.reachable) return `<p class="sub" style="margin:0">${cont && cont.state === "running" ? "The model is loading. This takes one to two minutes after a start." : "The engine is stopped. Start it on the Language model page."}</p>`;
  const slots = (st.slots || []).map((x, i) => {
    const busy = x.state && x.state !== "idle";
    const what = x.state === "reading" && x.prompt_total ? `reading ${fmtN(x.prompt_read)} of ${fmtN(x.prompt_total)}` : busy ? `${esc(x.state)}${x.tok_s ? `, ${x.tok_s.toFixed(0)} tok/s` : ""}` : "free";
    return `<div class="slot ${busy ? "busy" : ""}"><b>Slot ${i + 1}</b>${what}</div>`;
  }).join("");
  const last = (st.recent || []).filter((r) => r.decode_tok_s).slice(-1)[0];
  return `<dl class="kv"><dt>Model</dt><dd>${esc(st.model)}</dd>
    <dt>Context</dt><dd>${fmtN(st.context)} tokens per request${st.kv ? `, ${esc(st.kv)} cache` : ""}</dd>
    <dt>Engine</dt><dd>${st.engine === "custom" ? "custom image" : `Strata engine ${esc(st.engine)}, ${esc(st.drafting)} drafting`}</dd>
    <dt>Queue</dt><dd>${st.running || 0} answering, ${st.waiting || 0} waiting</dd>
    <dt>Last answer</dt><dd>${last ? `${last.decode_tok_s.toFixed(0)} tokens/s over ${fmtN(last.output)} tokens` : "–"}</dd></dl>${slots ? `<div class="slots">${slots}</div>` : ""}`;
}
$("#usageTable").addEventListener("click", (e) => { const r = e.target.closest("tr[data-user]"); if (r) openUser(r.dataset.user); });

// ------------------------------------------------------------------ people
async function loadUsers() { USERS = await api("GET", "users"); $("#userCount").textContent = USERS.length || ""; renderUsers(); }
function renderUsers() {
  const q = $("#userFilter").value.trim().toLowerCase();
  const list = USERS.filter((u) => !q || (u.name + " " + u.full_name + " " + u.email).toLowerCase().includes(q));
  const rows = list.map((u) => {
    const c = u.container || {}, d = u.disk || {}, run = c.state === "running", dt = diskTotal(d);
    return `<tr class="click" data-user="${esc(u.name)}">
      <td class="who"><b>${esc(u.name)}</b><small>${esc(u.full_name || u.email || "")}</small></td>
      <td>${pill(c.state, u.disabled)}</td>
      <td class="sub">${esc(limitsText(u.effective))}</td>
      <td class="num">${run ? ((c.cpu ?? 0) / 100).toFixed(1) : "–"}</td>
      <td class="num">${run ? fmtB(c.mem) : "–"}</td>
      <td class="num">${c.gpu_mib ? gb(c.gpu_mib) : "–"}</td>
      <td class="num">${u.gpu_30d?.held_h ? `${hrs(u.gpu_30d.busy_h)} <span class="sub">of ${hrs(u.gpu_30d.held_h)}</span>` : "–"}</td>
      <td class="num">${dt != null ? fmtB(dt) : "…"}</td>
      <td class="sub">${esc(FSN[u.home_fs] || "")}</td>
      <td class="num">${u.llm_enabled ? fmtN(u.llm_today.prompt + u.llm_today.completion) + (u.daily_tokens ? ` <span class="sub">of ${fmtN(u.daily_tokens)}</span>` : "") : '<span class="sub">off</span>'}</td>
      <td>${ago(u.last_login)}</td></tr>`;
  });
  $("#usersTable").innerHTML = `<thead><tr><th>Person</th><th>Container</th><th>Limits</th><th class="num">CPU cores</th><th class="num">Memory</th><th class="num">GPU memory</th><th class="num" title="Hours the GPU spent computing for them, of the hours they held GPU memory, over 30 days">GPU time, 30 days</th><th class="num">Disk used</th><th>Home on</th><th class="num">Model tokens today</th><th>Last sign-in</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="11" class="empty">${USERS.length ? "Nobody matches that search." : "No accounts yet. Add the first person with “Add person”."}</td></tr>`}</tbody>`;
}
$("#userFilter").addEventListener("input", renderUsers);
$("#usersTable").addEventListener("click", (e) => { const r = e.target.closest("tr[data-user]"); if (r) openUser(r.dataset.user); });

function dialog(html, kind = "drawer") { const d = $("#dlg"); d.className = kind; $("#dlgBody").innerHTML = html; if (!d.open) d.showModal(); return d; }
function closeDlg() { $("#dlg").close(); reload(); }
$("#dlg").addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === $("#dlg")) closeDlg(); });

function randomPw() {
  const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = new Uint32Array(14);
  crypto.getRandomValues(b); return [...b].map((x) => a[x % a.length]).join("");
}
const cpuHint = () => (ME.cpu.groups.length > 1 ? ME.cpu.groups.map((g) => `${g.cpus} are ${g.kind} cores`).join(", ") + ". " : `CPUs 0-${ME.ncpu - 1}. `) + "Leave empty for any.";
const cpuSummary = () => `${ME.cpu.ncpu} cores` + (ME.cpu.groups.length > 1 ? ": " + ME.cpu.groups.map((g) => `${g.count} ${g.kind}`).join(", ") : "");
// One row per disk: can the person use it (their data folder is mounted), and how much space may they fill there.
// The limit stays editable when the disk holds their home folder or container system files, even without data access.
function storageRows(st) {
  const rows = ME.storage.map((d) => {
    const home = d.homes && st.homeBase === d.homes, sys = ME.container_fs === d.path, quota = (ME.quota_fs || []).includes(d.path);
    const access = d.data ? st.data.includes(d.data) : false, lim = st.quotas?.[d.path] ?? 0;
    const why = [sys && "container system files", d.data && `data folder ${d.data}/${st.name || "name"}`].filter(Boolean).join(", ");
    return `<div class="disk-row" data-path="${esc(d.path)}" data-homes="${esc(d.homes || "")}">
      <div title="${esc(d.model || "")}"><b>${esc(d.label)}</b> <span class="sub">${esc(d.path)}</span><div class="hint"><span class="homehere">home folder${why ? ", " : ""}</span>${esc(why)}</div></div>
      <label class="check">${d.data ? `<input type="checkbox" class="acc" data-root="${esc(d.data)}" ${access ? "checked" : ""}> Data folder` : '<span class="sub">no data folder</span>'}</label>
      ${quota ? `<span class="inline lim"><input type="number" min="1" class="cap" value="${lim || ""}" placeholder="GB" aria-label="Limit in GB on ${esc(d.path)}"><label class="check"><input type="checkbox" class="unl" ${lim ? "" : "checked"}> No limit</label></span>` : '<span class="sub">no disk accounting</span>'}
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
  dialog(`<div class="dlg-h"><div><h2>Add a person</h2><p class="sub">They can sign in as soon as you save. Their container is created at the first sign-in.</p></div><button class="x" data-close aria-label="Close">×</button></div>
  <form id="addForm"><div class="dlg-b"><div class="form">
    <div class="form-sec">Account</div>
    <label>User name<input name="name" required pattern="[a-z_][a-z0-9_\\-]{0,31}" placeholder="jsmith" autocomplete="off"><span class="hint">lowercase letters, digits, - and _</span></label>
    <label>Full name<input name="full_name"></label>
    <label>Email<input name="email" type="email"></label>
    <label>Password<span class="inline"><input name="password" minlength="8" autocomplete="new-password" placeholder="at least 8 characters"><button type="button" class="btn sm" id="genPw">Generate</button></span></label>
    <label class="full">SSH public key<textarea name="pubkey" rows="2" placeholder="ssh-ed25519 AAAA… (a password, a key, or both)"></textarea></label>
    <label class="full">Note<input name="note" placeholder="project, advisor, end date"></label>
    <div class="form-sec">Resources</div>
    <label>Memory limit<input name="memory" placeholder="${esc(memStr(USERS[0]?.effective.MEMORY || "24g"))}" pattern="[0-9]+[mg]"><span class="hint">a cap such as 32g; nothing is reserved up front</span></label>
    <label>CPU limit<input name="cpus" placeholder="no limit" pattern="[0-9.]+"><span class="hint">cores' worth of time, such as 8</span></label>
    <label>Pin to CPUs<input name="cpuset" placeholder="any" pattern="[0-9,\\-]+"><span class="hint">${cpuHint()}</span></label>
    <label>GPU<select name="gpu"><option value="all">Shared GPU</option><option value="none">No GPU</option></select></label>
    <label class="check full"><input type="checkbox" name="sudo_on" ${ME.default_sudo ? "checked" : ""}> Admin rights inside their container (sudo, apt install). Without them, pip, uv and conda still work.</label>
    <div class="form-sec">Storage</div>
    <label>Home folder on<select name="home_base">${Object.entries(ME.home_bases || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select><span class="hint">NVMe is far faster for code, environments and many small files</span></label>
    <span></span>
    <div class="full" id="addDisks">${storageRows({ homeBase: Object.keys(ME.home_bases)[0], data: ME.data_roots, quotas: ME.default_quota_gb })}</div>
    <div class="form-sec">Language model</div>
    <label>Tokens per day<input name="daily_tokens" type="number" min="0" value="0"><span class="hint">0 for no limit</span></label>
    <label>Requests at once<input name="concurrency" type="number" min="1" max="8" value="2"><span class="hint">the engine answers ${ENG?.serving?.concurrency || 4} at once for everyone</span></label>
  </div></div>
  <div class="dlg-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add person</button></div></form>`, "center");
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
    await act(() => api("POST", "users", f), `Added ${f.name}. They can sign in with ssh ${f.name}@${location.hostname}`);
    closeDlg(); show("users");
  });
});

async function openUser(name, sub = "settings") {
  const [list, det] = await Promise.all([api("GET", "users"), api("GET", "users/" + encodeURIComponent(name))]);
  USERS = list;
  const u = list.find((x) => x.name === name);
  if (!u) return toast(`${name} no longer exists.`, true);
  const c = u.container || {}, L = u.limits, d = u.disk || {}, run = c.state === "running";
  const fsRows = Object.entries((d && d.fs) || {});
  const tabs = [["settings", "Settings"], ["access", "Sign-in and keys"], ["storage", "Storage"], ["usage", "Usage"], ["container", "Container"]];
  const body = {
    settings: `<form id="editForm" class="form">
      <div class="form-sec">Profile</div>
      <label>Full name<input name="full_name" value="${esc(u.full_name)}"></label>
      <label>Email<input name="email" value="${esc(u.email)}"></label>
      <label class="full">Note<input name="note" value="${esc(u.note)}"></label>
      <div class="form-sec">Resources</div>
      <label>Memory limit<input name="memory" value="${esc(L.MEMORY)}" placeholder="default, ${esc(memStr(u.effective.MEMORY))}" pattern="[0-9]+[mg]"></label>
      <label>CPU limit<input name="cpus" value="${esc(L.CPUS)}" placeholder="no limit" pattern="[0-9.]+"><span class="hint">cores' worth of time</span></label>
      <label>Pin to CPUs<input name="cpuset" value="${esc(L.CPUSET)}" placeholder="any" pattern="[0-9,\\-]*"><span class="hint">${cpuHint()}</span></label>
      <label>GPU<select name="gpu"><option value="">Shared GPU</option><option value="none" ${L.GPU === "none" ? "selected" : ""}>No GPU</option></select></label>
      <label class="check full"><input type="checkbox" name="sudo_on" ${u.effective.SUDO === "yes" ? "checked" : ""}> Admin rights inside the container (sudo, apt install). Takes effect after a rebuild.</label>
      <div class="form-sec">Language model</div>
      <label class="check full"><input type="checkbox" name="llm_enabled" ${u.llm_enabled ? "checked" : ""}> Can use the lab's language model</label>
      <label>Tokens per day<input name="daily_tokens" type="number" min="0" value="${u.daily_tokens}"><span class="hint">0 for no limit; ${fmtN(u.llm_today.prompt + u.llm_today.completion)} used today</span></label>
      <label>Requests at once<input name="concurrency" type="number" min="1" max="8" value="${u.concurrency}"></label>
      <div class="full actions" style="margin-top:2px"><button class="btn primary" type="submit">Save changes</button></div></form>
      <div class="part ${u.disabled ? "" : "danger"}"><h3>${u.disabled ? "This account is disabled" : "Disable the account"}</h3>
        <p class="sub">${u.disabled ? "Sign-in and the model key are blocked. Files are kept." : "Blocks sign-in and the model key and stops the container. Files are kept."}</p>
        <div><button class="btn ${u.disabled ? "primary" : "quiet-danger"}" id="toggleDis">${u.disabled ? "Enable the account" : "Disable the account"}</button></div></div>
      <div class="part danger"><h3>Delete ${esc(name)}</h3>
        <label class="check"><input type="checkbox" id="purge"> Also delete their files: home folder${ME.data_roots.map((r) => `, ${esc(r)}/${esc(name)}`).join("")}</label>
        <div class="inline"><input id="delConfirm" placeholder="Type ${esc(name)} to confirm" aria-label="Type the user name to confirm"><button class="btn danger" id="delBtn">Delete</button></div></div>`,
    access: `<div class="part"><h3>Password</h3><div class="inline"><input id="newPw" placeholder="new password, at least 8 characters" autocomplete="new-password"><button class="btn sm" id="genPw2">Generate</button><button id="setPw" class="btn primary">Set password</button></div></div>
      <div class="part"><h3>SSH keys</h3>${det.ssh_keys.length ? `<table><tbody>${det.ssh_keys.map((k) => `<tr><td>${esc(k.comment || "no comment")}</td><td class="sub">${esc(k.type)}, ends …${esc(k.fingerprint)}</td><td class="num"><button class="btn sm quiet-danger" data-rmkey="${k.index}">Remove</button></td></tr>`).join("")}</tbody></table>` : '<p class="sub">No keys yet.</p>'}
        <textarea id="newKey" rows="2" placeholder="ssh-ed25519 AAAA… name@laptop" aria-label="New SSH public key"></textarea><div><button class="btn" id="addKey">Add key</button></div></div>
      <div class="part"><h3>Language model key</h3><p class="sub">Already set as <code>$OPENAI_API_KEY</code> in ${esc(name)}'s container. From a laptop on the lab network, use <code>http://${esc(location.hostname)}:${ME.gateway_port}/v1</code>.</p>
        <div class="inline"><code class="key" id="keyShow">${esc(u.key_prefix || "rl-")}…</code><button class="btn sm" id="showKey">Show</button><button class="btn sm" id="copyKey">Copy</button><button class="btn sm quiet-danger" id="regenKey">Replace key</button></div></div>`,
    storage: `<div class="part"><dl class="kv"><dt>Home folder</dt><dd><code>${esc(u.home)}</code> on ${esc(FSN[u.home_fs] || u.home_fs)}</dd>
        <dt>Data folders</dt><dd>${u.effective.DATA.length ? u.effective.DATA.map((r) => `<code>${esc(r)}/${esc(name)}</code>`).join(", ") : "none"}</dd></dl></div>
      <div class="part"><h3>Space used</h3>${fsRows.length ? fsRows.map(([fs, x]) => meter(x.used, x.limit || 0, `<b>${esc(fs)}</b>`, `${fmtB(x.used)} ${x.limit ? "of " + fmtB(x.limit) : "used, no limit"}`)).join("") : '<p class="sub">Disk accounting is not available.</p>'}
        <p class="hint">Counts every file ${esc(name)} owns on that disk, including packages they install in their container.</p></div>
      <form id="quotaForm" class="part"><h3>Disk access and limits</h3>
        <div id="userDisks">${storageRows({ name, homeBase: Object.keys(ME.home_bases).find((b) => u.home.startsWith(b + "/")), data: u.effective.DATA, quotas: Object.fromEntries(fsRows.map(([fs, x]) => [fs, Math.round(x.limit / GiB)])) })}</div>
        <p class="hint">A limit counts every file ${esc(name)} owns on that disk. Data-folder changes take effect after a rebuild.</p>
        <div><button class="btn primary" type="submit">Save disk settings</button></div></form>
      <div class="part"><h3>Move the home folder</h3><p class="sub">Closes ${esc(name)}'s sessions, copies the folder, then removes the old copy.</p>
        <div class="inline"><select id="moveBase" aria-label="New location">${Object.entries(ME.home_bases || {}).filter(([k]) => !u.home.startsWith(k + "/")).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select><button class="btn" id="moveBtn">Move home folder</button></div><pre id="moveLog" class="joblog hidden"></pre></div>`,
    usage: `<div class="part"><h3>GPU, last 30 days</h3>${bars(det.gpu_days, ["busy", "idle"], ["var(--p1)", "var(--p3)"], ["computing", "holding memory, idle"], { unit: "hours", fmt: hrs, empty: "No GPU use in the last 30 days.", aria: "GPU hours per day" })}
        <p class="hint">Computing counts the share of the GPU their programs kept busy, so two hours at 50% is one hour. ${(() => { const p = Math.max(0, ...det.gpu_days.map((x) => x.peak_gib)); return p ? `Most GPU memory held at once: ${p} GB.` : ""; })()}</p></div>
      <div class="part"><h3>Language model, last 30 days</h3>${bars(det.usage_days, ["p", "c"], ["var(--p3)", "var(--p1)"], ["prompt", "answer"])}</div>
      <div class="part"><h3>Container, last hour</h3><div class="form">
        <div><div class="hint">CPU, % of one core</div>${spark(det.history.map((r) => r[1]), null, "var(--p1)")}</div>
        <div><div class="hint">Memory</div>${spark(det.history.map((r) => r[2]), null, "var(--p3)")}</div>
        <div><div class="hint">GPU memory</div>${spark(det.history.map((r) => r[3]), null, "var(--p4)")}</div></div></div>
      <div class="part"><h3>Recent requests</h3><div class="table-wrap tall">${reqTable(det.recent, false)}</div></div>`,
    container: `<div class="part"><dl class="kv"><dt>State</dt><dd>${pill(c.state, u.disabled)} <span class="sub">${esc(c.status || "")}</span></dd>
        <dt>Image</dt><dd>${esc(c.image || "–")}</dd>
        <dt>Limits</dt><dd>${esc(limitsText(u.effective))}</dd>
        <dt>Right now</dt><dd>${run ? `${((c.cpu ?? 0) / 100).toFixed(1)} cores, ${fmtB(c.mem)} memory, ${c.pids} processes, ${gb(c.gpu_mib)} GPU memory` : "–"}</dd>
        <dt>Last sign-in</dt><dd>${u.last_login ? fmtT(u.last_login) : "never"}</dd></dl>
      <div class="actions"><button class="btn" data-cact="start">Start</button><button class="btn" data-cact="restart">Restart</button><button class="btn" data-cact="stop">Stop</button>
        <button class="btn quiet-danger" data-cact="rebuild">Rebuild</button></div>
      <p class="hint">Rebuild recreates the container from the current image at the next sign-in, picking up image and GPU changes. Home and data folders are kept; system packages installed inside the container are not.</p></div>`,
  };
  dialog(`<div class="dlg-h"><div><h2>${esc(name)}</h2><p class="sub">${esc([u.full_name, u.email].filter(Boolean).join(", ") || "No name on file")}</p></div><button class="x" data-close aria-label="Close">×</button></div>
    <div class="subtabs" role="tablist">${tabs.map(([t, l]) => `<button role="tab" data-sub="${t}" class="${t === sub ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="dlg-b">${body[sub]}</div>`);
  const D = $("#dlgBody"), reopen = (s = sub) => openUser(name, s), P = "users/" + encodeURIComponent(name);
  $$("[data-sub]", D).forEach((b) => b.addEventListener("click", () => openUser(name, b.dataset.sub)));
  if (sub === "settings") {
    $("#editForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      delete f.sudo_on;
      const r = await act(() => api("PATCH", P, { ...f, sudo: e.target.sudo_on.checked ? "yes" : "no", llm_enabled: e.target.llm_enabled.checked ? 1 : 0, daily_tokens: +f.daily_tokens || 0, concurrency: +f.concurrency || 1 }),
        (r) => "Saved" + (r.note ? `. ${r.note[0].toUpperCase() + r.note.slice(1)}.` : "."));
      if (r) reopen();
    });
    $("#toggleDis").addEventListener("click", async () => { await act(() => api("PATCH", P, { disabled: !u.disabled }), u.disabled ? `Enabled ${name}.` : `Disabled ${name}.`); reopen(); });
    $("#delBtn").addEventListener("click", async () => {
      if ($("#delConfirm").value !== name) return toast(`Type ${name} in the box to confirm.`, true);
      await act(() => api("DELETE", P + ($("#purge").checked ? "?purge=1" : "")), `Deleted ${name}.`); closeDlg();
    });
  }
  if (sub === "access") {
    $("#genPw2").addEventListener("click", () => ($("#newPw").value = randomPw()));
    $("#setPw").addEventListener("click", () => act(() => api("POST", P + "/password", { password: $("#newPw").value }), "Password set."));
    $("#addKey").addEventListener("click", async () => { await act(() => api("POST", P + "/keys", { pubkey: $("#newKey").value }), "Key added."); reopen(); });
    $$("[data-rmkey]", D).forEach((b) => b.addEventListener("click", async () => { await act(() => api("DELETE", P + "/keys/" + b.dataset.rmkey), "Key removed."); reopen(); }));
    let key = null;
    const getKey = async () => (key ||= (await api("GET", P + "/llm-key")).key);
    $("#showKey").addEventListener("click", async () => ($("#keyShow").textContent = await getKey()));
    $("#copyKey").addEventListener("click", async () => { const k = await getKey(); try { await navigator.clipboard.writeText(k); toast("Key copied."); } catch (e) { $("#keyShow").textContent = k; toast("The browser blocked copying, so the key is shown instead."); } });
    $("#regenKey").addEventListener("click", async () => {
      if (!confirm(`Replace ${name}'s key? The old key stops working right away. New shells in their container pick up the new one.`)) return;
      key = (await act(() => api("POST", P + "/llm-key", {}), "Key replaced.")).key; $("#keyShow").textContent = key;
    });
  }
  if (sub === "storage") {
    wireStorage($("#userDisks"), () => Object.keys(ME.home_bases).find((b) => u.home.startsWith(b + "/")));
    $("#quotaForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await act(() => api("PATCH", P, readStorage($("#userDisks"))), (r) => "Disk settings saved" + (r.note ? `. ${r.note[0].toUpperCase() + r.note.slice(1)}.` : "."));
      if (r) setTimeout(() => reopen(), 1200);
    });
    $("#moveBtn")?.addEventListener("click", async () => {
      const base = $("#moveBase").value;
      if (!confirm(`Move ${name}'s home folder to ${base}/${name}? Their sessions close while it copies.`)) return;
      await act(() => api("POST", "storage/move-home", { user: name, base }), "Moving the home folder…");
      const log = $("#moveLog"); log.classList.remove("hidden");
      const poll = setInterval(async () => {
        const j = (await api("GET", "jobs"))[0];
        if (j) log.textContent = j.log.join("\n");
        if (!j || j.state !== "running") { clearInterval(poll); toast(j && j.state === "done" ? "Home folder moved." : "The move failed. See the log.", !j || j.state !== "done"); }
      }, 2000);
    });
  }
  if (sub === "container") {
    $$("[data-cact]", D).forEach((b) => b.addEventListener("click", async () => {
      const a = b.dataset.cact, label = { start: "Started", stop: "Stopped", restart: "Restarted", rebuild: "Rebuilt" }[a];
      if ((a === "rebuild" || a === "stop") && !confirm(`${b.textContent} lab-${name}? ${name}'s open sessions will close.`)) return;
      b.disabled = true;
      await act(() => api("POST", P + "/container", { action: a }), `${label} lab-${name}.`).catch(() => {});
      setTimeout(() => reopen(), 800);
    }));
  }
}

// ------------------------------------------------------------------ language model
function reqTable(rows, withUser = true) {
  if (!rows.length) return '<p class="empty">No requests yet.</p>';
  return `<table><thead><tr><th>Time</th>${withUser ? "<th>Person</th>" : ""}<th>API</th><th class="num">Prompt</th><th class="num">Answer</th><th class="num">First token</th><th class="num">Total</th><th>Result</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtT(r.ts)}</td>${withUser ? `<td>${esc(r.user)}</td>` : ""}<td>${esc(r.endpoint.replace("/v1/", ""))}${r.stream ? ' <span class="sub">streamed</span>' : ""}</td><td class="num">${fmtN(r.prompt)}</td><td class="num">${fmtN(r.completion)}</td><td class="num">${r.ttft_ms != null ? (r.ttft_ms / 1000).toFixed(1) + " s" : "–"}</td><td class="num">${(r.ms / 1000).toFixed(1)} s</td><td>${r.status === 499 ? '<span class="pill warn">Cancelled</span>' : r.status >= 400 ? `<span class="pill bad">Error ${r.status}</span>` : '<span class="pill ok">OK</span>'}</td></tr>`).join("")}</tbody></table>`;
}
async function loadLLM() {
  const [d, ov] = await Promise.all([api("GET", "llm"), api("GET", "overview")]);
  OV = ov;
  const cont = ov.containers.engine;
  $("#strataPill2").innerHTML = enginePill(d.strata, cont);
  $("#strataDetail").innerHTML = engineSummary(d.strata, cont) + (cont ? `<p class="hint" style="margin:12px 0 0">Holding ${gb(cont.gpu_mib)} of GPU memory and ${fmtB(cont.mem_anon)} of RAM. Container ${esc(cont.status.toLowerCase())}.</p>` : "");
  const g = d.gateway, base = `http://${location.hostname}:${g.port}`;
  $("#gwBox").innerHTML = `<dl class="kv"><dt>Gateway</dt><dd>${g.active === "active" ? '<span class="pill ok">Running</span>' : `<span class="pill bad">${esc(g.active)}</span>`}</dd>
    <dt>OpenAI style</dt><dd><code>${esc(base)}/v1</code></dd><dt>Anthropic style</dt><dd><code>${esc(base)}</code></dd>
    <dt>Model name</dt><dd><code>${esc(g.model)}</code></dd>
    <dt>Keys</dt><dd>One per person, under People, Sign-in and keys. Daily limits and requests at once are set per person.</dd>
    <dt>In containers</dt><dd>Already set up: <code>$OPENAI_BASE_URL</code>, <code>$ANTHROPIC_BASE_URL</code>, and the person's key.</dd></dl>`;
  if (!ENG_RENDERED) await loadEngine();
  else updateJobs(await api("GET", "jobs"));
  $("#llmChart").innerHTML = bars(d.days, ["p", "c"], ["var(--p3)", "var(--p1)"], ["prompt", "answer"]);
  $("#llmUsers").innerHTML = `<thead><tr><th>Person</th><th class="num">Requests</th><th class="num">Prompt tokens</th><th class="num">Answer tokens</th><th class="num">Average speed</th><th class="num">Errors</th></tr></thead><tbody>${d.per_user.map((r) => `<tr><td>${esc(r.user)}</td><td class="num">${fmtN(r.n)}</td><td class="num">${fmtN(r.p)}</td><td class="num">${fmtN(r.c)}</td><td class="num">${r.tps ? r.tps.toFixed(0) + " tok/s" : "–"}</td><td class="num">${r.err}</td></tr>`).join("") || '<tr><td colspan="6" class="empty">No requests yet.</td></tr>'}</tbody>`;
  $("#llmRecent").innerHTML = reqTable(d.recent);
}
$$("[data-strata]").forEach((b) => b.addEventListener("click", async () => {
  const a = b.dataset.strata, label = { start: "Started", stop: "Stopped", restart: "Restarted" }[a];
  if (a !== "start" && !confirm(`${b.textContent}? Answers in progress are cut off, and loading takes one to two minutes.`)) return;
  b.disabled = true;
  await act(() => api("POST", "strata", { action: a }), `${label} the engine.`).catch(() => {});
  b.disabled = false; reload();
}));

// ------------------------------------------------------------------ engine settings
const opt = (vals, cur, labels = {}) => vals.map((v) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(labels[v] ?? v)}</option>`).join("");
function updateJobs(jobs) {
  const j = jobs && jobs[0], box = $("#jobBox");
  if (!j || (j.state !== "running" && !(ENG && ENG._job === j.id) && Date.now() / 1000 - j.started > 3600)) return box.classList.add("hidden");
  box.classList.remove("hidden");
  box.textContent = `${{ apply: "Applying settings", pull: "Downloading", "move-home": "Moving home folder" }[j.kind] || j.kind}: ${j.state}\n` + j.log.join("\n");
  box.scrollTop = box.scrollHeight;
  $$("#engForm button").forEach((b) => (b.disabled = j.state === "running"));
  if (j.state !== "running" && ENG && ENG._job === j.id) { ENG._job = null; toast(j.state === "done" ? "Done." : "That failed. See the log under Engine settings.", j.state !== "done"); ENG_RENDERED = false; }
}
async function loadEngine(refreshVersions) {
  ENG = await api("GET", "engine" + (refreshVersions ? "?refresh=1" : ""));
  ENG_RENDERED = true;
  const c = ENG.config, s = c.strata, x = c.custom, ch = ENG.choices, v = ENG.versions || { remote: [], local: [] };
  const running = ENG.container?.image || "";
  const tags = [...new Set([...v.local, ...v.remote])];
  const tagLabel = Object.fromEntries(tags.map((t) => [t, `${t}, ${running.endsWith(":" + t) ? "running now" : v.local.includes(t) ? "downloaded" : "downloads when applied"}`]));
  const models = ENG.models.map((m) => m.path), mLabel = Object.fromEntries(ENG.models.map((m) => [m.path, `${m.name} (${fmtB(m.size)})`]));
  const sv = ENG.serving;
  $("#engForm").innerHTML = `<p class="sub" style="margin:0 0 16px">Serving <b>${esc(sv.model || "nothing")}</b>${sv.concurrency ? `, ${sv.concurrency} requests at once` : ""}${sv.context ? `, ${fmtN(sv.context)} tokens of context` : ""}. Applying restarts the engine: answers in progress are cut off and Strata takes one to two minutes to load. The previous settings stay available for rolling back.</p>
  <form id="engF" class="form">
    <label class="full">Engine<select name="engine">${opt(["strata", "custom"], c.engine, { strata: "Strata, for GGUF builds of Qwen3.8-Flash-Next and Qwen3.6", custom: "Another engine image, such as SGLang, vLLM or llama.cpp" })}</select></label>
    <div class="full form" data-eng="strata">
      <div class="form-sec">Version and model</div>
      <label>Strata version<span class="inline"><select name="s:tag">${opt(tags, s.tag, tagLabel)}</select><button type="button" class="btn sm" id="pullBtn">Download now</button></span></label>
      <label>Model files<select name="s:model_dir">${opt(["", ...models], s.model_dir, { "": "Let Strata download by family and size", ...mLabel })}</select></label>
      <label>Family<input name="s:family" value="${esc(s.family)}"><span class="hint">swift, qwen, unsloth, nvfp4, gyro, coder or qwen36</span></label>
      <label>Size<input name="s:model" value="${esc(s.model)}"><span class="hint">such as IQ3_S, IQ3_XXS or UD-Q4_K_XL</span></label>
      <div class="form-sec">Capacity</div>
      <label>Requests at once<input name="s:parallel" type="number" min="1" max="8" value="${s.parallel}"><span class="hint">each needs GPU memory for its context; Strata reports what fits</span></label>
      <label>Context<select name="s:context">${opt(ch.context, s.context, { "32k": "32k tokens", "64k": "64k tokens", "128k": "128k tokens", "256k": "256k tokens (the model's maximum)" })}</select></label>
      <label>Context memory format<select name="s:kv">${opt(ch.kv, s.kv, { int8: "int8, the default", q4_0: "q4_0, half the memory", k8v4: "k8v4", fp16: "fp16" })}</select></label>
      <label>Pictures<select name="s:vision">${opt(ch.vision, s.vision, { off: "Off", gpu: "On, read on the GPU", cpu: "On, read on the CPU" })}</select></label>
      <div class="form-sec">Speed</div>
      <label>Draft model<select name="s:drafting">${opt(ch.drafting, s.drafting, { auto: "Automatic", mtp: "MTP", dflash2: "DFlash2", off: "Off" })}</select></label>
      <label>Skip rarely used experts<select name="s:route_tail_skip">${opt([0, 7], s.route_tail_skip, { 0: "Off: exact answers (default)", 7: "On: about 15% faster with several users, answers differ slightly" })}</select></label>
      <label class="check"><input type="checkbox" name="s:resident_experts" ${s.resident_experts ? "checked" : ""}> Keep experts only in GPU memory, saving about 47 GB of RAM</label>
      <label class="check"><input type="checkbox" name="s:batch_mtp" ${s.batch_mtp ? "checked" : ""}> Draft ahead for every request, faster with several users</label>
      <label class="full">Extra engine settings<input name="s:extra_set" value="${esc(s.extra_set)}" placeholder="key=value pairs separated by spaces, such as prefill=16384"></label>
    </div>
    <div class="full form" data-eng="custom">
      <div class="form-sec">Engine image</div>
      <label>Start from<select id="tpl"><option value="">Choose a starting point</option>${opt(Object.keys(ENG.templates), "", { sglang: "SGLang", vllm: "vLLM", "llama.cpp": "llama.cpp server" })}</select><span class="hint">untested starting points; adjust the model path and options</span></label>
      <label>Docker image<input name="c:image" value="${esc(x.image)}" placeholder="lmsysorg/sglang:latest"></label>
      <label>Port inside the container<input name="c:port" type="number" value="${x.port}"></label>
      <label>Model files, mounted at /models<select name="c:model_dir">${opt(["", ...models], x.model_dir, { "": "None", ...mLabel })}</select></label>
      <label>Shared memory<input name="c:shm" value="${esc(x.shm)}"></label>
      <label class="full">Command and options<textarea name="c:args" rows="3">${esc(x.args)}</textarea><span class="hint">{key} becomes the engine's private key. People keep using their own keys through the gateway.</span></label>
      <label class="full">Environment, one NAME=value per line<textarea name="c:env" rows="2">${esc(x.env)}</textarea></label>
    </div>
    <div class="full actions"><button class="btn primary" type="submit">Apply and restart the engine</button>${ENG.has_prev ? '<button type="button" class="btn" id="rollBtn">Roll back to the previous settings</button>' : ""}</div>
  </form>`;
  const F = $("#engF");
  const sync = () => $$("[data-eng]", F).forEach((d) => d.classList.toggle("hidden", d.dataset.eng !== F.engine.value));
  F.engine.addEventListener("change", sync); sync();
  $("#tpl").addEventListener("change", (e) => { const t = ENG.templates[e.target.value]; if (!t) return; F["c:image"].value = t.image; F["c:port"].value = t.port; F["c:args"].value = t.args; F["c:shm"].value = t.shm; });
  const runJob = async (fn, msg) => { const j = await act(fn, msg); ENG._job = j.id; updateJobs([j]); };
  F.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cfg = { engine: F.engine.value, strata: {}, custom: {} };
    for (const el of F.elements) {
      if (!el.name || !el.name.includes(":")) continue;
      const [sec, key] = el.name.split(":"), dst = sec === "s" ? cfg.strata : cfg.custom;
      dst[key] = el.type === "checkbox" ? el.checked : el.type === "number" || key === "route_tail_skip" ? +el.value : el.value;
    }
    if (!confirm("Apply these settings and restart the engine now? Answers in progress are cut off.")) return;
    await runJob(() => api("POST", "engine/apply", { config: cfg }), "Applying the new settings…");
  });
  $("#pullBtn").addEventListener("click", () => runJob(() => api("POST", "engine/pull", { tag: F["s:tag"].value }), "Downloading…"));
  $("#rollBtn")?.addEventListener("click", () => confirm("Apply the previous engine settings again?") && runJob(() => api("POST", "engine/rollback", {}), "Rolling back…"));
  updateJobs(ENG.jobs);
}
$("#engReload").addEventListener("click", () => loadEngine(false));
$("#engVersions").addEventListener("click", async () => { await loadEngine(true); toast("Version list updated."); });

// ------------------------------------------------------------------ activity log
const ACTIONS = { "user-add": "Added person", "user-edit": "Changed settings", "user-delete": "Deleted person", "user-disable": "Disabled account", "user-enable": "Enabled account",
  password: "Set password", "ssh-key-add": "Added SSH key", "ssh-key-remove": "Removed SSH key", "llm-key-regenerate": "Replaced model key", "llm-key-view": "Viewed model key",
  quota: "Changed disk limits", "home-move": "Moved home folder", login: "Signed in", "login-failed": "Failed sign-in", "engine-apply": "Applied engine settings",
  "engine-apply-failed": "Engine settings failed", "engine-pull": "Downloaded engine version", "admin-password": "Set admin password", "admin-save": "Changed panel admin", "admin-delete": "Removed panel admin",
  "two-factor-on": "Turned on two-factor sign-in", "two-factor-off": "Turned off two-factor sign-in", storage: "Changed disk settings", brand: "Changed the lab name or logo", "disk-limits": "Turned on disk limits", "system-upgrade": "Installed server updates", reboot: "Restarted the server" };
async function loadAudit() {
  const rows = await api("GET", "audit");
  $("#auditTable").innerHTML = `<thead><tr><th>Time</th><th>By</th><th>What</th><th>Who or what</th><th>Details</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtT(r.ts)}</td><td>${esc(r.actor)}</td><td>${esc(ACTIONS[r.action] || r.action.replace(/-/g, " "))}</td><td>${esc(r.target)}</td><td class="sub" style="white-space:normal;max-width:520px;overflow-wrap:anywhere">${esc(r.detail)}</td></tr>`).join("") || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>'}</tbody>`;
}

start();

// ------------------------------------------------------------------ settings: account, admins, server software
const ROLE_TEXT = { owner: "Owner: everything, including admins and server updates", admin: "Admin: people and the language model", viewer: "Viewer: can look, cannot change anything" };
async function loadSettings() {
  $("#myRole").innerHTML = `<span class="pill ok">${esc(ME.role)}</span>`;
  $("#meBox").innerHTML = `<div class="part"><h3>Password</h3><div class="form">
      <label>Current password<input type="password" id="pwCur" autocomplete="current-password"></label>
      <label>New password<input type="password" id="pwNew" autocomplete="new-password" placeholder="at least 10 characters"></label></div>
      <div><button class="btn" id="pwSave">Change password</button></div></div>
    <div class="part"><h3>Two-factor sign-in</h3>${ME.two_factor
      ? `<p class="sub">On. Sign-in asks for a code from your authenticator app.</p><div class="inline"><input id="tfOff" inputmode="numeric" placeholder="current 6-digit code"><button class="btn quiet-danger" id="tfOffBtn">Turn off</button></div>`
      : `<p class="sub">Off. Turn it on so a stolen password is not enough to get in.</p><div><button class="btn" id="tfStart">Set up two-factor sign-in</button></div><div id="tfSetup"></div>`}</div>`;
  $("#pwSave").addEventListener("click", async () => { await act(() => api("POST", "me/password", { current: $("#pwCur").value, new: $("#pwNew").value }), "Password changed."); $("#pwCur").value = $("#pwNew").value = ""; });
  $("#tfOffBtn")?.addEventListener("click", async () => { await act(() => api("POST", "me/totp/off", { code: $("#tfOff").value }), "Two-factor sign-in is off."); ME.two_factor = false; loadSettings(); });
  $("#tfStart")?.addEventListener("click", async () => {
    const t = await api("POST", "me/totp/start", {});
    $("#tfSetup").innerHTML = `<p class="sub">In your authenticator app (Google Authenticator, 1Password, Authy …), add an account by entering this key, then type the code it shows.</p>
      <div class="inline"><code class="key">${esc(t.secret.match(/.{1,4}/g).join(" "))}</code></div>
      <div class="inline"><input id="tfCode" inputmode="numeric" placeholder="6-digit code"><button class="btn primary" id="tfConfirm">Turn on</button></div>`;
    $("#tfConfirm").addEventListener("click", async () => { await act(() => api("POST", "me/totp/confirm", { code: $("#tfCode").value }), "Two-factor sign-in is on."); ME.two_factor = true; loadSettings(); });
  });
  loadBrand();
  loadLook();
  loadDisks(false).catch(() => {});
  if (ME.role === "owner") {
    const admins = await api("GET", "admins");
    $("#adminsTable").innerHTML = `<thead><tr><th>Name</th><th>Role</th><th>Two-factor</th><th>Added</th><th></th></tr></thead><tbody>${admins.map((a) => `<tr><td><b>${esc(a.name)}</b>${a.name === ME.user ? ' <span class="sub">you</span>' : ""}</td>
      <td><select data-role="${esc(a.name)}" aria-label="Role of ${esc(a.name)}">${["owner", "admin", "viewer"].map((r) => `<option value="${r}" ${r === a.role ? "selected" : ""}>${r}</option>`).join("")}</select></td>
      <td>${a.two_factor ? '<span class="pill ok">On</span>' : '<span class="pill">Off</span>'}</td><td>${fmtT(a.created)}</td>
      <td class="num">${a.name === ME.user ? "" : `<button class="btn sm" data-reset="${esc(a.name)}">New password</button> <button class="btn sm quiet-danger" data-deladmin="${esc(a.name)}">Remove</button>`}</td></tr>`).join("")}</tbody>`;
    $$("[data-role]").forEach((sel) => sel.addEventListener("change", () => act(() => api("PATCH", "admins/" + sel.dataset.role, { role: sel.value }), `${sel.dataset.role} is now ${sel.value}.`).catch(loadSettings)));
    $$("[data-reset]").forEach((b) => b.addEventListener("click", async () => { const pw = randomPw(); await act(() => api("PATCH", "admins/" + b.dataset.reset, { password: pw }), `New password for ${b.dataset.reset}: ${pw}`); }));
    $$("[data-deladmin]").forEach((b) => b.addEventListener("click", async () => { if (confirm(`Remove ${b.dataset.deladmin} from the panel?`)) { await act(() => api("DELETE", "admins/" + b.dataset.deladmin), "Removed."); loadSettings(); } }));
    loadUpdates(false);
  } else {
    $("#adminsTable").innerHTML = '<tbody><tr><td class="empty">Only an owner can manage panel admins.</td></tr></tbody>';
    $("#updBox").innerHTML = '<p class="sub">Only an owner can update the server.</p>';
  }
}
// ------------------------------------------------------------------ settings: appearance and refresh (per admin)
const SCHEMES = [["pine", "Pine"], ["lake", "Lake"], ["heather", "Heather"], ["graphite", "Graphite"]];
const MODES = [["auto", "Automatic"], ["light", "Light"], ["dark", "Dark"]];
const EVERY = [[0, "Never, only by hand"], [2, "2 seconds"], [5, "5 seconds"], [10, "10 seconds"], [30, "30 seconds"], [60, "Minute"]];
function loadLook() {
  const mode = document.documentElement.dataset.mode;
  $("#lookBox").innerHTML = `<div class="look">
    <div><h3 id="modeH">Light or dark</h3><div class="seg" role="radiogroup" aria-labelledby="modeH">${MODES.map(([v, n]) =>
      `<label><input type="radio" name="lookMode" value="${v}" ${PREFS.mode === v ? "checked" : ""}>${n}</label>`).join("")}</div>
      <p class="hint look-hint">${PREFS.mode === "auto" ? "Follows the light or dark setting of your computer." : "Stays this way whatever your computer is set to."}</p></div>
    <div><h3 id="schemeH">Colours</h3><div class="swatches" role="radiogroup" aria-labelledby="schemeH">${SCHEMES.map(([v, n]) =>
      `<label class="swatch" data-scheme="${v}" data-mode="${mode}"><input type="radio" name="lookScheme" value="${v}" ${PREFS.scheme === v ? "checked" : ""}>
        <span class="sw-art" aria-hidden="true"><i class="sw-side"><b></b><b></b></i><i class="sw-page"><u></u><u></u><u></u></i></span>${n}</label>`).join("")}</div></div>
    <div><h3><label for="lookRefresh" class="inline-label">Refresh pages every</label></h3>
      <select id="lookRefresh">${EVERY.map(([v, n]) => `<option value="${v}" ${PREFS.refresh === v ? "selected" : ""}>${n}</option>`).join("")}</select>
      <p class="hint look-hint">Press R or use Refresh in the sidebar to refresh at any time. Settings never refresh on their own, so nothing you type is lost.</p></div></div>`;
  const save = async (change) => {
    const before = { ...PREFS };
    Object.assign(PREFS, change); window.labLook(PREFS); startTimer(); loadLook();
    const focus = Object.keys(change)[0];
    (focus === "refresh" ? $("#lookRefresh") : $(`input[name="look${focus[0].toUpperCase() + focus.slice(1)}"]:checked`))?.focus();
    try { PREFS = await api("PUT", "me/prefs", change); }
    catch (e) { PREFS = before; window.labLook(PREFS); startTimer(); loadLook(); toast(e.message, true); }
  };
  $$('input[name="lookMode"]').forEach((i) => i.addEventListener("change", () => save({ mode: i.value })));
  $$('input[name="lookScheme"]').forEach((i) => i.addEventListener("change", () => save({ scheme: i.value })));
  $("#lookRefresh").addEventListener("change", (e) => save({ refresh: +e.target.value }));
}
// ------------------------------------------------------------------ settings: lab name and logo
function loadBrand() {
  const own = ME.role === "owner";
  let logo = ME.logo, pending;          // pending: undefined = unchanged, "" = built-in mark, data URL = new image
  const preview = () => {
    const name = ($("#brandName")?.value || "").trim() || ME.org, l = pending === undefined ? logo : pending;
    const sub = $("#brandSub") ? ($("#brandSub").value.trim() || ME.subtitle_default) : ME.subtitle;
    $("#brandPreview").innerHTML = `<div class="brand"><div class="mark ${l ? "logo" : ""}">${markHTML(l)}</div>
      <div><b>${esc(name)}</b><span>${esc(sub)}</span></div></div>`;
    $("#brandReset") && ($("#brandReset").disabled = !l);
  };
  $("#brandBox").innerHTML = `<div id="brandPreview" class="brand-preview" aria-label="Preview of the sidebar"></div>
    <div class="brand-fields">${own ? `
      <label>Lab name<input id="brandName" value="${esc(ME.org)}" maxlength="60" autocomplete="organization"></label>
      <label>Line under the name<input id="brandSub" value="${esc(ME.subtitle_custom)}" maxlength="60" placeholder="${esc(ME.subtitle_default)}">
        <span class="hint">For example the server's purpose or room. Leave it empty to show the server's host name.</span></label>
      <div class="brand-logo"><span class="label">Logo</span>
        <div class="inline"><label class="btn file">Choose image<input type="file" id="brandFile" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label>
          <button class="btn" id="brandReset">Use the built-in mark</button></div>
        <span class="hint">A square PNG, JPEG, WebP or SVG up to 512 KB. It appears on the sign-in page, in the sidebar and on the browser tab.</span></div>
      <div><button class="btn primary" id="brandSave">Save name and logo</button></div>`
    : `<p class="sub">Only an owner can change the lab name and logo.</p>`}</div>`;
  preview();
  if (!own) return;
  $("#brandName").addEventListener("input", preview);
  $("#brandSub").addEventListener("input", preview);
  $("#brandFile").addEventListener("change", (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    if (f.size > 512 * 1024) return toast("That image is larger than 512 KB. Export a smaller one, 256 × 256 pixels is plenty.", true);
    const rd = new FileReader();
    rd.onload = () => { pending = rd.result; preview(); };
    rd.readAsDataURL(f);
  });
  $("#brandReset").addEventListener("click", () => { pending = ""; preview(); });
  $("#brandSave").addEventListener("click", async () => {
    const body = { org: $("#brandName").value, subtitle: $("#brandSub").value };
    if (pending !== undefined) body.logo = pending;
    const b = await act(() => api("PUT", "system/brand", body), "Lab name and logo saved.");
    Object.assign(ME, b); logo = b.logo; pending = undefined; applyBrand(b); preview();
  });
}
// ------------------------------------------------------------------ settings: disks found on this server
async function loadDisks(refresh) {
  const r = await api("GET", "system/disks" + (refresh ? "?refresh=1" : ""));
  const own = ME.role === "owner";
  const lim = (d) => d.limits === "on" ? '<span class="pill ok">On</span>'
    : d.limits === "unsupported" ? `<span class="sub">${d.network ? "Not on network storage" : `Not on ${esc(d.fstype)}`}</span>`
    : own && (d.homes || d.data || d.path === r.container_fs) ? `<button class="btn sm" data-limits="${esc(d.path)}">Turn on</button>` : '<span class="sub">Off</span>';
  const rows = r.disks.map((d) => `<tr data-disk="${esc(d.path)}">
      <td class="disk-name">${own ? `<input class="dlabel" value="${esc(d.custom_label)}" placeholder="${esc(d.label)}" maxlength="40" aria-label="Name for ${esc(d.path)}">` : `<b>${esc(d.custom_label || d.label)}</b>`}
        ${d.model ? `<span class="model" title="${esc(d.model)}">${esc(d.model)}</span>` : ""}
        <span class="sub">${esc(d.path)}, ${esc(d.fstype)}${d.path === r.container_fs ? ", holds container system files" : ""}</span></td>
      <td style="min-width:180px">${meter(d.used, d.size, "", `${fmtB(d.avail)} free of ${fmtB(d.size)}`)}</td>
      <td><label class="check"><input type="checkbox" class="dhomes" ${d.homes ? "checked" : ""} ${own ? "" : "disabled"} aria-label="Home folders on ${esc(d.path)}"> Allowed</label>
        ${d.homes ? `<span class="sub">${esc(d.homes_dir)}, ${d.people} ${d.people === 1 ? "person" : "people"}</span>` : ""}</td>
      <td><label class="check"><input type="checkbox" class="ddata" ${d.data ? "checked" : ""} ${own && d.path !== "/home" ? "" : "disabled"} aria-label="Data folders on ${esc(d.path)}"> Allowed</label>
        ${d.data ? `<span class="sub">${esc(d.data_dir)}/<i>name</i></span>` : ""}</td>
      <td>${lim(d)}</td></tr>`);
  $("#disksTable").innerHTML = `<thead><tr><th>Disk</th><th>Space</th><th>Home folders</th><th>Data folders</th><th>Disk limits</th></tr></thead>
    <tbody>${rows.join("") || '<tr><td colspan="5" class="empty">No usable disks found.</td></tr>'}</tbody>`;
  const slow = r.disks.some((d) => d.rotational && d.homes);
  $("#diskFoot").innerHTML = (own ? '<button class="btn primary" id="diskSave">Save disk settings</button> ' : "") +
    `<span class="hint">Names come from the drive itself; type your own to replace one. Disk limits need ext4.${slow ? " A hard disk holds home folders: code, environments and many small files are much faster on an SSD." : ""}</span>`;
  $("#diskSave")?.addEventListener("click", async () => {
    const disks = $$("#disksTable tr[data-disk]").map((tr) => ({ path: tr.dataset.disk, homes: $(".dhomes", tr).checked, data: $(".ddata", tr).checked, label: $(".dlabel", tr).value }));
    await act(() => api("PUT", "system/disks", { disks }), "Disk settings saved.");
    ME = await api("GET", "me"); Object.keys(FSN).forEach((k) => delete FSN[k]); ME.storage.forEach((d) => (FSN[d.path] = d.label));
    loadDisks(true);
  });
  $$("[data-limits]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Turn on disk limits for ${b.dataset.limits}? The disk is remounted and checked once, which can take a few minutes on a large, full disk.`)) return;
    const j = await act(() => api("POST", "system/disks/limits", { path: b.dataset.limits }), "Turning on disk limits…");
    const log = $("#diskLog"); log.classList.remove("hidden");
    const poll = setInterval(async () => {
      const x = (await api("GET", "jobs")).find((y) => y.id === j.id) || j;
      log.textContent = x.log.join("\n");
      if (x.state !== "running") { clearInterval(poll); toast(x.state === "done" ? "Disk limits are on." : "Turning on disk limits failed. See the log.", x.state !== "done"); loadDisks(true); }
    }, 1500);
  }));
}
$("#diskRefresh").addEventListener("click", () => loadDisks(true));
async function loadUpdates(refresh) {
  const u = await api("GET", "system/updates" + (refresh ? "?refresh=1" : ""));
  $("#updCount").textContent = u.upgradable.length || "";
  $("#updBox").innerHTML = `<dl class="kv"><dt>Waiting</dt><dd>${u.upgradable.length ? `${u.upgradable.length} packages` : "Everything is up to date."}</dd>
      <dt>Automatic</dt><dd>Security updates install daily by themselves${u.last_auto_run ? `; last run ${esc(u.last_auto_run)}` : ""}. GPU driver and Docker updates wait for you, because they need a restart.</dd>
      ${u.driver_or_docker.length ? `<dt>Needs care</dt><dd>${esc(u.driver_or_docker.join(", "))}: plan a restart after installing.</dd>` : ""}
      <dt>Restart</dt><dd>${u.reboot_required ? `<span class="pill warn">Needed</span> <span class="sub">${esc(u.reboot_pkgs.slice(0, 4).join(", "))}</span>` : "Not needed"}</dd></dl>
    ${u.upgradable.length ? `<p class="hint">${esc(u.upgradable.slice(0, 30).join(", "))}${u.upgradable.length > 30 ? " …" : ""}</p>` : ""}
    <div class="actions">${u.upgradable.length ? '<button class="btn primary" id="updRun">Install all updates</button>' : ""}${u.reboot_required ? '<button class="btn quiet-danger" id="rebootBtn">Restart the server</button>' : ""}</div>`;
  $("#updRun")?.addEventListener("click", async () => {
    if (!confirm("Install all updates now? Running jobs keep running; a restart may be needed afterwards.")) return;
    const j = await act(() => api("POST", "system/upgrade", {}), "Installing updates…");
    const log = $("#updLog"); log.classList.remove("hidden");
    const poll = setInterval(async () => {
      const x = (await api("GET", "jobs")).find((y) => y.id === j.id) || j;
      log.textContent = x.log.join("\n"); log.scrollTop = log.scrollHeight;
      if (x.state !== "running") { clearInterval(poll); toast(x.state === "done" ? "Updates installed." : "Updating failed. See the log.", x.state !== "done"); loadUpdates(false); }
    }, 2000);
  });
  $("#rebootBtn")?.addEventListener("click", async () => {
    if (prompt("Restarting stops every container and the language model for a few minutes. Type reboot to continue.") !== "reboot") return;
    await act(() => api("POST", "system/reboot", { confirm: "reboot" }), "The server restarts in a few seconds.");
  });
}
$("#updCheck").addEventListener("click", () => loadUpdates(true).then(() => toast("Checked for updates.")));
$("#addAdminBtn").addEventListener("click", () => {
  if (ME.role !== "owner") return toast("Only an owner can add admins.", true);
  dialog(`<div class="dlg-h"><div><h2>Add a panel admin</h2><p class="sub">Panel admins manage this server. They are separate from the people who use it.</p></div><button class="x" data-close aria-label="Close">×</button></div>
    <form id="adminForm"><div class="dlg-b"><div class="form">
      <label>Name<input name="name" required pattern="[a-z_][a-z0-9_\\-]{0,31}" autocomplete="off"></label>
      <label>Role<select name="role">${["admin", "viewer", "owner"].map((r) => `<option value="${r}">${esc(ROLE_TEXT[r])}</option>`).join("")}</select></label>
      <label class="full">Password<span class="inline"><input name="password" minlength="10" required autocomplete="new-password"><button type="button" class="btn sm" id="genAp">Generate</button></span><span class="hint">share it privately; they can change it under Settings</span></label>
    </div></div><div class="dlg-f"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add admin</button></div></form>`, "center");
  $("#genAp").addEventListener("click", () => ($("#adminForm [name=password]").value = randomPw()));
  $("#adminForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    await act(() => api("POST", "admins", f), `Added ${f.name} as ${f.role}.`); closeDlg();
  });
});
