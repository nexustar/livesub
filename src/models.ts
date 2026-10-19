// Managed model downloads into DATA_DIR/models/: Qwen3-ASR from Hugging Face
// (HF_ENDPOINT) and the translation models (MT_ENDPOINT). Each file streams
// into <name>.part and is renamed into place only after its size (and sha256,
// where published) checks out. Qwen files resume with a Range request; the
// small zstd translation files start over. Job state is in memory; the UI
// polls GET /api/models while a download runs.

import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

import { DATA_DIR, HF_ENDPOINT, MT_ENDPOINT, QWEN_MODELS, qwenModel, qwenModelDir, qwenModelReady, qwenUnavailable } from "./config.js";
import { mtModelById, mtModelDir, mtModelId, mtModelReady, mtRoute } from "./mt.js";
import { MT_MODELS, MT_RECORDS_URL, type MtModel } from "./mt-models.js";
import { log } from "./util.js";

// Headroom kept free on the disk beyond the bytes still to download.
const DISK_MARGIN_BYTES = 200 * 1024 * 1024;

interface DownloadFile {
  name: string;
  size: number;
  sha256?: string;
  url: string;
  record?: string;
}

interface Download {
  id: string;
  label: string;
  dir: string;
  files: DownloadFile[];
  zstd: boolean;
  ready: () => boolean;
}

function qwenDownload(id: string): Download | null {
  const m = qwenModel(id);
  if (!m || m.envDir) return null;
  return {
    id: m.id,
    label: `${m.repo}@${m.revision.slice(0, 8)}`,
    dir: qwenModelDir(m),
    files: m.files.map((f) => ({ ...f, url: `${HF_ENDPOINT}/${m.repo}/resolve/${m.revision}/${f.name}` })),
    zstd: false,
    ready: () => qwenModelReady(m),
  };
}

function mtDownload(m: MtModel): Download {
  return {
    id: mtModelId(m),
    label: `firefox-translations ${m.from}-${m.to} ${m.version}`,
    dir: mtModelDir(m),
    files: m.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256, url: `${MT_ENDPOINT}/${f.path}`, record: f.record })),
    zstd: true,
    ready: () => mtModelReady(m),
  };
}

function findDownload(id: string): Download | null {
  const mt = mtModelById(id);
  return mt ? mtDownload(mt) : qwenDownload(id);
}

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

function totalSize(d: { files: Array<{ size: number }> }): number {
  return d.files.reduce((n, f) => n + f.size, 0);
}

// Bytes already on disk: finished files plus any resumable .part.
function bytesOnDisk(d: Download): number {
  return d.files.reduce((n, f) => {
    const done = fileSize(join(d.dir, f.name));
    if (done === f.size) return n + done;
    return n + (d.zstd ? 0 : Math.min(fileSize(join(d.dir, `${f.name}.part`)), f.size));
  }, 0);
}

export type ModelState = "absent" | "downloading" | "ready" | "error" | "missing";

function managedState(d: Download): { state: ModelState; done: number; error?: string } {
  const job = jobs.get(d.id);
  let state: ModelState;
  if (job) state = "downloading";
  else if (d.ready()) state = "ready";
  else if (lastError.has(d.id)) state = "error";
  else state = "absent";
  return { state, done: job ? job.done : bytesOnDisk(d), error: lastError.get(d.id) };
}

function mtEntry(m: MtModel) {
  const d = mtDownload(m);
  return { id: d.id, from: m.from, to: m.to, size: totalSize(d), dir: d.dir, managed: true, ...managedState(d) };
}

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
      return { ...base, managed: true, ...managedState(qwenDownload(m.id)!) };
    }),
    // Only those on disk or downloading; the rest come via /api/mt-route.
    mt: MT_MODELS.map(mtEntry).filter((e) => e.state !== "absent" || e.done > 0),
  };
}

export function mtRouteModels(from: string, to: string) {
  return mtRoute(from, to)?.map(mtEntry) ?? null;
}

// Kick off a download in the background. Returns an error message when it
// can't start; progress and failures are reported through listModels().
export function startDownload(id: string): string | null {
  const d = findDownload(id);
  if (!d) {
    const q = qwenModel(id);
    return q?.envDir ? `${q.envName} is set; that model dir is managed outside livesub` : `unknown model ${JSON.stringify(id)}`;
  }
  if (jobs.has(id)) return null;
  if (d.ready()) return null;

  try {
    mkdirSync(d.dir, { recursive: true });
  } catch (e) {
    return `cannot create ${d.dir}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const done = bytesOnDisk(d);
  const need = totalSize(d) - done;
  try {
    const fs = statfsSync(d.dir);
    const free = fs.bavail * fs.bsize;
    if (free < need + DISK_MARGIN_BYTES) {
      return `not enough disk space in ${d.dir}: need ${(need / 1e9).toFixed(1)} GB, ${(free / 1e9).toFixed(1)} GB free`;
    }
  } catch {
    /* statfs unsupported here — let the write fail instead */
  }

  const job: Job = { abort: new AbortController(), done };
  jobs.set(id, job);
  lastError.delete(id);
  log.info(`model download started: ${d.label} -> ${d.dir}`);
  void (async () => {
    try {
      for (const f of d.files) await downloadFile(d, f, job);
      log.info(`model download finished: ${d.id}`);
    } catch (e) {
      if (job.abort.signal.aborted) {
        log.info(`model download cancelled: ${d.id}`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        lastError.set(id, msg);
        log.error(`model download failed: ${d.id}: ${msg}`);
      }
    } finally {
      jobs.delete(id);
    }
  })();
  return null;
}

async function downloadFile(d: Download, f: DownloadFile, job: Job): Promise<void> {
  const dest = join(d.dir, f.name);
  if (fileSize(dest) === f.size) return;
  const part = `${dest}.part`;
  // A compressed file can't resume mid-stream: drop what's there.
  let start = d.zstd ? 0 : fileSize(part);
  if (start > f.size) {
    rmSync(part, { force: true });
    job.done -= f.size;
    start = 0;
  }

  let hash: Hash | null = null;
  if (start < f.size || d.zstd) {
    let res = await fetch(f.url, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      signal: job.abort.signal,
    });
    if (res.status === 404 && f.record) res = await fetchMovedAttachment(f, job.abort.signal);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${f.name}`);
    // 200 to a Range request means the server sent the whole file: start over.
    const append = start > 0 && res.status === 206;
    if (start > 0 && !append) {
      job.done -= start;
      start = 0;
    }
    if (f.sha256) hash = await hashPrefix(append ? part : null, job.abort.signal);
    const h = hash;
    const counted = job.done;
    try {
      await pipeline(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
        d.zstd ? createZstdDecompress() : new PassThrough(),
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
    } catch (e) {
      if (d.zstd) {
        job.done = counted;
        rmSync(part, { force: true });
      }
      throw e;
    }
  } else if (f.sha256) {
    hash = await hashPrefix(part, job.abort.signal);
  }

  const got = fileSize(part);
  if (got !== f.size) {
    if (d.zstd) rmSync(part, { force: true });
    throw new Error(`${f.name}: got ${got} bytes, expected ${f.size}`);
  }
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

// Attachment paths change when Mozilla republishes a record: look up the new
// one, valid only if the hash is unchanged.
async function fetchMovedAttachment(f: DownloadFile, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${MT_RECORDS_URL}/${f.record}`, { signal });
  if (!res.ok) throw new Error(`${f.name}: gone upstream (HTTP ${res.status}); a newer livesub may have it`);
  const rec = ((await res.json()) as { data: { decompressedHash: string; attachment: { location: string } } }).data;
  if (rec.decompressedHash !== f.sha256) throw new Error(`${f.name}: updated upstream; a newer livesub may have it`);
  log.info(`model file moved upstream: ${f.name} -> ${rec.attachment.location}`);
  return fetch(`${MT_ENDPOINT}/${rec.attachment.location}`, { signal });
}

// A sha256 primed with the bytes already in `part` (for a resumed download).
async function hashPrefix(part: string | null, signal: AbortSignal): Promise<Hash> {
  const hash = createHash("sha256");
  if (part) {
    for await (const chunk of createReadStream(part, { signal })) hash.update(chunk as Buffer);
  }
  return hash;
}

// Stop a running download; Qwen's .part files stay so the next start resumes.
export function cancelDownload(id: string): void {
  jobs.get(id)?.abort.abort();
}

export function deleteModel(id: string): string | null {
  const d = findDownload(id);
  if (!d) {
    const q = qwenModel(id);
    return q?.envDir ? `${q.envName} is set; that model dir is managed outside livesub` : `unknown model ${JSON.stringify(id)}`;
  }
  if (jobs.has(id)) return "download in progress; cancel it first";
  rmSync(d.dir, { recursive: true, force: true });
  lastError.delete(id);
  log.info(`model deleted: ${d.id}`);
  return null;
}
