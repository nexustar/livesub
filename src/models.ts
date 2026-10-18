// Managed model downloads — fetches the Qwen3-ASR weights from Hugging Face
// (HF_ENDPOINT) into DATA_DIR/models/. Each file streams into <name>.part,
// resumes with a Range request, and is renamed into place only after its size
// (and sha256, where published) checks out. Job state is in memory; the UI
// polls GET /api/models while a download runs.

import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DATA_DIR, HF_ENDPOINT, QWEN_MODELS, qwenModel, qwenModelDir, qwenModelReady, qwenUnavailable, type QwenModel, type QwenModelFile } from "./config.js";
import { log } from "./util.js";

// Headroom kept free on the disk beyond the bytes still to download.
const DISK_MARGIN_BYTES = 200 * 1024 * 1024;

interface Job {
  abort: AbortController;
  done: number;
}
const jobs = new Map<string, Job>();
const lastError = new Map<string, string>();

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function totalSize(m: QwenModel): number {
  return m.files.reduce((n, f) => n + f.size, 0);
}

// Bytes already on disk for a managed model: finished files plus any .part.
function bytesOnDisk(m: QwenModel): number {
  const dir = qwenModelDir(m);
  return m.files.reduce((n, f) => {
    const done = fileSize(join(dir, f.name));
    return n + (done === f.size ? done : Math.min(fileSize(join(dir, `${f.name}.part`)), f.size));
  }, 0);
}

export type ModelState = "absent" | "downloading" | "ready" | "error" | "missing";

export function listModels() {
  const unavailable = qwenUnavailable();
  return {
    available: !unavailable,
    unavailable_kind: unavailable?.kind,
    unavailable_reason: unavailable?.reason,
    data_dir: DATA_DIR,
    models: QWEN_MODELS.map((m) => {
      const base = { id: m.id, label: m.label, size: totalSize(m), dir: qwenModelDir(m) };
      if (m.envDir) {
        const state: ModelState = qwenModelReady(m) ? "ready" : "missing";
        return { ...base, managed: false, env: m.envName, state, done: 0 };
      }
      const job = jobs.get(m.id);
      let state: ModelState;
      if (job) state = "downloading";
      else if (qwenModelReady(m)) state = "ready";
      else if (lastError.has(m.id)) state = "error";
      else state = "absent";
      return { ...base, managed: true, state, done: job ? job.done : bytesOnDisk(m), error: lastError.get(m.id) };
    }),
  };
}

// Kick off a download in the background. Returns an error message when it
// can't start; progress and failures are reported through listModels().
export function startDownload(id: string): string | null {
  const m = qwenModel(id);
  if (!m) return `unknown model ${JSON.stringify(id)}`;
  if (m.envDir) return `${m.envName} is set; that model dir is managed outside livesub`;
  if (jobs.has(id)) return null;
  if (qwenModelReady(m)) return null;

  const dir = qwenModelDir(m);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return `cannot create ${dir}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const done = bytesOnDisk(m);
  const need = totalSize(m) - done;
  try {
    const fs = statfsSync(dir);
    const free = fs.bavail * fs.bsize;
    if (free < need + DISK_MARGIN_BYTES) {
      return `not enough disk space in ${dir}: need ${(need / 1e9).toFixed(1)} GB, ${(free / 1e9).toFixed(1)} GB free`;
    }
  } catch {
    /* statfs unsupported here — let the write fail instead */
  }

  const job: Job = { abort: new AbortController(), done };
  jobs.set(id, job);
  lastError.delete(id);
  log.info(`model download started: ${m.repo}@${m.revision.slice(0, 8)} -> ${dir}`);
  void (async () => {
    try {
      for (const f of m.files) await downloadFile(m, f, dir, job);
      log.info(`model download finished: ${m.id}`);
    } catch (e) {
      if (job.abort.signal.aborted) {
        log.info(`model download cancelled: ${m.id}`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        lastError.set(id, msg);
        log.error(`model download failed: ${m.id}: ${msg}`);
      }
    } finally {
      jobs.delete(id);
    }
  })();
  return null;
}

async function downloadFile(m: QwenModel, f: QwenModelFile, dir: string, job: Job): Promise<void> {
  const dest = join(dir, f.name);
  if (fileSize(dest) === f.size) return;
  const part = `${dest}.part`;
  let start = fileSize(part);
  if (start > f.size) {
    rmSync(part, { force: true });
    job.done -= f.size;
    start = 0;
  }

  let hash: Hash | null = null;
  if (start < f.size) {
    const url = `${HF_ENDPOINT}/${m.repo}/resolve/${m.revision}/${f.name}`;
    const res = await fetch(url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      signal: job.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${f.name}`);
    // 200 to a Range request means the server sent the whole file: start over.
    const append = start > 0 && res.status === 206;
    if (start > 0 && !append) {
      job.done -= start;
      start = 0;
    }
    if (f.sha256) hash = await hashPrefix(append ? part : null, job.abort.signal);
    const h = hash;
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          h?.update(chunk);
          job.done += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(part, { flags: append ? "a" : "w" }),
      { signal: job.abort.signal },
    );
  } else if (f.sha256) {
    hash = await hashPrefix(part, job.abort.signal);
  }

  const got = fileSize(part);
  if (got !== f.size) throw new Error(`${f.name}: got ${got} bytes, expected ${f.size}`);
  if (f.sha256 && hash) {
    const digest = hash.digest("hex");
    if (digest !== f.sha256) {
      rmSync(part, { force: true });
      job.done -= f.size;
      throw new Error(`${f.name}: checksum mismatch (deleted, retry to download again)`);
    }
  }
  renameSync(part, dest);
}

// A sha256 primed with the bytes already in `part` (for a resumed download).
async function hashPrefix(part: string | null, signal: AbortSignal): Promise<Hash> {
  const hash = createHash("sha256");
  if (part) {
    for await (const chunk of createReadStream(part, { signal })) hash.update(chunk as Buffer);
  }
  return hash;
}

// Stop a running download; the .part files stay so the next start resumes.
export function cancelDownload(id: string): void {
  jobs.get(id)?.abort.abort();
}

export function deleteModel(id: string): string | null {
  const m = qwenModel(id);
  if (!m) return `unknown model ${JSON.stringify(id)}`;
  if (m.envDir) return `${m.envName} is set; that model dir is managed outside livesub`;
  if (jobs.has(id)) return "download in progress; cancel it first";
  rmSync(qwenModelDir(m), { recursive: true, force: true });
  lastError.delete(id);
  log.info(`model deleted: ${m.id}`);
  return null;
}
