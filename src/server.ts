// HTTP + WebSocket entry point — the TS port of the FastAPI routes, the /ws
// endpoint, and the __main__ startup guard in server.py. Uses node:http + ws
// directly (no framework), matching the project's "one server file" ethos.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { GoogleGenAI } from "@google/genai";

import {
  ALLOWED_HOSTS,
  DATA_DIR,
  DEFAULT_TARGET_LANG,
  GEMINI_API_KEY,
  HOST,
  PORT,
  QWEN_CHUNK_SEC_DEFAULT,
  QWEN_CHUNK_SEC_MAX,
  QWEN_CHUNK_SEC_MIN,
  STATIC_DIR,
  isLoopbackHost,
  listAsrBackends,
  listTranslateBackends,
  listHintsBackends,
  pickHintsBackend,
  qwenBinAvailable,
  qwenUnavailable,
} from "./config.js";
import { generateHints } from "./hints.js";
import { cancelDownload, deleteModel, listModels, mtRouteModels, startDownload } from "./models.js";
import { mtLangCode } from "./mt.js";
import { Pipeline } from "./pipeline.js";
import { log } from "./util.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

// Serve a file from STATIC_DIR. `rel` is the path relative to STATIC_DIR;
// normalized and confined to the directory to prevent traversal.
function serveStatic(res: ServerResponse, rel: string): void {
  const safeRel = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(STATIC_DIR, safeRel);
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  // readFileSync (not a stream) — assets are tiny so buffering is fine, and a
  // missing file / directory throws → 404 (no stream 'error' to crash on).
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
  res.end(buf);
}

function readBody(req: IncomingMessage, maxBytes = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------- /api/hints ----------

async function handleHints(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  // The search engine picked in the UI; absent → the server default.
  const requested = String(body.backend ?? "").trim();
  const backend = pickHintsBackend(requested || undefined);
  if (backend === null) {
    sendJson(res, requested ? 400 : 500, {
      error: requested
        ? `hints backend ${JSON.stringify(requested)} is not available (unknown, or its API key isn't set)`
        : "Hint generation requires GEMINI_API_KEY, ANTHROPIC_API_KEY or DEEPSEEK_API_KEY. Set one in .env and restart, " +
          "or fill Scene/Glossary manually below.",
    });
    return;
  }
  const description = String(body.description ?? "").trim();
  if (!description) {
    sendJson(res, 400, { error: "description required" });
    return;
  }
  if (description.length > 500) {
    sendJson(res, 400, { error: "description too long (>500 chars)" });
    return;
  }
  const sourceLang = String(body.source_lang ?? "").trim();

  log.info(`generating hints via ${backend.id} (${backend.model}) for scene: ${JSON.stringify(description.slice(0, 100))} (source_lang=${JSON.stringify(sourceLang || "auto")})`);
  try {
    const result = await generateHints(backend, description, sourceLang);
    log.info(
      `hints generated via ${backend.id}: scene=${result.scene.length}ch glossary=${result.glossary.length}ch ` +
        `${result.searchesUsed} web searches stop=${result.stopReason}`,
    );
    sendJson(res, 200, {
      scene: result.scene,
      glossary: result.glossary,
      searches_used: result.searchesUsed,
      model: result.model,
      backend: backend.id,
      label: backend.label,
    });
  } catch (e) {
    log.exception(`hint generation via ${backend.id} failed`, e);
    sendJson(res, 502, { error: e instanceof Error ? e.message : String(e), backend: backend.id });
  }
}

// ---------- /api/models ----------

// POST /api/models/:id/download|cancel, DELETE /api/models/:id. POSTs must
// carry a JSON content type: that forces a CORS preflight, so another site
// open in the browser can't start a multi-GB download on this server.
function handleModel(req: IncomingMessage, res: ServerResponse, id: string, action: string | undefined): void {
  let err: string | null;
  if (req.method === "DELETE" && !action) {
    err = deleteModel(id);
  } else if (req.method === "POST" && action) {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
      sendJson(res, 415, { error: "expected application/json" });
      return;
    }
    if (action === "download") err = startDownload(id);
    else {
      cancelDownload(id);
      err = null;
    }
  } else {
    res.writeHead(405).end("method not allowed");
    return;
  }
  if (err) sendJson(res, 400, { error: err });
  else sendJson(res, 200, listModels());
}

// ---------- /api/mt-route ----------

// The models local translation needs for a pair of UI language names. null
// fields: no model covers it; models [] for the same language or auto.
function mtRouteInfo(sourceName: string, targetName: string) {
  const target = mtLangCode(targetName);
  const auto = !sourceName || sourceName.toLowerCase() === "auto";
  const source = auto ? "auto" : mtLangCode(sourceName);
  const models = target && source && source !== "auto" ? mtRouteModels(source, target) : auto && target ? [] : null;
  return { source, target, models };
}

// ---------- request guards ----------

// Any page in the browser can send requests here: WebSockets skip CORS, and
// DNS rebinding makes a page same-origin. So an Origin must be this server,
// and on loopback so must the Host (on the LAN the names aren't known).
// ALLOWED_HOSTS adds names, e.g. a reverse proxy's.

function hostnameOf(hostHeader: string): string {
  return hostHeader.toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
}

function hostAllowed(req: IncomingMessage): boolean {
  if (!isLoopbackHost(HOST)) return true;
  const h = hostnameOf(req.headers.host ?? "");
  return isLoopbackHost(h) || ALLOWED_HOSTS.has(h);
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;  // not a browser (scripts, curl)
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;  // "null" from file:// and sandboxed frames
  }
  return u.host === req.headers.host || ALLOWED_HOSTS.has(u.hostname.toLowerCase());
}

// ---------- HTTP request router ----------

const httpServer = createServer((req, res) => {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // Cross-site GETs can't read the response; anything else must be same-origin.
  const safe = req.method === "GET" || req.method === "HEAD";
  if (!hostAllowed(req) || (!safe && !originAllowed(req))) {
    log.warning(`refused ${req.method} ${path} (host ${req.headers.host}, origin ${req.headers.origin})`);
    res.writeHead(403).end("forbidden");
    return;
  }

  if (req.method === "GET" && path === "/") {
    serveStatic(res, "index.html");
    return;
  }
  if (req.method === "GET" && path === "/api/backends") {
    sendJson(res, 200, {
      asr: listAsrBackends(),
      translate: listTranslateBackends(),
      // Search engines /api/hints can use (API key set); the default first
      // pick is hints_default. Empty → the UI hides the Research row.
      hints: listHintsBackends().map((b) => ({ id: b.id, label: b.label })),
      hints_default: pickHintsBackend()?.id ?? null,
    });
    return;
  }
  if (req.method === "GET" && path === "/api/models") {
    sendJson(res, 200, listModels());
    return;
  }
  if (req.method === "GET" && path === "/api/mt-route") {
    const q = new URL(url, "http://x").searchParams;
    sendJson(res, 200, mtRouteInfo(q.get("source") ?? "", q.get("target") ?? ""));
    return;
  }
  const modelRoute = /^\/api\/models\/([\w-]+)(?:\/(download|cancel))?$/.exec(path);
  if (modelRoute) {
    handleModel(req, res, modelRoute[1], modelRoute[2]);
    return;
  }
  if (req.method === "POST" && path === "/api/hints") {
    handleHints(req, res).catch((e) => {
      log.exception("hints handler error", e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
    return;
  }
  if (req.method === "GET" && path.startsWith("/static/")) {
    serveStatic(res, path.slice("/static/".length));
    return;
  }
  res.writeHead(404).end("not found");
});

// ---------- /ws websocket endpoint ----------

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  verifyClient: ({ req }: { req: IncomingMessage }) => {
    const ok = hostAllowed(req) && originAllowed(req);
    if (!ok) log.warning(`refused /ws (host ${req.headers.host}, origin ${req.headers.origin})`);
    return ok;
  },
});

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

wss.on("connection", (ws: WebSocket) => {
  log.info("client connected");
  let pipeline: Pipeline | null = null;
  let firstSeen = false;
  // Binary frames that arrive in the same synchronous parse batch as config
  // (app.js starts streaming audio immediately, not gated on `ready`) — buffered
  // so none are dropped in the window before the pipeline exists.
  const preConfigAudio: Buffer[] = [];

  // Attach an error handler up front. During the config handshake an unhandled
  // 'error' (e.g. a malformed frame) would otherwise take down the whole
  // process rather than just this session.
  ws.on("error", (e) => {
    log.warning(`client ws error: ${e instanceof Error ? e.message : String(e)}`);
    pipeline?.onClose();
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (pipeline) {
      if (isBinary) pipeline.onAudio(toBuffer(data));
      // Text frames after config are ignored (client_pump only reads bytes).
      return;
    }
    if (!firstSeen) {
      firstSeen = true;
      if (isBinary) {
        ws.close(1003, "expected config message first");
        return;
      }
      // startSession is synchronous, so `pipeline` is set before the next queued
      // 'message' fires — no handshake race.
      pipeline = startSession(ws, toBuffer(data), preConfigAudio);
      return;
    }
    // Config attempt made but pipeline not yet running (rare): buffer audio.
    if (isBinary) preConfigAudio.push(toBuffer(data));
  });

  ws.on("close", () => pipeline?.onClose());
});

// Parse + validate the config frame, construct the pipeline, flush any buffered
// pre-config audio, and drive it. Synchronous up to the fire-and-forget run();
// returns the pipeline (or null when the handshake was rejected).
function startSession(ws: WebSocket, firstData: Buffer, preConfigAudio: Buffer[]): Pipeline | null {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(firstData.toString("utf-8"));
  } catch {
    ws.close(1003, "expected config message first");
    return null;
  }
  if (typeof cfg !== "object" || cfg === null || cfg.type !== "config") {
    ws.close(1003, "first message must be {type:'config'}");
    return null;
  }

  const targetLang = String(cfg.target_lang ?? "").trim() || DEFAULT_TARGET_LANG;
  const sourceLang = String(cfg.source_lang ?? "auto").trim();
  const scene = String(cfg.scene ?? "").trim();
  const glossary = String(cfg.glossary ?? "").trim();

  // Validate backend choices against the live availability list; fall back to
  // the first available (or fail closed for ASR when nothing is configured).
  // A listed-but-not-downloaded model is refused outright rather than swapped
  // for another backend behind the user's back.
  let asrBackend = String(cfg.asr_backend ?? "").trim().toLowerCase();
  const asrList = listAsrBackends();
  if (asrList.some((b) => b.id === asrBackend && !b.ready)) {
    ws.close(1003, `${asrBackend} model is not downloaded yet`);
    return null;
  }
  const asrAvailable = new Set(asrList.filter((b) => b.ready).map((b) => b.id));
  if (!asrAvailable.has(asrBackend)) asrBackend = asrAvailable.values().next().value ?? "";
  if (!asrBackend) {
    ws.close(1003, "no ASR backend available — set at least one API key or local binary");
    return null;
  }
  let translateBackend = String(cfg.translate_backend ?? "").trim().toLowerCase();
  const trAvailable = new Set(listTranslateBackends().map((b) => b.id));
  // `none` is always present, so this fallback always lands somewhere.
  if (!trAvailable.has(translateBackend)) translateBackend = trAvailable.values().next().value ?? "none";
  // Refused like a missing ASR model; an auto source is checked per sentence.
  if (translateBackend === "local") {
    const route = mtRouteInfo(sourceLang, targetLang);
    let refusal = "";
    if (!route.target) refusal = `local translation has no model for target language ${JSON.stringify(targetLang.slice(0, 40))}`;
    else if (!route.source) refusal = `local translation has no model for source language ${JSON.stringify(sourceLang.slice(0, 40))}`;
    else if (!route.models) refusal = `local translation can't translate ${route.source} to ${route.target}`;
    else if (route.models.some((m) => m.state !== "ready")) refusal = "local translation models are not downloaded yet";
    if (refusal) {
      ws.close(1003, refusal);
      return null;
    }
  }

  log.info(`config: asr=${asrBackend} tr=${translateBackend} src=${JSON.stringify(sourceLang)} dst=${JSON.stringify(targetLang)} scene=${scene.length}ch gloss=${glossary.length}ch`);

  // Only construct the Gemini client when a chosen backend needs it.
  let gemini: GoogleGenAI | null = null;
  if ((asrBackend === "gemini" || translateBackend === "gemini") && GEMINI_API_KEY) {
    gemini = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
  }

  const chunk = Number(cfg.qwen_chunk_sec);
  const qwenChunkSec = Number.isFinite(chunk) && chunk >= QWEN_CHUNK_SEC_MIN && chunk <= QWEN_CHUNK_SEC_MAX ? chunk : QWEN_CHUNK_SEC_DEFAULT;

  const pipeline = new Pipeline({ clientWs: ws, gemini, targetLang, sourceLang, scene, glossary, asrBackend, translateBackend, qwenChunkSec });

  // Flush any audio that arrived before the pipeline existed, then run.
  for (const buf of preConfigAudio) pipeline.onAudio(buf);
  preConfigAudio.length = 0;

  void pipeline
    .run()
    .catch((e) => {
      log.exception("pipeline error", e);
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message: "pipeline error" }));
      } catch {
        /* ignore */
      }
    })
    // Pipeline ended (client gone, ASR done, or crash): close the socket so the
    // client stops streaming into a dead session.
    .finally(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });

  return pipeline;
}

// ---------- startup ----------

// Keep running with no ASR backend: a local model can still be downloaded from
// Settings, which makes one available without a restart.
const asrAvail = listAsrBackends().filter((b) => b.ready);
if (asrAvail.length === 0) {
  log.warning(
    qwenBinAvailable()
      ? "no ASR backend available yet — download a local model in Settings → Backends, " +
          "or set one of DASHSCOPE_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY"
      : "no ASR backend available — set one of DASHSCOPE_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, " +
          "or build qwen-asr and set QWEN_ASR_BIN, then restart",
  );
} else {
  log.info(`ASR backends available: ${asrAvail.map((b) => b.id).join(", ")}`);
}
log.info(`data dir: ${DATA_DIR}`);
const qwenMissing = qwenUnavailable();
if (qwenMissing) log.info(`local qwen-asr unavailable: ${qwenMissing.reason}`);

// ws re-emits listen errors (port taken, bad host); report them in one line.
wss.on("error", (e: NodeJS.ErrnoException) => {
  log.error(
    e.code === "EADDRINUSE"
      ? `port ${PORT} is already in use: stop the other server or pick a port with --port / LIVESUB_PORT`
      : `cannot listen on ${HOST}:${PORT}: ${e.message}`,
  );
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  // The real port (PORT 0 picks one); a wildcard host is opened as localhost.
  const { port } = httpServer.address() as AddressInfo;
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST;
  log.info(`livesub listening on http://${shown}:${port}`);
  if (!isLoopbackHost(HOST)) {
    log.warning(`listening on ${HOST}: anyone who can reach port ${port} can use this server and its API keys`);
  }
});
