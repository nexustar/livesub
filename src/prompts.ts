// Prompt builders, sentence-boundary helpers, and the streaming paired-response
// parser — ported from the "prompts" and "helpers" sections of server.py.

import { SENTENCE_PUNCT, SENTENCE_PUNCT_SOFT } from "./config.js";

// ---------- /api/hints prompt ----------

export function buildHintsSystemPrompt(sourceLang: string): string {
  const src = (sourceLang || "").trim();
  let glossaryLangRule: string;
  let glossaryLangHint: string;
  if (!src || src.toLowerCase() === "auto") {
    glossaryLangRule =
      "Use each entry's NATIVE script (Japanese in kanji/kana, " +
      "Chinese in hanzi, Korean in hangul, etc.). Don't transliterate.";
    glossaryLangHint = "";
  } else {
    glossaryLangRule =
      `ALL entries must be in ${src}. The audio source language is ` +
      `${src}; the glossary is matched against ${src} transcripts. ` +
      `Entries in any other language (including the target ` +
      `translation language) are useless. If you only know an ` +
      `entry's English / Chinese ` +
      `transliteration, search the web to find the ${src} original ` +
      `(or omit it).`;
    glossaryLangHint = `, all in ${src}`;
  }
  return (
    "You are an assistant for a real-time ASR + translation system. " +
    "Given brief user input — a topic, URL, keyword, or short " +
    "description — you produce TWO outputs:\n\n" +
    "1. SCENE: a 1–3 sentence summary describing the scenario, genre, " +
    "speakers, and tone. This is given to the translator as background " +
    "context so it can pick appropriate register and word choice. " +
    "Mention any cultural conventions or fan-slang that affect how " +
    'things should be translated (e.g. "use casual Chinese fan-slang; ' +
    'preserve idol terminology like 推し / ペンライト").\n\n' +
    "2. GLOSSARY: a comma-separated list of proper nouns, names, and " +
    "specialty terms that may appear. " +
    `${glossaryLangRule} ` +
    "The translator uses it to restore names that speech recognition " +
    "misheard, and the Gemini recognizer takes it as custom vocabulary, " +
    "so entries MUST be in the audio language.\n\n" +
    "Rules:\n" +
    // "Even when you feel confident": otherwise models at lower effort
    // answer from stale training data.
    "- When the input names a specific real-world thing (concert, tour, " +
    "show, person, event, anime, game, sports, conference), search the " +
    "web before answering, even when you feel confident: line-ups, " +
    "dates, venues and recent names change after your training. Don't " +
    "fabricate.\n" +
    "- Only a generic scenario with nothing specific to look up can be " +
    "answered from training.\n" +
    "- GLOSSARY: 30–100 entries, most distinctive proper nouns first.\n" +
    "- SCENE: concise. Skip generic stuff. Include things that affect " +
    "translation register.\n\n" +
    "Output format (use the exact tags, both blocks required, no " +
    "other text):\n" +
    "<scene>\n1–3 sentence scene summary\n</scene>\n" +
    `<glossary>\ncomma-separated terms${glossaryLangHint}\n</glossary>\n`
  );
}

// Extract <scene> and <glossary> blocks from a hints model response. Falls back
// to treating the whole text as glossary when neither block parses. A missing
// closing tag (DeepSeek drops them) ends the block at the next tag or the end.
export function parseHintsResponse(raw: string): { scene: string; glossary: string } {
  const sceneM = /<scene>\s*([\s\S]*?)\s*(?:<\/scene>|<glossary>|$)/i.exec(raw);
  const glossM = /<glossary>\s*([\s\S]*?)\s*(?:<\/glossary>|<scene>|$)/i.exec(raw);
  let scene = sceneM ? sceneM[1].trim() : "";
  let glossary = glossM ? glossM[1].trim() : "";
  if (!scene && !glossary) glossary = raw;
  return { scene, glossary };
}

// ---------- ASR / translation prompts ----------

// The source text comes from speech recognition, which writes names it does
// not know as similar-sounding words (結女体育祭 -> 遊女大祭祭).
function glossaryNote(glossary: string): string {
  return (
    `Glossary (names and terms that may occur): ${glossary}\n` +
    "The source text comes from speech recognition, which writes names it " +
    "does not know as similar-sounding words. When a word sounds like a " +
    "glossary term and the context fits, translate it as that term. Still " +
    "output only the translation."
  );
}

export function buildTranslationSystemInstruction(targetLang: string, sourceLang: string, scene: string, glossary = ""): string {
  const parts: string[] = [
    `You are a translator. Translate the user's utterance into ${targetLang}. ` +
      "Output ONLY the translation. No preamble, no quotes, no commentary. " +
      "Keep technical terms, brand names, and proper nouns in their original " +
      "language when natural.",
  ];
  const src = (sourceLang || "").trim();
  if (src && src.toLowerCase() !== "auto") parts.push(`Source language: ${src}.`);
  if (scene) parts.push(`Scene: ${scene}`);
  if (glossary) parts.push(glossaryNote(glossary));
  return parts.join("\n\n");
}

// Paired-translation system instruction (Claude only). Per-turn the model also
// reconsiders the IMMEDIATELY PREVIOUS sentence's translation given the new
// context. 3-shot prompt validated 10/10 against a 10-case battery on Haiku 4.5.
export function buildPairedTranslationSystemInstruction(targetLang: string, sourceLang: string, scene: string, glossary = ""): string {
  let head =
    `Real-time ${targetLang} interpreter. Each turn, also reconsider ` +
    "the previous translation given the new sentence.\n\n" +
    "Default KEEP — <prev> must be byte-identical to the input. REVISE " +
    "only when the new sentence reveals: a wrong word sense, a " +
    "mid-clause/number cut completed by new, or actual ambiguity. " +
    "Stylistic tweaks are NOT a reason — they cause UI flicker.\n\n" +
    "<curr> must NEVER be empty. Even if the new sentence is " +
    "fragmentary, garbled, a song-lyric piece, or unclear, output a " +
    "best-effort translation in <curr>. The UI shows <curr> as the " +
    "live caption for this turn — empty <curr> = blank caption = bug.";
  const src = (sourceLang || "").trim();
  if (src && src.toLowerCase() !== "auto") head += `\n\nSource language: ${src}.`;
  if (scene) head += `\n\nScene: ${scene}`;
  if (glossary) head += `\n\n${glossaryNote(glossary)}`;
  return (
    head +
    "\n\nOutput ONLY the three blocks:\n" +
    "<d>keep</d> or <d>revise</d>\n" +
    "<curr>translation of the new sentence</curr>\n" +
    "<prev>previous translation, verbatim or revised</prev>\n\n" +
    "Examples:\n\n" +
    "(KEEP — prev complete, new unrelated)\n" +
    "prev_src: 今日は本当に楽しかったです。\n" +
    "prev_dst: 今天真的很开心。\n" +
    "new_src:  では、次に行きましょう。\n" +
    "→ <d>keep</d>\n" +
    "  <curr>那么，我们继续下一个吧。</curr>\n" +
    "  <prev>今天真的很开心。</prev>\n\n" +
    "(REVISE — mid-clause cut, new completes thought)\n" +
    "prev_src: 私たちは慎重にこの問題を扱う必要があると\n" +
    "prev_dst: 我们需要慎重处理这个问题，\n" +
    "new_src:  思っていますが、時間がかかっても価値があります。\n" +
    "→ <d>revise</d>\n" +
    "  <curr>虽然会花时间，但这是值得的。</curr>\n" +
    "  <prev>我们认为需要慎重处理这个问题，</prev>\n\n" +
    "(REVISE — figurative meaning revealed)\n" +
    "prev_src: このチームは本当に熱いですね。\n" +
    "prev_dst: 这支队伍真的很热。\n" +
    "new_src:  試合を諦めずに最後まで戦い抜きました。\n" +
    "→ <d>revise</d>\n" +
    "  <curr>他们没有放弃，战斗到了最后一刻。</curr>\n" +
    "  <prev>这支队伍真的很有热情。</prev>\n"
  );
}

export function buildTranslationPrompt(sentence: string, history: Array<[string, string]>, isPartial = false): string {
  const parts: string[] = [];
  if (history.length) {
    const ctx = history.map(([src, dst]) => `  ${src} → ${dst}`).join("\n");
    parts.push(
      "Previous translations in this session (for terminology and " +
        `pronoun consistency, do not re-translate them):\n${ctx}\n\n`,
    );
  }
  if (isPartial) {
    parts.push(
      "PARTIAL utterance — speaker is still mid-sentence, more text " +
        "will arrive. Translate what is given so far. Output only the " +
        `translation:\n${sentence}`,
    );
  } else {
    parts.push(`Now translate this new utterance:\n${sentence}`);
  }
  return parts.join("");
}

// ---------- helpers ----------

// Last index of any sentence-ending punctuation in text, or -1. With
// includeSoft, commas/semicolons (EN/JP/ZH) also count.
export function findLastPunct(text: string, includeSoft = false): number {
  const chars = SENTENCE_PUNCT + (includeSoft ? SENTENCE_PUNCT_SOFT : "");
  let last = -1;
  for (const p of chars) {
    const i = text.lastIndexOf(p);
    if (i > last) last = i;
  }
  return last;
}

// Incrementally parses the paired response <d>…</d><curr>…</curr><prev>…</prev>.
// Streams the inner text of <curr> as soon as it arrives; characters that
// could be the start of its closing tag are held back so a partial tag is
// never shown. Tags are matched case-insensitively and with either bracket
// on either side ("</CURR]", "[/curr]"), since models sometimes mix them.
// <d> and <prev> are extracted from the full buffer in finalize().
const tagRe = (name: string, close: boolean, flags = "i"): RegExp =>
  new RegExp(`[<\\[]${close ? "\\/" : ""}${name}\\s*[>\\]]`, flags);
const blockRe = (name: string): RegExp =>
  new RegExp(`[<\\[]${name}\\s*[>\\]]\\s*([\\s\\S]*?)\\s*[<\\[]\\/${name}\\s*[>\\]]`, "i");
// A suffix that may still grow into "</curr>": "<", "</", "</c", … "</curr".
const CLOSE_CURR_PREFIX = /[<[](\/(c(u(r(r)?)?)?)?)?$/i;

export class PairedStreamParser {
  full = "";
  private cursor = 0;
  private state: "before_curr" | "in_curr" | "done" = "before_curr";

  // Returns whatever <curr> text became safe to emit during this feed.
  feed(chunk: string): string {
    this.full += chunk;
    const out: string[] = [];
    for (;;) {
      if (this.state === "before_curr") {
        const open = tagRe("curr", false, "ig");
        open.lastIndex = this.cursor;
        const m = open.exec(this.full);
        if (!m) break;
        this.cursor = m.index + m[0].length;
        // skip leading whitespace inside the block
        while (this.cursor < this.full.length && " \t\n".includes(this.full[this.cursor])) {
          this.cursor += 1;
        }
        this.state = "in_curr";
      }
      if (this.state === "in_curr") {
        const close = tagRe("curr", true, "ig");
        close.lastIndex = this.cursor;
        const m = close.exec(this.full);
        if (m) {
          const text = this.full.slice(this.cursor, m.index).replace(/\s+$/u, ""); // rstrip
          if (text) out.push(text);
          this.cursor = m.index + m[0].length;
          this.state = "done";
          continue;
        }
        // No closing tag yet: emit everything but a possible start of one.
        let tail = this.full.length;
        const hold = CLOSE_CURR_PREFIX.exec(this.full.slice(this.cursor));
        if (hold) tail -= hold[0].length;
        if (tail > this.cursor) {
          out.push(this.full.slice(this.cursor, tail));
          this.cursor = tail;
        }
        break;
      }
      if (this.state === "done") break;
    }
    return out.join("");
  }

  finalize(): { decision: string | null; prev: string | null; curr: string } {
    const dM = blockRe("d").exec(this.full);
    const pM = blockRe("prev").exec(this.full);
    const cM = blockRe("curr").exec(this.full);
    return {
      decision: dM ? dM[1].trim().toLowerCase() : null,
      prev: pM ? pM[1].trim() : null,
      curr: cM ? cM[1].trim() : "",
    };
  }
}

const RETRY_RE = /retryDelay['"]?\s*:\s*['"]?(\d+(?:\.\d+)?)s?/;

// Pull retryDelay out of a Google API 429 error message and clamp it.
export function extractRetryDelay(msg: string, def = 5.0): number {
  const m = RETRY_RE.exec(msg);
  if (!m) return def;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return def;
  return Math.min(Math.max(v, 1.0), 30.0);
}
