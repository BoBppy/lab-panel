// Runs in <head> before the page paints: applies the saved colours, light/dark mode, typeface and language,
// so nothing flashes. The account's own choice comes from /api/me after sign-in; this browser remembers the
// last one for the sign-in page.
(function () {
  const KEY = "lab.look", root = document.documentElement, dark = matchMedia("(prefers-color-scheme: dark)");
  let look = { mode: "auto", scheme: "pine", font: "field", lang: "auto" };
  try { Object.assign(look, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { /* private mode */ }
  const browserLang = () => ((navigator.languages || [navigator.language]).find((l) => /^(zh|en|ja|ru)/i.test(l)) || "en").slice(0, 2).toLowerCase();
  function apply(next) {
    if (next) look = { mode: next.mode || look.mode, scheme: next.scheme || look.scheme, font: next.font || look.font, lang: next.lang || look.lang };
    root.dataset.scheme = look.scheme;
    root.dataset.font = look.font;
    root.dataset.mode = look.mode === "auto" ? (dark.matches ? "dark" : "light") : look.mode;
    root.dataset.lang = look.lang === "auto" ? browserLang() : look.lang;
    root.lang = { zh: "zh-CN", ja: "ja", ru: "ru" }[root.dataset.lang] || "en";
    try { localStorage.setItem(KEY, JSON.stringify(look)); } catch (e) { /* private mode */ }
    return root.dataset.lang;
  }
  dark.addEventListener("change", () => apply());
  window.labLook = apply;
  apply();
})();
