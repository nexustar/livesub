// Configuration + backend registry — env constants, the translate-backend
// registry (built-ins + livesub.toml), and per-backend availability checks.
// Two path anchors: user config (.env / livesub.toml) resolves against the
// working directory, bundled assets (static/) against the package root — see
// ROOT and PKG_DIR below.

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { parse as parseToml } from "smol-toml";
import { MT_BASE_URL } from "./mt-models.js";
import { log } from "./util.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src (dev) or .../dist (built)
// Bundled assets (static/) sit next to the code — repo root in dev, package root
// once installed (src/ and dist/ are each one level below their root).
const PKG_DIR = dirname(HERE);
// User config (.env / livesub.toml / relative model paths) resolves from the
// current working directory, so an installed `livesub` reads the .env where it's
// launched — not from inside node_modules. Overridable via LIVESUB_CONFIG_DIR.
export const ROOT = process.env.LIVESUB_CONFIG_DIR || process.cwd();
loadDotenv({ path: join(ROOT, ".env") });

function env(key: string, def = ""): string {
  const v = process.env[key];
  return v === undefined ? def : v;
}

// Fail fast on a non-numeric env value, matching Python's float(os.environ[...])
// which raises at import rather than silently yielding NaN at runtime.
function envFloat(key: string, def: string): number {
  const raw = env(key, def);
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new Error(`env ${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

// Resolve a possibly-relative path against ROOT (the config dir). Relative
// model/dir paths in .env are taken relative to where livesub is launched —
// the same directory .env itself is read from — not the package install dir.
export function resolveRel(p: string): string {
  if (!p) return p;
  return isAbsolute(p) ? p : join(ROOT, p);
}

export const GEMINI_API_KEY = env("GEMINI_API_KEY");
// Dedicated Live-API ASR model, not a dialog model: no system prompt; biasing
// goes through languageCodes/customVocabulary. The old native-audio default
// transcribed nothing (VAD on) or garbage (VAD off) on noisy audio.
export const ASR_MODEL = env("GEMINI_ASR_MODEL", "gemini-3.5-transcribe-live");
export const TRANSLATE_MODEL = env("GEMINI_TRANSLATE_MODEL", "gemini-3.1-flash-lite");

export const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
export const DEEPSEEK_API_KEY = env("DEEPSEEK_API_KEY");
export const OPENAI_API_KEY = env("OPENAI_API_KEY");
export const OPENAI_REALTIME_MODEL = env("OPENAI_REALTIME_MODEL", "gpt-realtime-whisper");
export const DASHSCOPE_API_KEY = env("DASHSCOPE_API_KEY");
// DashScope Qwen3-ASR-Flash-Realtime — Alibaba's cloud-hosted Qwen ASR. Two
// regions: international (Singapore) at dashscope-intl, mainland China at
// dashscope. Default to international; override via env if needed.
export const DASHSCOPE_BASE_URL = env(
  "DASHSCOPE_BASE_URL",
  "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime",
);
export const DASHSCOPE_REALTIME_MODEL = env("DASHSCOPE_REALTIME_MODEL", "qwen3-asr-flash-realtime");
// Server VAD threshold for DashScope (range 0-1, lower = catch quieter speech,
// higher = need louder audio). Alibaba documents 0.2; 0.5 is our empirical
// default — tune per environment.
export const DASHSCOPE_VAD_THRESHOLD = envFloat("DASHSCOPE_VAD_THRESHOLD", "0.5");

// ISO-639-1 codes for the source-language hint passed to cloud ASR backends
// (openai-realtime, qwen-cloud). Covers the 11 languages that
// qwen3-asr-flash-realtime supports — the smallest superset across
// hint-accepting backends. Keys are lowercased natural-language names matching
// the frontend <select> values. Unknown keys fall through (pass-through).
export const SOURCE_LANG_ISO: Record<string, string> = {
  chinese: "zh",
  english: "en",
  japanese: "ja",
  korean: "ko",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  arabic: "ar",
  russian: "ru",
};

export const DEEPSEEK_BASE_URL = env("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic");

export type TranslateSdk = "anthropic" | "openai" | "gemini" | "bergamot" | "none";

export interface TranslateBackend {
  id: string;
  label: string;
  sdk: TranslateSdk;
  model: string | null;
  api_key_env?: string;
  base_url?: string;
}

// Translator backends. Single source of truth for the UI dropdown, which SDK to
// talk to, what model, and where to point. Users add their own via livesub.toml
// (same schema).
export const TRANSLATE_BACKENDS_BUILTIN: TranslateBackend[] = [
  { id: "claude-haiku", label: "Claude Haiku", sdk: "anthropic", model: "claude-haiku-5-5", api_key_env: "ANTHROPIC_API_KEY" },
  { id: "claude-sonnet", label: "Claude Sonnet", sdk: "anthropic", model: "claude-sonnet-5-5", api_key_env: "ANTHROPIC_API_KEY" },
  {
    id: "deepseek-flash",
    label: "DeepSeek Flash",
    sdk: "anthropic",
    model: env("DEEPSEEK_TRANSLATE_MODEL", "deepseek-flash"),
    api_key_env: "DEEPSEEK_API_KEY",
    base_url: DEEPSEEK_BASE_URL,
  },
  { id: "gemini", label: "Gemini", sdk: "gemini", model: null, api_key_env: "GEMINI_API_KEY" },
  // After the keyed ones: the default only without an API key.
  { id: "local", label: "Local translation", sdk: "bergamot", model: null },
  { id: "none", label: "None (transcript only)", sdk: "none", model: null },
];

// Read user-defined backends from livesub.toml (config dir, see ROOT) if present. Skipped
// silently when the file doesn't exist. Each entry must have id/label/sdk/model.
function loadCustomTranslateBackends(): TranslateBackend[] {
  const cfgPath = join(ROOT, "livesub.toml");
  if (!existsSync(cfgPath)) return [];
  let data: unknown;
  try {
    data = parseToml(readFileSync(cfgPath, "utf-8"));
  } catch (e) {
    log.error(`livesub.toml parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const out: TranslateBackend[] = [];
  const entries = (data as { translate?: unknown }).translate;
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const missing = (["id", "label", "sdk", "model"] as const).filter((k) => !(k in e));
    if (missing.length) {
      log.warning(`livesub.toml: skipping entry missing ${JSON.stringify(missing)}: ${JSON.stringify(e)}`);
      continue;
    }
    if (e.sdk !== "anthropic" && e.sdk !== "openai") {
      log.warning(`livesub.toml: sdk must be 'anthropic' or 'openai', got ${JSON.stringify(e.sdk)} (entry ${JSON.stringify(e.id)})`);
      continue;
    }
    out.push(e as unknown as TranslateBackend);
  }
  return out;
}

// Built-ins first, then user-defined. Order = dropdown order.
export function allTranslateBackends(): TranslateBackend[] {
  return [...TRANSLATE_BACKENDS_BUILTIN, ...loadCustomTranslateBackends()];
}

// Available iff (a) no api_key_env declared (keyless / always-on), or (b) the
// env var is set non-empty.
export function backendAvailable(b: TranslateBackend): boolean {
  if (!b.api_key_env) return true;
  return Boolean(process.env[b.api_key_env]);
}

export function getTranslateBackend(backendId: string): TranslateBackend | null {
  for (const b of allTranslateBackends()) {
    if (b.id === backendId) return b;
  }
  return null;
}

// Turn extended thinking off on every translation call (it inflates output
// tokens / latency). claude-sonnet-5-5 rejects {type: "disabled"} with a 400
// and takes {type: "between_tools"} instead; everything else wants "disabled".
export type AnthropicThinkingOff = { type: "disabled" } | { type: "between_tools" };
export function anthropicThinkingOff(model: string): AnthropicThinkingOff {
  return model.includes("claude-sonnet-5-5") ? { type: "between_tools" } : { type: "disabled" };
}

// /api/hints (scene-seed -> glossary research): one backend per search engine,
// picked in the UI. HINTS_BACKEND sets the default; "auto" takes the first
// available, in registry order.
export const HINTS_BACKEND = env("HINTS_BACKEND", "auto").trim().toLowerCase();
export const HINTS_CLAUDE_MODEL = env("HINTS_CLAUDE_MODEL", "claude-sonnet-5-5");
export const HINTS_GEMINI_MODEL = env("HINTS_GEMINI_MODEL", "gemini-2.5-flash");

export interface HintsBackend {
  id: string;
  label: string;
  // "anthropic": the web_search server tool (DeepSeek's compatible endpoint
  // runs its own engine behind it). "gemini": google_search grounding.
  sdk: "anthropic" | "gemini";
  model: string;
  api_key_env: string;
  base_url?: string;
  // output_config.effort (anthropic SDK).
  effort?: "low" | "medium" | "high";
}

export const HINTS_BACKENDS: HintsBackend[] = [
  { id: "gemini", label: "Google Search (Gemini)", sdk: "gemini", model: HINTS_GEMINI_MODEL, api_key_env: "GEMINI_API_KEY" },
  // low skips searches it needs.
  { id: "claude", label: "Claude web search", sdk: "anthropic", model: HINTS_CLAUDE_MODEL, api_key_env: "ANTHROPIC_API_KEY", effort: "medium" },
  {
    id: "deepseek",
    label: "DeepSeek web search",
    sdk: "anthropic",
    model: "deepseek-flash",
    api_key_env: "DEEPSEEK_API_KEY",
    base_url: DEEPSEEK_BASE_URL,
    // Thinking off skips searches it needs; higher effort is slower.
    effort: "low",
  },
];

export const DEFAULT_TARGET_LANG = "Chinese (Simplified)";
export const HISTORY_PAIRS = 5;

// Sentence-boundary fallbacks when no .!?。！？ shows up:
export const SENTENCE_MAX_CHARS = 50;
export const SENTENCE_IDLE_FLUSH_SEC = 5.0;
// Intra-sentence partial translation pacing (anthropic-/openai-SDK and local backends).
export const PARTIAL_HARD_FLOOR_SEC = 0.4;
export const PARTIAL_MIN_NEW_BYTES = 24;

// Gemini interim consumption: hold back the hypothesis tail (in-place rewrites
// cluster in the last ~15 chars; forwarding them eagerly duplicates text) and
// flush the held tail once the hypothesis has been idle this long.
export const GEMINI_INTERIM_HOLDBACK_CHARS = 20;
export const GEMINI_INTERIM_FLUSH_SEC = 1.5;

// Audio gate: skip chunks whose absolute peak is below this (synthetic silence).
export const AUDIO_GATE_PEAK = 200;
// Pre-buffer length (in 40ms chunks) replayed on silent->speech transition.
export const AUDIO_PREBUFFER_CHUNKS = 12;

// Data dir for livesub-managed files (downloaded models), at the platform's
// conventional location. Overridable via LIVESUB_DATA_DIR.
function defaultDataDir(): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "livesub");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "livesub");
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "livesub");
}
export const DATA_DIR = process.env.LIVESUB_DATA_DIR ? resolveRel(process.env.LIVESUB_DATA_DIR) : defaultDataDir();

// Hugging Face endpoint for model downloads; point at a mirror (e.g.
// https://hf-mirror.com) where huggingface.co is slow or blocked.
export const HF_ENDPOINT = env("HF_ENDPOINT", "https://huggingface.co").replace(/\/+$/, "");
// Local translation models: Firefox's CDN or a mirror of it.
export const MT_ENDPOINT = env("MT_ENDPOINT", MT_BASE_URL).replace(/\/+$/, "");

// Listen address (CLI --host / --port). Loopback by default, as anyone who
// can reach the port can spend the API keys; 0.0.0.0 opens it to the LAN.
// Port 0 takes a free one.
export const HOST = env("LIVESUB_HOST").trim() || "127.0.0.1";
export const PORT = (() => {
  const raw = env("LIVESUB_PORT", "8000").trim();
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n > 65535) throw new Error(`LIVESUB_PORT must be 0-65535, got ${JSON.stringify(raw)}`);
  return n;
})();
// Extra hostnames accepted in Host / Origin headers, comma-separated: a
// reverse proxy's public name (see the request guards in server.ts).
export const ALLOWED_HOSTS = new Set(
  env("LIVESUB_ALLOWED_HOSTS").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
);

export function isLoopbackHost(h: string): boolean {
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// Prebuilt qwen_asr from the qwen-asr npm package (an optional dependency:
// npm skips it where it has no binary, e.g. Windows on arm64). On failure, bin is ""
// and reason says why, for the UI.
function packagedQwenBin(): { bin: string; reason: string } {
  try {
    const { binaryPath } = createRequire(import.meta.url)("qwen-asr") as { binaryPath(): string };
    return { bin: binaryPath(), reason: "" };
  } catch (e) {
    if ((e as { code?: string }).code === "MODULE_NOT_FOUND") {
      return { bin: "", reason: `no prebuilt qwen-asr for ${process.platform}-${process.arch}` };
    }
    return { bin: "", reason: e instanceof Error ? e.message : String(e) };
  }
}
const QWEN_PACKAGED = packagedQwenBin();

// qwen-asr --stream-chunk-sec range accepted by the binary, and our default.
export const QWEN_CHUNK_SEC_MIN = 1;
export const QWEN_CHUNK_SEC_MAX = 8;
export const QWEN_CHUNK_SEC_DEFAULT = 2;

// qwen-asr — local C inference subprocess. QWEN_ASR_BIN wins, then the
// packaged binary, then qwen_asr on PATH.
export const QWEN_BIN = env("QWEN_ASR_BIN") || QWEN_PACKAGED.bin || "qwen_asr";
// Why the packaged binary can't be used, when it can't (shown when no qwen_asr
// is found at all).
export const QWEN_PACKAGED_REASON = QWEN_PACKAGED.reason;

// voxtral.c — local C inference of Mistral Voxtral Realtime 4B.
export const VOXTRAL_BIN = env("VOXTRAL_BIN", "voxtral");
export const VOXTRAL_MODEL_DIR = env("VOXTRAL_MODEL_DIR", "voxtral-realtime-4b");
export const VOXTRAL_INTERVAL_SEC = envFloat("VOXTRAL_INTERVAL_SEC", "2.0");

// Two qwen3-asr variants ship in the same binary; only the model dir differs.
// Each is either external (its env var names a dir the user manages) or
// managed (livesub downloads it into DATA_DIR/models/). Revisions are pinned
// so the sizes and checksums below stay valid; sha256 is only published for
// the LFS weight files, the small files are checked by size.
export interface QwenModelFile {
  name: string;
  size: number;
  sha256?: string;
}
export interface QwenModel {
  id: "qwen-small" | "qwen-large";
  label: string;
  repo: string;
  revision: string;
  dirName: string;
  envName: string;
  envDir: string;
  files: QwenModelFile[];
}
const QWEN_TOKENIZER_FILES: QwenModelFile[] = [
  { name: "vocab.json", size: 2776833 },
  { name: "merges.txt", size: 1671853 },
];
export const QWEN_MODELS: QwenModel[] = [
  {
    id: "qwen-small",
    label: "Qwen3-ASR 0.6B",
    repo: "Qwen/Qwen3-ASR-0.6B",
    revision: "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
    dirName: "qwen3-asr-0.6b",
    envName: "QWEN_ASR_MODEL_DIR_SMALL",
    envDir: env("QWEN_ASR_MODEL_DIR_SMALL", ""),
    files: [
      { name: "config.json", size: 6193 },
      { name: "generation_config.json", size: 142 },
      ...QWEN_TOKENIZER_FILES,
      { name: "model.safetensors", size: 1876091704, sha256: "79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea" },
    ],
  },
  {
    id: "qwen-large",
    label: "Qwen3-ASR 1.7B",
    repo: "Qwen/Qwen3-ASR-1.7B",
    revision: "7278e1e70fe206f11671096ffdd38061171dd6e5",
    dirName: "qwen3-asr-1.7b",
    envName: "QWEN_ASR_MODEL_DIR_LARGE",
    envDir: env("QWEN_ASR_MODEL_DIR_LARGE", ""),
    files: [
      { name: "config.json", size: 6194 },
      { name: "generation_config.json", size: 142 },
      ...QWEN_TOKENIZER_FILES,
      { name: "model.safetensors.index.json", size: 64821 },
      { name: "model-00001-of-00002.safetensors", size: 4220320824, sha256: "a4cd1f1a04d90b757dc7f7dd26254e69a013b19e80efe590a83c6a3bde8608d6" },
      { name: "model-00002-of-00002.safetensors", size: 478200688, sha256: "6e0b9d9e09e2e0238e7ef3cc8a484ab387e91b90f1900bedf88bc92d7929ccfc" },
    ],
  },
];

// Frontend assets ship with the package (next to the code). Overridable via
// LIVESUB_STATIC_DIR.
export const STATIC_DIR = process.env.LIVESUB_STATIC_DIR || join(PKG_DIR, "static");

// Hard punctuation: cut here whenever it appears (sentence terminators).
export const SENTENCE_PUNCT = ".!?。！？\n";
// Soft punctuation: cut here only when the buffer is already getting long.
export const SENTENCE_PUNCT_SOFT = ",;、，；";
// Once buffer reaches this length, allow soft-punct cuts.
export const SOFT_CUT_THRESHOLD = 30;

// ---------- availability helpers ----------

function isExecFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// In-process equivalent of shutil.which — no shell fork (the old execSync
// blocked the event loop on every /api/backends request). A bare name is
// searched on PATH; a path-like value is resolved (abs, or ROOT-relative) and
// checked directly.
function isPathLike(bin: string): boolean {
  return bin.includes("/") || (process.platform === "win32" && bin.includes("\\"));
}

export function which(bin: string): string | null {
  if (isPathLike(bin)) {
    const abs = resolveRel(bin);
    return isExecFile(abs) ? abs : null;
  }
  const names = process.platform === "win32" && !bin.toLowerCase().endsWith(".exe") ? [bin, `${bin}.exe`] : [bin];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (isExecFile(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

// `shutil.which(bin) or bin`, with relative paths resolved against ROOT.
export function resolveBin(bin: string): string {
  const w = which(bin);
  if (w) return w;
  if (isPathLike(bin) && !isAbsolute(bin)) return join(ROOT, bin);
  return bin;
}

// A local ASR backend is available iff its binary is callable (on PATH or a
// resolvable file) AND its model directory exists.
export function localAsrAvailable(binPath: string, modelDir: string): boolean {
  if (!modelDir) return false;
  const binOk = which(binPath) !== null || isFile(resolveRel(binPath));
  return binOk && existsSync(resolveRel(modelDir));
}

export function qwenModel(backendId: string): QwenModel | null {
  return QWEN_MODELS.find((m) => m.id === backendId) ?? null;
}

// Absolute model dir: the env-configured dir when set, else the managed one.
export function qwenModelDir(m: QwenModel): string {
  return m.envDir ? resolveRel(m.envDir) : join(DATA_DIR, "models", m.dirName);
}

export function qwenBinAvailable(): boolean {
  return which(QWEN_BIN) !== null || isFile(resolveRel(QWEN_BIN));
}

// Why there's no usable qwen_asr (null when there is one): a QWEN_ASR_BIN
// that points nowhere ("config"), or no binary for this machine ("platform").
export function qwenUnavailable(): { kind: "config" | "platform"; reason: string } | null {
  if (qwenBinAvailable()) return null;
  if (process.env.QWEN_ASR_BIN) return { kind: "config", reason: `QWEN_ASR_BIN not found: ${process.env.QWEN_ASR_BIN}` };
  return { kind: "platform", reason: QWEN_PACKAGED_REASON || "qwen_asr not found" };
}

// An external dir is trusted as long as it exists; a managed one must hold
// every file at its full size (downloads land as .part and are renamed only
// once verified, so this also excludes one in progress).
export function qwenModelReady(m: QwenModel): boolean {
  const dir = qwenModelDir(m);
  if (m.envDir) return existsSync(dir);
  return m.files.every((f) => {
    try {
      return statSync(join(dir, f.name)).size === f.size;
    } catch {
      return false;
    }
  });
}

// Translate dropdown contents — registry filtered by env availability.
// context: uses the scene summary and glossary.
export function listTranslateBackends(): Array<{ id: string; label: string; context: boolean }> {
  return allTranslateBackends()
    .filter(backendAvailable)
    .map((b) => ({ id: b.id, label: b.label, context: b.sdk === "anthropic" || b.sdk === "openai" || b.sdk === "gemini" }));
}

// ASR dropdown contents — cloud gated by API key, local gated by binary + model
// dir presence. Local backends listed first so they're the default on a fresh
// install when both local and cloud are available. With the qwen binary found,
// a managed model is listed even before it's downloaded (ready: false) so the
// UI can offer the download; only ready entries can run a session. glossary:
// biases recognition with the glossary.
export function listAsrBackends(): Array<{ id: string; label: string; ready: boolean; glossary?: boolean }> {
  const out: Array<{ id: string; label: string; ready: boolean; glossary?: boolean }> = [];
  if (qwenBinAvailable()) {
    for (const m of QWEN_MODELS) {
      const ready = qwenModelReady(m);
      if (ready || !m.envDir) out.push({ id: m.id, label: m.id === "qwen-large" ? "Qwen (large, local)" : "Qwen (small, local)", ready });
    }
  }
  if (localAsrAvailable(VOXTRAL_BIN, VOXTRAL_MODEL_DIR)) out.push({ id: "voxtral", label: "Voxtral (local)", ready: true });
  if (DASHSCOPE_API_KEY) out.push({ id: "qwen-cloud", label: "Qwen ASR (Cloud)", ready: true });
  if (OPENAI_API_KEY) out.push({ id: "openai-realtime", label: "OpenAI Realtime", ready: true });
  if (process.env.GEMINI_API_KEY) out.push({ id: "gemini", label: "Gemini Live", ready: true, glossary: true });
  return out;
}

// Hints backends whose API key is set, in registry order.
export function listHintsBackends(): HintsBackend[] {
  return HINTS_BACKENDS.filter((b) => Boolean(process.env[b.api_key_env]));
}

// The requested backend, or with none requested the default. An unavailable
// request is null, not a silent fallback to another engine.
export function pickHintsBackend(requested?: string): HintsBackend | null {
  const avail = listHintsBackends();
  if (requested) return avail.find((b) => b.id === requested) ?? null;
  return avail.find((b) => b.id === HINTS_BACKEND) ?? avail[0] ?? null;
}
