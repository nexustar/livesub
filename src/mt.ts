// Local translation with Firefox's models: language codes, routes (pivoting
// through English), model dirs, and worker threads shared across sessions.

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { DATA_DIR } from "./config.js";
import { MT_MODELS, type MtModel } from "./mt-models.js";
import type { MtWorkerData } from "./mt-worker.js";
import { log } from "./util.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(dirname(HERE), "vendor", "bergamot");
// .ts under tsx in dev, .js once built.
const WORKER_URL = new URL(`./mt-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url);
// Kept loaded this long after its last session, for reconnects.
const ENGINE_IDLE_MS = 60_000;

// ---------- languages ----------

const CODES = [...new Set(MT_MODELS.flatMap((m) => [m.from, m.to]))];

// "Japanese", "日语" and "ja" all map to "ja": the target field is free text.
const NAME_TO_CODE = (() => {
  const map = new Map<string, string>();
  const add = (name: string | undefined, code: string) => {
    if (name) map.set(name.trim().toLowerCase(), code);
  };
  for (const locale of ["en", "zh-Hans", "zh-Hant"]) {
    const names = new Intl.DisplayNames([locale], { type: "language" });
    for (const code of CODES) add(names.of(code), code);
  }
  for (const code of CODES) add(code, code);
  const aliases: Record<string, string> = {
    chinese: "zh-Hans",
    "chinese (simplified)": "zh-Hans",
    "chinese (traditional)": "zh-Hant",
    mandarin: "zh-Hans",
    zh: "zh-Hans",
    "zh-cn": "zh-Hans",
    "zh-tw": "zh-Hant",
    "zh-hk": "zh-Hant",
    中文: "zh-Hans",
    简体中文: "zh-Hans",
    繁体中文: "zh-Hant",
    繁體中文: "zh-Hant",
    norwegian: "nb",
  };
  for (const [name, code] of Object.entries(aliases)) if (CODES.includes(code)) add(name, code);
  return map;
})();

export function mtLangCode(name: string): string | null {
  return NAME_TO_CODE.get(name.trim().toLowerCase()) ?? null;
}

// Auto source: guess by script. Latin script can't be told apart, so it's
// taken as English.
export function detectLang(text: string): string | null {
  const scripts: Array<[RegExp, string]> = [
    [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "ja"],
    [/\p{Script=Hangul}/u, "ko"],
    [/\p{Script=Han}/u, "zh-Hans"],
    [/\p{Script=Cyrillic}/u, "ru"],
    [/\p{Script=Arabic}/u, "ar"],
    [/\p{Script=Hebrew}/u, "he"],
    [/\p{Script=Greek}/u, "el"],
    [/\p{Script=Thai}/u, "th"],
    [/\p{Script=Devanagari}/u, "hi"],
    [/\p{Script=Latin}/u, "en"],
  ];
  for (const [re, code] of scripts) if (re.test(text)) return CODES.includes(code) ? code : null;
  return null;
}

// ---------- routes and model dirs ----------

export function mtModelId(m: MtModel): string {
  return `mt-${m.from}-${m.to}`;
}

export function mtModelById(id: string): MtModel | null {
  return MT_MODELS.find((m) => mtModelId(m) === id) ?? null;
}

export function mtModelDir(m: MtModel): string {
  return join(DATA_DIR, "models", "firefox-translations", `${m.from}-${m.to}`);
}

// Files are renamed into place only once verified (models.ts).
export function mtModelReady(m: MtModel): boolean {
  return m.files.every((f) => {
    try {
      return statSync(join(mtModelDir(m), f.name)).size === f.size;
    } catch {
      return false;
    }
  });
}

// [] for the same language, null when a direction has no model.
export function mtRoute(from: string, to: string): MtModel[] | null {
  if (from === to) return [];
  const find = (a: string, b: string) => MT_MODELS.find((m) => m.from === a && m.to === b);
  const legs = from === "en" || to === "en" ? [find(from, to)] : [find(from, "en"), find("en", to)];
  return legs.every(Boolean) ? (legs as MtModel[]) : null;
}

// ---------- output clean-up ----------

const FULLWIDTH: Record<string, string> = { ",": "，", "!": "！", "?": "？", ":": "：", ";": "；" };

// The models write ASCII punctuation in Chinese and Japanese; use full-width
// after CJK characters.
export function polishOutput(text: string, to: string): string {
  if (to.startsWith("zh")) {
    return text.replace(/([\p{Script=Han}\u3000-\u303f\uff00-\uffef])([,!?:;])(?!\d)/gu, (_, c: string, p: string) => c + FULLWIDTH[p]);
  }
  if (to === "ja") {
    return text.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー\u3000-\u303f])([!?])/gu, (_, c: string, p: string) => c + FULLWIDTH[p]);
  }
  return text;
}

// ---------- engine pool ----------

type Pending = { resolve: (s: string) => void; reject: (e: Error) => void };

export class MtEngine {
  readonly key: string;
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private dead: Error | null = null;
  refs = 0;
  idleTimer: NodeJS.Timeout | null = null;

  constructor(key: string, route: MtModel[]) {
    this.key = key;
    const workerData: MtWorkerData = {
      vendorDir: VENDOR_DIR,
      models: route.map((m) => ({ from: m.from, to: m.to, dir: mtModelDir(m) })),
    };
    const t0 = Date.now();
    this.worker = new Worker(WORKER_URL, { workerData });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on("message", (msg: { type: string; id?: number; text?: string; error?: string; message?: string }) => {
        if (msg.type === "ready") {
          log.info(`local translation engine ${key} loaded in ${Date.now() - t0} ms`);
          resolve();
        } else if (msg.type === "error") {
          this.fail(new Error(msg.message ?? "engine failed to load"));
          reject(this.dead);
        } else if (msg.type === "log") {
          log.debug(`mt ${key}: ${msg.message}`);
        } else if (msg.type === "result" && msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error !== undefined) p?.reject(new Error(msg.error));
          else p?.resolve(msg.text ?? "");
        }
      });
      this.worker.on("error", (e) => {
        this.fail(e);
        reject(e);
      });
      this.worker.on("exit", (code) => {
        this.fail(new Error(`translation worker exited (code ${code})`));
        reject(this.dead);
      });
    });
    this.ready.catch(() => {}); // surfaced through translate()
  }

  private fail(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    if (engines.get(this.key) === this) engines.delete(this.key);
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    void this.worker.terminate();
    log.error(`local translation engine ${this.key}: ${e.message}`);
  }

  async translate(text: string): Promise<string> {
    if (this.dead) throw this.dead;
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "translate", id, text });
    });
  }

  // Marked dead first, so the exit isn't logged as a failure.
  unload(): void {
    this.dead ??= new Error("translation engine unloaded");
    void this.worker.terminate();
  }
}

const engines = new Map<string, MtEngine>();

export function routeKey(route: MtModel[]): string {
  return route.map((m) => `${m.from}-${m.to}`).join("+");
}

// Pair with releaseEngine().
export function acquireEngine(route: MtModel[]): MtEngine {
  const key = routeKey(route);
  let e = engines.get(key);
  if (!e) {
    e = new MtEngine(key, route);
    engines.set(key, e);
  }
  if (e.idleTimer) clearTimeout(e.idleTimer);
  e.idleTimer = null;
  e.refs += 1;
  return e;
}

export function releaseEngine(e: MtEngine): void {
  e.refs -= 1;
  if (e.refs > 0) return;
  e.idleTimer = setTimeout(() => {
    if (e.refs > 0) return;
    if (engines.get(e.key) === e) engines.delete(e.key);
    e.unload();
    log.info(`local translation engine ${e.key} unloaded (idle)`);
  }, ENGINE_IDLE_MS);
  e.idleTimer.unref();
}
