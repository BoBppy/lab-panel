// Runs in <head> before the page paints: applies the saved colour scheme and light/dark mode, so there is no flash.
// The account's own choice comes from /api/me after sign-in; this browser remembers the last one for the sign-in page.
(function () {
  const KEY = "lab.look", root = document.documentElement, dark = matchMedia("(prefers-color-scheme: dark)");
  let look = { mode: "auto", scheme: "pine" };
  try { Object.assign(look, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { /* private mode */ }
  function apply(next) {
    if (next) look = { mode: next.mode || look.mode, scheme: next.scheme || look.scheme };
    root.dataset.scheme = look.scheme;
    root.dataset.mode = look.mode === "auto" ? (dark.matches ? "dark" : "light") : look.mode;
    try { localStorage.setItem(KEY, JSON.stringify(look)); } catch (e) { /* private mode */ }
  }
  dark.addEventListener("change", () => apply());
  window.labLook = apply;
  apply();
})();
