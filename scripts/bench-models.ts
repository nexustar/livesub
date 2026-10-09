// Compare models before changing a default: first-token latency for the
// translate path, search count / truncation for /api/hints. Requests mirror
// pipeline.ts and hints.ts.
//
// Usage (repo root, .env in cwd):
//   npx tsx scripts/bench-models.ts translate [sdk:model ...]
//     sdk = anthropic | deepseek | gemini; no specs = current defaults.
//     N=12 sets rounds per candidate (single-digit samples are noise).
//   npx tsx scripts/bench-models.ts hints ["scene description" ...]
//     models via HINTS_CLAUDE_MODEL / HINTS_GEMINI_MODEL.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  ANTHROPIC_API_KEY,
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  DEFAULT_TARGET_LANG,
  GEMINI_API_KEY,
  HINTS_CLAUDE_MODEL,
  HINTS_GEMINI_MODEL,
  TRANSLATE_MODEL,
  anthropicThinkingOff,
  getTranslateBackend,
} from "../src/config.js";
import { generateHintsClaude, generateHintsGemini, type HintsResult } from "../src/hints.js";
import { buildTranslationSystemInstruction } from "../src/prompts.js";

const SENTENCES = [
  "まもなく羽田空港第3ターミナルに到着いたします。お出口は左側です。",
  "本日も京急線をご利用いただきましてありがとうございます。",
  "みんなー！今日は来てくれてほんまにありがとう！推しのうちわ、めっちゃ見えてるで！",
  "政府は今日の閣議で、物価高対策を柱とする総額13兆円規模の補正予算案を決定しました。",
  "いやそれはさすがに草。てかこのボス、初見殺しすぎん？もう一回やらせて。",
  "その件につきましては、一旦持ち帰らせていただいて、来週中に改めてご回答差し上げる形でよろしいでしょうか。",
];
const HINT_SCENES = ["京急線 羽田空港 車内アナウンス", "乃木坂46 真夏の全国ツアー2026 明治神宮野球場"];

interface Sample {
  ttftMs: number;
  text: string;
}
type Runner = (sentence: string) => Promise<Sample>;

const SYS = buildTranslationSystemInstruction(DEFAULT_TARGET_LANG, "Japanese", "");

// Same request shape as translateOneClaude (DeepSeek uses the same SDK).
function anthropicRunner(client: Anthropic, model: string): Runner {
  return async (sentence) => {
    const t0 = performance.now();
    let ttftMs = NaN;
    let text = "";
    const stream = client.messages.stream({
      model,
      max_tokens: 512,
      system: SYS,
      messages: [{ role: "user", content: sentence }],
      thinking: anthropicThinkingOff(model),
      cache_control: { type: "ephemeral" },
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (Number.isNaN(ttftMs)) ttftMs = performance.now() - t0;
        text += event.delta.text;
      }
    }
    return { ttftMs, text: text.trim() };
  };
}

// Same request shape as translateOneGemini.
function geminiRunner(client: GoogleGenAI, model: string): Runner {
  return async (sentence) => {
    const t0 = performance.now();
    let ttftMs = NaN;
    let text = "";
    const stream = await client.models.generateContentStream({
      model,
      contents: sentence,
      config: { systemInstruction: SYS, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }, temperature: 0.2 },
    });
    for await (const chunk of stream) {
      if (chunk.text) {
        if (Number.isNaN(ttftMs)) ttftMs = performance.now() - t0;
        text += chunk.text;
      }
    }
    return { ttftMs, text: text.trim() };
  };
}

function makeRunner(spec: string): Runner {
  const sep = spec.indexOf(":");
  const sdk = spec.slice(0, sep);
  const model = spec.slice(sep + 1);
  if (sep > 0 && model) {
    if (sdk === "anthropic") return anthropicRunner(new Anthropic({ apiKey: ANTHROPIC_API_KEY }), model);
    if (sdk === "deepseek") return anthropicRunner(new Anthropic({ apiKey: DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL }), model);
    if (sdk === "gemini") return geminiRunner(new GoogleGenAI({ apiKey: GEMINI_API_KEY }), model);
  }
  throw new Error(`bad spec ${JSON.stringify(spec)} — want anthropic:<model>, deepseek:<model> or gemini:<model>`);
}

// The built-in translate defaults, minus whatever has no API key configured.
function defaultSpecs(): string[] {
  const specs: string[] = [];
  if (ANTHROPIC_API_KEY) {
    for (const id of ["claude-haiku", "claude-sonnet"]) specs.push(`anthropic:${getTranslateBackend(id)?.model}`);
  }
  if (DEEPSEEK_API_KEY) specs.push(`deepseek:${getTranslateBackend("deepseek-flash")?.model}`);
  if (GEMINI_API_KEY) specs.push(`gemini:${TRANSLATE_MODEL}`);
  return specs;
}

function quantile(sorted: number[], p: number): string {
  if (sorted.length === 0) return "n/a";
  return (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number).toFixed(0);
}

async function benchTranslate(specs: string[]): Promise<void> {
  const rounds = Number(process.env.N ?? "12");
  const cands = specs.map((spec) => ({ spec, run: makeRunner(spec), ttfts: [] as number[], errors: [] as string[], sample: "" }));
  console.log(`translate: ${rounds} rounds x ${cands.length} candidates`);
  for (let i = 0; i < rounds; i++) {
    const sentence = SENTENCES[i % SENTENCES.length] as string;
    // Candidates run concurrently so a slow patch hits them all alike.
    await Promise.all(
      cands.map(async (c) => {
        try {
          const s = await c.run(sentence);
          c.ttfts.push(s.ttftMs);
          if (i === 2) c.sample = s.text;
        } catch (e) {
          c.errors.push((e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160));
        }
      }),
    );
  }
  for (const c of cands) {
    const sorted = c.ttfts.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    console.log(
      `\n${c.spec}\n  ok=${sorted.length} err=${c.errors.length}  ttft ms: min=${quantile(sorted, 0)} p50=${quantile(sorted, 0.5)} p90=${quantile(sorted, 0.9)} max=${quantile(sorted, 1)}`,
    );
    if (c.sample) console.log(`  sample: ${c.sample}`);
    if (c.errors.length) console.log(`  first error: ${c.errors[0]}`);
  }
}

async function benchHints(scenes: string[]): Promise<void> {
  const backends: Array<[string, (d: string, s: string) => Promise<HintsResult>]> = [];
  if (ANTHROPIC_API_KEY) backends.push([`claude ${HINTS_CLAUDE_MODEL}`, generateHintsClaude]);
  if (GEMINI_API_KEY) backends.push([`gemini ${HINTS_GEMINI_MODEL}`, generateHintsGemini]);
  for (const scene of scenes) {
    console.log(`\n##### ${scene}`);
    for (const [label, fn] of backends) {
      const t0 = performance.now();
      try {
        const r = await fn(scene, "Japanese");
        const entries = r.glossary ? r.glossary.split(",").length : 0;
        // Watch for searches=0 (stale answer) and a max-tokens stop (truncated).
        console.log(`${label}: ${((performance.now() - t0) / 1000).toFixed(1)}s searches=${r.searchesUsed} stop=${r.stopReason} scene=${r.scene.length}ch glossary=${entries} entries`);
        console.log(`  ${r.glossary.slice(0, 300)}`);
      } catch (e) {
        console.log(`${label}: ERR ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200)}`);
      }
    }
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "translate") await benchTranslate(rest.length ? rest : defaultSpecs());
else if (mode === "hints") await benchHints(rest.length ? rest : HINT_SCENES);
else {
  console.error("usage: npx tsx scripts/bench-models.ts translate [sdk:model ...] | hints [description ...]");
  process.exit(1);
}
