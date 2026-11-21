// Translations. English is the source language and is written directly in the code:
//   _("Add person")                       plain text
//   _("Deleted {name}.", { name })        with values; escape them first when the result goes into HTML
//   _s(message)                           a message from the server, matched by its English pattern
// A translation may be {"one": …, "few": …, "many": …, "other": …} instead of a string; the form is picked for vars.n
// by the language's plural rules (Russian: 1 ядро, 2 ядра, 5 ядер).
// Other languages live in lang-<code>.json, mapping each English string to its translation. A missing entry
// falls back to English. scripts/i18n-check.py lists strings that still need translating.
"use strict";
const I18N = (() => {
  const lang = document.documentElement.dataset.lang || "en";
  // space: what goes between two sentences (Chinese runs them together)
  const locale = { zh: "zh-CN", ja: "ja-JP", ru: "ru-RU" }[lang] || [];
  const out = { lang, locale, space: lang === "zh" || lang === "ja" ? "" : " ", dict: {}, pats: [], plural: new Intl.PluralRules(locale.length ? locale : "en") };
  const LANGS = [["auto", "Automatic"], ["en", "English"], ["zh", "简体中文"], ["ja", "日本語"], ["ru", "Русский"]];
  out.langs = LANGS;
  out.ready = lang === "en" ? Promise.resolve() : fetch(`lang-${lang}.json`).then((r) => r.json()).then((d) => {
    out.dict = d;
    // Keys with {placeholders} also match server messages that carry names, paths or numbers.
    out.pats = Object.keys(d).filter((k) => /\{\w+\}/.test(k)).map((k) => {
      const names = [...k.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const re = new RegExp("^" + k.split(/\{\w+\}/).map((p) => p.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")).join("([\\s\\S]+?)") + "$");
      return [re, names, d[k]];
    });
  }).catch(() => { /* no dictionary: stay in English */ });
  out.form = (v, vars) => typeof v === "string" ? v : v[out.plural.select(Number(vars?.n ?? 0))] ?? v.other;
  out.fill = (s, vars) => vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  return out;
})();
const _ = (s, vars) => I18N.fill(s in I18N.dict ? I18N.form(I18N.dict[s], vars) : s, vars);
function _s(msg) {
  msg = String(msg ?? "");
  if (typeof I18N.dict[msg] === "string") return I18N.dict[msg];
  for (const [re, names, tr] of I18N.pats) {
    const m = msg.match(re);
    if (m) { const vars = Object.fromEntries(names.map((n, i) => [n, m[i + 1]])); return I18N.fill(I18N.form(tr, vars), vars); }
  }
  return msg;
}
// The page skeleton in index.html holds no personal data, so it is translated once by matching whole text nodes
// and a few attributes against the dictionary.
function translateStatic(root) {
  if (I18N.lang === "en") return;
  const norm = (s) => s.trim().replace(/\s+/g, " ");
  // sentences with inline code are translated whole, so the word order can change
  root.querySelectorAll("[data-i18n]").forEach((el) => { const k = norm(el.innerHTML); if (I18N.dict[k]) el.innerHTML = I18N.dict[k]; });
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const k = norm(n.nodeValue);
    if (k && I18N.dict[k] && !n.parentElement.closest("code, pre, script, style, [data-i18n]")) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), I18N.dict[k]);
  }
  root.querySelectorAll("[placeholder], [title], [aria-label]").forEach((el) => {
    for (const a of ["placeholder", "title", "aria-label"]) {
      const v = el.getAttribute(a);
      if (v && I18N.dict[norm(v)]) el.setAttribute(a, I18N.dict[norm(v)]);
    }
  });
}
