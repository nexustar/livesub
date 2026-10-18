// List UI strings a table in static/i18n.js lacks: data-i18n text and
// attributes in index.html, string literals passed to t() / tNodes() /
// setStatus() in app.js. Keys built at runtime (server labels, WELCOME_MODELS,
// some statuses) aren't seen; keep those by hand.
//
// Usage: node scripts/check-i18n.mjs

import { readFileSync } from "node:fs";

const root = new URL("../static/", import.meta.url);
const read = (f) => readFileSync(new URL(f, root), "utf8");
const keys = new Set();

const html = read("index.html");
for (const m of html.matchAll(/<(\w+)[^>]*\sdata-i18n(?=[\s>])[^>]*>([^<]*)<\/\1>/g)) keys.add(m[2].trim());
for (const m of html.matchAll(/<\w+[^>]*>/g)) {
  for (const attr of ["title", "placeholder", "aria-label"]) {
    if (!new RegExp(`\\sdata-i18n-${attr}(?=[\\s>])`).test(m[0])) continue;
    const v = m[0].match(new RegExp(`\\s${attr}="([^"]*)"`));
    if (v) keys.add(v[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  }
}

const lit = String.raw`"(?:[^"\\]|\\.)*"`;
const js = read("app.js");
for (const m of js.matchAll(new RegExp(String.raw`\b(?:t|tNodes|setStatus)\(\s*(${lit}(?:\s*\+\s*${lit})*)\s*[,)]`, "g"))) {
  keys.add(m[1].split(/\s*\+\s*(?=")/).map((p) => JSON.parse(p)).join(""));
}

// LOCALES isn't exported (and i18n.js is a browser module): evaluate the literal.
const src = read("i18n.js");
const body = src.slice(src.indexOf("const LOCALES = "), src.indexOf("let dict"));
const LOCALES = new Function(`${body}; return LOCALES;`)();

let missing = 0;
for (const [lang, table] of Object.entries(LOCALES)) {
  for (const k of keys) {
    if (!(k in table)) {
      console.log(`${lang}: missing ${JSON.stringify(k)}`);
      missing++;
    }
  }
}
console.log(`${keys.size} keys checked, ${missing} missing`);
process.exitCode = missing ? 1 : 0;
