// Refresh vendor/bergamot/ with Firefox's translation engine: the WASM from
// Remote Settings and the JS glue from mozilla-central. Bump both together.
//
// Usage: node scripts/vendor-bergamot.mjs   (Node >= 22.15, for zstd)

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

// bergamot-translator v0.6.0, mozilla/translations 1de4a085 (Firefox 144).
const WASM_RECORD = "ce71828c-5e7a-4024-8f18-03064bf0b9f0";
const WASM_SHA256 = "f38ef807636a7c994afedaab7ff8ffe0d590d21897f05139f747b80fd7bbe926";
const GLUE_COMMIT = "48d55cf7ec80093903e2ef7f58b61a84a22ef716";

const RS = "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-wasm-v2/records";
const CDN = "https://firefox-settings-attachments.cdn.mozilla.net";
const GLUE = `https://raw.githubusercontent.com/mozilla-firefox/firefox/${GLUE_COMMIT}/toolkit/components/translations/bergamot-translator/bergamot-translator.js`;
const OUT = join(import.meta.dirname, "..", "vendor", "bergamot");

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const record = JSON.parse(await get(`${RS}/${WASM_RECORD}`)).data;
const wasm = zstdDecompressSync(await get(`${CDN}/${record.attachment.location}`));
const digest = createHash("sha256").update(wasm).digest("hex");
if (digest !== WASM_SHA256) throw new Error(`wasm sha256 ${digest}, expected ${WASM_SHA256}`);
const glue = await get(GLUE);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "bergamot-translator.wasm"), wasm);
writeFileSync(join(OUT, "bergamot-translator.js"), glue);
console.log(`vendor/bergamot: wasm ${record.release} rev ${record.revision.slice(0, 8)} (${wasm.length} B), glue ${GLUE_COMMIT.slice(0, 8)} (${glue.length} B)`);
