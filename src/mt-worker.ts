// Runs Firefox's Bergamot WASM on one route (two models = pivot). A thread,
// as the WASM translates synchronously (20-170 ms a sentence).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

export interface MtWorkerData {
  vendorDir: string;
  models: Array<{ from: string; to: string; dir: string }>;
}

type Bergamot = any;

const port = parentPort!;
const data = workerData as MtWorkerData;
const post = (msg: Record<string, unknown>) => port.postMessage(msg);

// The glue logs to console.log; keep it out of stdout.
console.log = (...a: unknown[]) => post({ type: "log", message: a.map(String).join(" ") });

// Firefox's MODEL_FILE_ALIGNMENTS.
const ALIGN: Record<string, number> = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };

// As in Firefox's translations-engine.worker.js.
const CONFIG = {
  "beam-size": "1",
  normalize: "1.0",
  "word-penalty": "0",
  "max-length-break": "128",
  "mini-batch-words": "1024",
  workspace: "128",
  "max-length-factor": "2.0",
  "skip-cost": "true",
  "cpu-threads": "0",
  quiet: "true",
  "quiet-translation": "true",
  "gemm-precision": "int8shiftAlphaAll",
  alignment: "soft",
};

async function loadEngine(): Promise<Bergamot> {
  // Node has no WebAssembly.mozIntGemm, so the WASM's fallback gemm runs.
  const glue = readFileSync(join(data.vendorDir, "bergamot-translator.js"), "utf-8");
  const loadBergamot = vm.runInThisContext(`${glue}\n;loadBergamot`, { filename: "bergamot-translator.js" });
  return new Promise((resolve, reject) => {
    const Module: Record<string, unknown> = {
      wasmBinary: readFileSync(join(data.vendorDir, "bergamot-translator.wasm")),
      print: () => {},
      printErr: (s: string) => post({ type: "log", message: s }),
      onAbort: (what: unknown) => reject(new Error(`bergamot aborted: ${String(what)}`)),
    };
    Module.onRuntimeInitialized = () => resolve(Module);
    loadBergamot(Module);
  });
}

function loadModel(b: Bergamot, m: MtWorkerData["models"][number]): Bergamot {
  const files: Record<string, Bergamot> = {};
  for (const name of readdirSync(m.dir)) {
    const kind = name.split(".")[0];
    if (!(kind in ALIGN)) continue;
    const buf = readFileSync(join(m.dir, name));
    const mem = new b.AlignedMemory(buf.byteLength, ALIGN[kind]);
    mem.getByteArrayView().set(buf);
    files[kind] = mem;
  }
  const vocabs = new b.AlignedMemoryList();
  if (files.vocab) vocabs.push_back(files.vocab);
  else {
    vocabs.push_back(files.srcvocab);
    vocabs.push_back(files.trgvocab);
  }
  const yaml = "\n" + Object.entries(CONFIG).map(([k, v]) => `${k}: ${v}\n`).join("");
  // Real language codes: the WASM splits sentences with Intl.Segmenter(from).
  return new b.TranslationModel(m.from, m.to, yaml, files.model, files.lex ?? null, vocabs, null);
}

async function main(): Promise<void> {
  let b: Bergamot;
  let models: Bergamot[];
  let service: Bergamot;
  try {
    b = await loadEngine();
    models = data.models.map((m) => loadModel(b, m));
    service = new b.BlockingService({ cacheSize: 0 });
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    return;
  }

  const translate = (text: string): string => {
    const msgs = new b.VectorString();
    const opts = new b.VectorResponseOptions();
    msgs.push_back(text);
    opts.push_back({ qualityScores: false, alignment: false, html: false });
    let res: Bergamot = null;
    try {
      res = models.length === 1 ? service.translate(models[0], msgs, opts) : service.translateViaPivoting(models[0], models[1], msgs, opts);
      return res.get(0).getTranslatedText();
    } finally {
      msgs.delete();
      opts.delete();
      res?.delete();
    }
  };

  // The first translation takes ~0.5 s; not on the first caption.
  try {
    translate("Hello.");
  } catch {
    /* the real requests will report it */
  }

  port.on("message", (msg: { type: string; id: number; text: string }) => {
    if (msg.type !== "translate") return;
    try {
      post({ type: "result", id: msg.id, text: msg.text.trim() ? translate(msg.text) : "" });
    } catch (e) {
      post({ type: "result", id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
  });
  post({ type: "ready" });
}

void main();
