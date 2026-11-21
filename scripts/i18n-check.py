#!/usr/bin/env python3
"""Check the panel's translations.

Collects every English string the panel can show: _("...") calls in app.js, text in index.html, and messages the
server sends (LabError and {"error": ...} in the Python code). Then reports, for each panel/static/lang-*.json,
the strings it lacks and the entries nothing uses any more.

  scripts/i18n-check.py            report; exit 1 if a language lacks strings
  scripts/i18n-check.py --missing  print the missing strings of each language as JSON, ready to translate
"""
import ast
import glob
import json
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
STATIC = os.path.join(ROOT, "panel", "static")
JS_STRING = r'"((?:[^"\\\n]|\\.)*)"'


def js_strings():
    src = open(os.path.join(STATIC, "app.js")).read()
    keys = [json.loads('"%s"' % m) for m in re.findall(r"\b_\(\s*" + JS_STRING, src)]
    bad = re.findall(r"\b_\(\s*[`'][^\n]{0,60}", src)
    return keys, bad


class Text(HTMLParser):
    SKIP = {"script", "style", "code", "pre", "svg", "title", "i18n"}

    def __init__(self):
        super().__init__()
        self.keys, self.stack = [], []

    def handle_starttag(self, tag, attrs):
        if tag not in ("input", "link", "meta", "br", "img", "circle", "path"):
            self.stack.append("i18n" if any(k == "data-i18n" for k, _ in attrs) else tag)
        for k, v in attrs:
            if k in ("placeholder", "title", "aria-label") and v and not self.skipping():
                self.keys.append(" ".join(v.split()))

    def handle_endtag(self, tag):
        if tag in self.stack or "i18n" in self.stack:
            while self.stack and self.stack.pop() not in (tag, "i18n"):
                pass

    def skipping(self):
        return any(t in self.SKIP for t in self.stack)

    def handle_data(self, data):
        d = " ".join(data.split())
        if d and not self.skipping() and re.search(r"[A-Za-z]{2}", d):
            self.keys.append(d)


def html_strings():
    src = open(os.path.join(STATIC, "index.html")).read()
    p = Text()
    p.feed(src)
    whole = [" ".join(m.split()) for m in re.findall(r"<(\w+)[^>]*\bdata-i18n\b[^>]*>(.*?)</\1>", src, re.S) for m in [m[1]]]
    return p.keys + whole


def template(node):
    """An f-string or string literal as an English template with {placeholders}."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out, n = "", 0
        for v in node.values:
            if isinstance(v, ast.Constant):
                out += v.value
            else:
                n += 1
                out += "{v%d}" % n
        return out
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a = template(node.left)
        b = template(node.right)
        if a is not None:
            return a + (b if b is not None else "{v9}")
    return None


def server_strings():
    keys = []
    for path in glob.glob(os.path.join(ROOT, "panel", "*.py")):
        for node in ast.walk(ast.parse(open(path).read())):
            if isinstance(node, ast.Call) and getattr(node.func, "attr", getattr(node.func, "id", "")) == "LabError" and node.args:
                t = template(node.args[0])
                if t:
                    keys.append(t)
            if isinstance(node, ast.Dict):
                for k, v in zip(node.keys, node.values):
                    if isinstance(k, ast.Constant) and k.value == "error":
                        t = template(v)
                        if t:
                            keys.append(t)
    return keys


def shape(k):
    """Placeholder names do not matter for matching, only where they are."""
    return re.sub(r"\{\w+\}", "{}", k)


def main():
    js, bad = js_strings()
    need = {}
    for k in js + html_strings():
        need.setdefault(k, "ui")
    for k in server_strings():
        need.setdefault(k, "server")
    shapes = {shape(k) for k in need}
    missing_any, out = False, {}
    for f in sorted(glob.glob(os.path.join(STATIC, "lang-*.json"))):
        lang = os.path.basename(f)[5:-5]
        d = json.load(open(f))
        have = {shape(k) for k in d}
        missing = [k for k in need if shape(k) not in have]
        unused = [k for k in d if shape(k) not in shapes]
        forms = lambda v: list(v.values()) if isinstance(v, dict) else [v]
        bad_forms = [k for k, v in d.items() if isinstance(v, dict) and (not v.get("other") or set(v) - {"zero", "one", "two", "few", "many", "other"})]
        holes = [k for k, v in d.items() if need.get(k) != "server" and any(
            set(re.findall(r"\{(\w+)\}", f)) - set(re.findall(r"\{(\w+)\}", k)) or
            (not isinstance(v, dict) and set(re.findall(r"\{(\w+)\}", k)) != set(re.findall(r"\{(\w+)\}", f))) for f in forms(v))] + bad_forms
        out[lang] = missing
        print(f"{lang}: {len(d)} entries, {len(missing)} missing, {len(unused)} unused, {len(holes)} with mismatched placeholders")
        for k in missing[:200]:
            print(f"  missing ({need[k]}): {k}")
        for k in unused[:50]:
            print(f"  unused: {k}")
        for k in holes:
            print(f"  placeholders differ: {k}")
        missing_any |= bool(missing) or bool(holes)
    for b in bad:
        print(f"_() needs a plain double-quoted string, not: {b}")
    if "--missing" in sys.argv:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    sys.exit(1 if missing_any or bad else 0)


if __name__ == "__main__":
    main()
