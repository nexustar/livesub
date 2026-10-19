// The per-session pipeline — a faithful port of the Pipeline dataclass in
// server.py. Same data flow:
//
//   onAudio ── audioQueue ──► asrWorker ── sentenceQueue ──► translatorWorker
//                                │                               │
//                                └── transcript / translation events ──► client WS
//
// plus idleFlushLoop (0.5s tick). The landmines called out in AGENTS.md are
// preserved verbatim: the leading-space lstrip in onTranscriptChunk, `cut <= 0`
// in the length fallback, the qwen `--skip-silence` / `--past-text yes` flags
// (and no --repeat-penalty), the silent->speech pre-buffer replay, the Gemini
// transcribe-live VAD-off + positional interim consumption, the 6-char
// hold-back in PairedStreamParser (in prompts.ts), and the atomic-swap `ok`
// flag on translation_done.

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
import { statSync } from "node:fs";
import type { Writable } from "node:stream";
import { WebSocket } from "ws";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI, Modality, ThinkingLevel, type LiveServerMessage, type Session } from "@google/genai";

import {
  AUDIO_GATE_PEAK,
  AUDIO_PREBUFFER_CHUNKS,
  ASR_MODEL,
  DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL,
  DASHSCOPE_REALTIME_MODEL,
  DASHSCOPE_VAD_THRESHOLD,
  GEMINI_INTERIM_FLUSH_SEC,
  GEMINI_INTERIM_HOLDBACK_CHARS,
  HISTORY_PAIRS,
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL,
  PARTIAL_HARD_FLOOR_SEC,
  PARTIAL_MIN_NEW_BYTES,
  QWEN_BIN,
  SENTENCE_IDLE_FLUSH_SEC,
  SENTENCE_MAX_CHARS,
  SOFT_CUT_THRESHOLD,
  SOURCE_LANG_ISO,
  TRANSLATE_MODEL,
  VOXTRAL_BIN,
  VOXTRAL_INTERVAL_SEC,
  VOXTRAL_MODEL_DIR,
  anthropicThinkingOff,
  getTranslateBackend,
  qwenModel,
  qwenModelDir,
  qwenModelReady,
  resolveBin,
  resolveRel,
  which,
} from "./config.js";
import {
  PairedStreamParser,
  buildPairedTranslationSystemInstruction,
  buildTranslationPrompt,
  buildTranslationSystemInstruction,
  extractRetryDelay,
  findLastPunct,
} from "./prompts.js";
import { acquireEngine, detectLang, mtLangCode, mtModelReady, mtRoute, polishOutput, releaseEngine, routeKey, type MtEngine } from "./mt.js";
import type { MtModel } from "./mt-models.js";
import { AbortError, AsyncQueue, chunkPeak, log, monotonic, sleep } from "./util.js";

// ---------- small process/stream helpers ----------

// Sentinel for the Gemini recv loop's flush-tick race (see runOneAsrSession).
const RECV_TICK = Symbol("recv-tick");

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Path.exists() — true for a file OR directory (matches the Python checks).
function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// Promise-wrapped ws.send that resolves once the frame is flushed to the socket
// (or rejects on send error). Awaiting it gives real backpressure — the audio
// input queue backs up when the upstream is slow, so queue_lag reflects reality
// instead of always reading 0.
function wsSendAsync(ws: WebSocket, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(data, (err) => (err ? reject(err) : resolve()));
  });
}

// 500ms windowed peak for the UI level meter. Emits at most once per ~12 chunks
// (~500ms): the loudest peak in the window plus a chunks/sec estimate.
class AudioMeter {
  private windowPeak = 0;
  private windowCount = 0;
  add(peak: number): { peak: number; chunksPerSec: number } | null {
    if (peak > this.windowPeak) this.windowPeak = peak;
    this.windowCount += 1;
    if (this.windowCount >= 12) {
      const out = { peak: this.windowPeak, chunksPerSec: Math.trunc(this.windowCount / 0.5) };
      this.windowPeak = 0;
      this.windowCount = 0;
      return out;
    }
    return null;
  }
}

// The user-message body shared by the Claude and OpenAI translate paths.
function partialOrPlainUser(text: string, isPartial: boolean): string {
  return isPartial
    ? `PARTIAL utterance — speaker is still mid-sentence, more text will arrive. Translate what is given so far:\n${text}`
    : `Translate: ${text}`;
}

// Await stdin backpressure (the analogue of `await proc.stdin.drain()`). Rejects
// on EPIPE/broken pipe, which callers catch and treat as "return".
async function drainStdin(s: Writable): Promise<void> {
  if (s.writableNeedDrain) await once(s, "drain");
}

// Wait for a child to exit, SIGKILL after `ms`.
function waitExit(proc: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, ms);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

// Resolve on 'open', reject on pre-open 'error'. maxPayload 2**24 like Python's
// websockets.connect(max_size=...); handshakeTimeout mirrors its default open
// timeout so a black-hole endpoint can't hang the ASR worker forever.
function connectWs(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, maxPayload: 1 << 24, handshakeTimeout: 10000 });
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onErr);
    };
    ws.on("open", onOpen);
    ws.on("error", onErr);
  });
}

type WsOut = Record<string, unknown>;
type Metrics = { firstChunkAt: number | null };
type PartialHandle = { done: boolean; ac: AbortController };

export interface PipelineOpts {
  clientWs: WebSocket;
  gemini: GoogleGenAI | null;
  targetLang: string;
  sourceLang: string;
  scene: string;
  glossary: string;
  asrBackend: string;
  translateBackend: string;
  // qwen-asr --stream-chunk-sec: lower = lower latency, more CPU.
  qwenChunkSec: number;
}

export class Pipeline {
  private readonly clientWs: WebSocket;
  private readonly gemini: GoogleGenAI | null;
  private readonly targetLang: string;
  private readonly sourceLang: string;
  private readonly scene: string;
  private readonly glossary: string;
  private readonly asrBackend: string;
  private readonly translateBackend: string;
  private readonly qwenChunkSec: number;

  private claude: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;

  private readonly audioQueue = new AsyncQueue<Buffer | null>();
  private readonly sentenceQueue = new AsyncQueue<[number, string, number] | null>();
  private history: Array<[string, string]> = [];
  private sentenceBuffer = "";
  // Last live line sent for onTranscriptUpdate, to skip no-op and empty-new-line sends.
  private liveSid = -1;
  private liveText = "";
  private lastChunkTime = 0;
  private nextSid = 0;
  // Final translations run concurrently. Their results enter history (the
  // context of later translations) in sentence order: finished results wait
  // in historyPending until every earlier sid has finished.
  private finalsInFlight = 0;
  private historyNextSid = 0;
  private readonly historyPending = new Map<number, [string, string] | null>();
  private readonly dispatchedAt = new Map<number, number>();
  private stopRequested = false;
  private statsChunks = 0;
  private statsBytes = 0;
  private currentSegStart = 0;
  private currentSegFirstChunk = 0;
  private asrStartedAt = 0;
  private chunksFedToAsr = 0;
  private globalRev = 0;
  private lastPartialTime = 0;
  private lastPartialBufLen = 0;
  private inFlightPartial: PartialHandle | null = null;
  private pairedPrevSid: number | null = null;
  private pairedPrevSrc = "";
  private pairedPrevDst = "";
  // Local translation; source null = detect per sentence.
  private readonly mtSource: string | null = null;
  private readonly mtTarget: string | null = null;
  private readonly mtEngines = new Map<string, MtEngine>();
  private readonly mtWarned = new Set<string>();

  constructor(opts: PipelineOpts) {
    this.clientWs = opts.clientWs;
    this.gemini = opts.gemini;
    this.targetLang = opts.targetLang;
    this.sourceLang = opts.sourceLang;
    this.scene = opts.scene;
    this.glossary = opts.glossary;
    this.asrBackend = opts.asrBackend;
    this.translateBackend = opts.translateBackend;
    this.qwenChunkSec = opts.qwenChunkSec;
    if (this.translateBackend === "local") {
      const src = this.sourceLang.trim().toLowerCase();
      this.mtSource = src && src !== "auto" ? mtLangCode(this.sourceLang) : null;
      this.mtTarget = mtLangCode(this.targetLang);
    }
  }

  // ----- audio ingest, wired to the client websocket in server.ts -----

  onAudio(chunk: Buffer): void {
    this.audioQueue.put(chunk);
  }

  // Client disconnected (mirrors client_pump's finally).
  onClose(): void {
    this.stopRequested = true;
    this.audioQueue.put(null);
  }

  async run(): Promise<void> {
    // Load the engine now, not on the first sentence (~1 s).
    if (this.mtSource && this.mtTarget) {
      const route = mtRoute(this.mtSource, this.mtTarget);
      if (route?.length) this.mtEngine(route);
    }
    await this.safeSendJson({ type: "ready" });
    const asr = this.asrWorker();
    const tr = this.translatorWorker();
    const idle = this.idleFlushLoop();
    try {
      await Promise.all([asr, tr]);
    } finally {
      this.stopRequested = true;
      await idle.catch(() => {});
      for (const e of this.mtEngines.values()) releaseEngine(e);
      this.mtEngines.clear();
    }
    log.info("session closed");
  }

  // Awaits the flush (wsSendAsync), not fire-and-forget: a slow client now
  // backpressures the pipeline instead of growing ws's internal send queue
  // without bound, and async send errors resolve into the catch below rather
  // than escaping as socket 'error' events.
  private async safeSendJson(obj: WsOut): Promise<void> {
    try {
      if (this.clientWs.readyState === WebSocket.OPEN) {
        await wsSendAsync(this.clientWs, JSON.stringify(obj));
      }
    } catch {
      /* client gone; ignore */
    }
  }

  private isStatsSample(): boolean {
    const n = this.statsChunks;
    return n === 1 || n === 25 || n === 100 || n % 250 === 0;
  }

  // ----- ASR dispatch -----

  private async asrWorker(): Promise<void> {
    try {
      if (this.asrBackend === "qwen-small" || this.asrBackend === "qwen-large") {
        await this.qwenAsrWorker();
      } else if (this.asrBackend === "voxtral") {
        await this.voxtralAsrWorker();
      } else if (this.asrBackend === "openai-realtime") {
        await this.openaiRealtimeAsrWorker();
      } else if (this.asrBackend === "qwen-cloud") {
        await this.dashscopeAsrWorker();
      } else {
        // Gemini transcribe-live: sessions cap at ~10 min; reopen on go_away,
        // a final, turn_complete, or error until the client hangs up.
        while (!this.stopRequested) {
          try {
            await this.runOneAsrSession();
          } catch (e) {
            log.exception("ASR session crashed; will reopen", e);
            await sleep(0.5);
          }
        }
      }
    } finally {
      await this.finalizePendingSentence();
      this.sentenceQueue.put(null);
      log.info(`ASR worker exiting (chunks=${this.statsChunks} bytes=${this.statsBytes})`);
    }
  }

  // ----- qwen-asr backend (local subprocess) -----

  private async qwenAsrWorker(): Promise<void> {
    const binPath = resolveBin(QWEN_BIN);
    if (!isFile(binPath)) {
      await this.safeSendJson({
        type: "error",
        message:
          `qwen_asr binary not found (looked for ${JSON.stringify(QWEN_BIN)}). ` +
          "Build from https://github.com/nexustar/qwen-asr and set QWEN_ASR_BIN env var.",
      });
      return;
    }
    const model = qwenModel(this.asrBackend);
    const modelDir = model ? qwenModelDir(model) : "";
    if (!model || !qwenModelReady(model)) {
      await this.safeSendJson({
        type: "error",
        message: model?.envDir
          ? `qwen-asr model dir not found (${model.envName}=${JSON.stringify(modelDir)}).`
          : `qwen-asr model for ${this.asrBackend} is not downloaded — download it in Settings → Backends.`,
      });
      return;
    }

    const qwenCmd: string[] = [
      binPath,
      "-d",
      modelDir,
      "--stdin",
      "--stream",
      "--stream-max-new-tokens",
      "32",
      // Drop long silent spans before inference (see TECH_DOC landmine).
      "--skip-silence",
      // Feed previously decoded text back as conditioning (patched fork).
      "--past-text",
      "yes",
    ];
    const src = (this.sourceLang || "").trim().toLowerCase();
    if (src && src !== "auto") qwenCmd.push("--language", this.sourceLang);
    // No glossary --prompt: Qwen3-ASR (0.6B and 1.7B) copies the term list
    // into the transcript, whole lists at a time. The glossary goes to the
    // translator instead.
    // Chunk size is the user's latency / CPU trade-off (Settings slider). Too
    // small for the machine and processing falls behind, so latency grows.
    qwenCmd.push("--stream-chunk-sec", String(this.qwenChunkSec));
    // Committed text and the provisional tail, one JSON object per line.
    qwenCmd.push("--stream-json");

    // qwen-asr block-buffers stdout when piped; wrap with stdbuf for line
    // buffering. Falls back to raw command if stdbuf missing.
    const cmd = which("stdbuf") !== null ? ["stdbuf", "-oL", ...qwenCmd] : qwenCmd;
    log.info(`starting qwen-asr: ${cmd.join(" ")}`);
    await this.safeSendJson({ type: "asr_session", state: "open" });

    await this.runSubprocessAsr(cmd, "qwen", true);
    return;
  }

  // ----- voxtral.c backend (local subprocess) -----

  private async voxtralAsrWorker(): Promise<void> {
    const binPath = resolveBin(VOXTRAL_BIN);
    if (!isFile(binPath)) {
      await this.safeSendJson({
        type: "error",
        message:
          `voxtral binary not found (looked for ${JSON.stringify(VOXTRAL_BIN)}). ` +
          "Build from https://github.com/antirez/voxtral.c and set VOXTRAL_BIN env var.",
      });
      return;
    }
    const modelDir = resolveRel(VOXTRAL_MODEL_DIR);
    if (!pathExists(modelDir)) {
      await this.safeSendJson({
        type: "error",
        message:
          `voxtral model dir not found at ${JSON.stringify(modelDir)}. ` +
          "Run ./download_model.sh in the voxtral.c repo and set VOXTRAL_MODEL_DIR env var.",
      });
      return;
    }

    const voxCmd = [binPath, "-d", modelDir, "--stdin", "-I", `${VOXTRAL_INTERVAL_SEC}`, "--silent"];
    const cmd = which("stdbuf") !== null ? ["stdbuf", "-oL", ...voxCmd] : voxCmd;
    log.info(`starting voxtral: ${cmd.join(" ")}`);
    await this.safeSendJson({ type: "asr_session", state: "open" });

    await this.runSubprocessAsr(cmd, "voxtral");
  }

  // Shared feed/receive loop for the local subprocess backends (qwen + voxtral):
  // audio gate, silent->speech pre-buffer replay, 500ms windowed peak for the UI
  // meter, and UTF-8 incremental decode of stdout tokens are identical.
  private async runSubprocessAsr(cmd: string[], label: string, jsonUpdates = false): Promise<void> {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", jsonUpdates ? "pipe" : "ignore"] });
    } catch (e) {
      await this.safeSendJson({ type: "error", message: `failed to spawn ${label}: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const stdin = proc.stdin as Writable;
    stdin.on("error", () => {}); // swallow EPIPE; feed checks writability

    // With --stream-json, qwen-asr logs its resets, loop recoveries,
    // language changes and decode backlog to stderr, one line each.
    if (proc.stderr) {
      const errDecoder = new StringDecoder("utf8");
      let errPending = "";
      proc.stderr.on("data", (buf: Buffer) => {
        errPending += errDecoder.write(buf);
        for (let nl = errPending.indexOf("\n"); nl >= 0; nl = errPending.indexOf("\n")) {
          const line = errPending.slice(0, nl).trim();
          errPending = errPending.slice(nl + 1);
          if (line) log.info(`${label}: ${line}`);
        }
      });
    }

    if (this.asrStartedAt === 0) this.asrStartedAt = monotonic();

    const prebuffer: Buffer[] = [];
    let prevGated = true;
    const meter = new AudioMeter();
    const ac = new AbortController();

    const feed = async (): Promise<void> => {
      try {
        for (;;) {
          let chunk: Buffer | null;
          try {
            chunk = await this.audioQueue.get(ac.signal);
          } catch {
            return; // aborted at cleanup
          }
          if (chunk === null) break;
          this.statsChunks += 1;
          this.statsBytes += chunk.length;
          const peak = chunkPeak(chunk);
          const gated = peak < AUDIO_GATE_PEAK;
          prebuffer.push(chunk); // unsent chunks only — replayed at next onset
          if (prebuffer.length > AUDIO_PREBUFFER_CHUNKS) prebuffer.shift();
          if (!gated) this.chunksFedToAsr += 1;
          const stats = meter.add(peak);
          if (stats) await this.safeSendJson({ type: "audio_stats", peak: stats.peak, chunks_per_sec: stats.chunksPerSec });
          if (this.isStatsSample()) {
            const elapsed = monotonic() - this.asrStartedAt;
            const audioFed = this.chunksFedToAsr * 0.04;
            const rt = elapsed > 0 ? audioFed / elapsed : 0;
            const queueLag = this.audioQueue.qsize() * 0.04;
            log.info(
              `${label} perf chunks=${this.statsChunks} fed=${this.chunksFedToAsr} audio=${audioFed.toFixed(1)}s ` +
                `elapsed=${elapsed.toFixed(1)}s realtime=${rt.toFixed(2)}x queue_lag=${queueLag.toFixed(1)}s peak=${peak}`,
            );
          }
          if (gated) {
            prevGated = true;
            continue;
          }
          if (!stdin.writable) continue;
          // Speech onset: replay the pre-buffer so word-initial consonants
          // don't get clipped. The current chunk is at the end of the buffer.
          if (prevGated) {
            for (const buf of prebuffer) stdin.write(buf);
            try {
              await drainStdin(stdin);
            } catch {
              return;
            }
          } else {
            stdin.write(chunk);
            try {
              await drainStdin(stdin);
            } catch {
              return;
            }
          }
          // Everything buffered has now been sent. Without this, a gate that
          // reopens within AUDIO_PREBUFFER_CHUNKS replays audio the ASR already
          // heard and the words come out twice.
          prebuffer.length = 0;
          prevGated = false;
        }
      } finally {
        if (stdin.writable) {
          try {
            stdin.end();
          } catch {
            /* ignore */
          }
        }
      }
    };

    // stdout: incremental UTF-8 decode into a queue consumed by receive().
    const outQueue = new AsyncQueue<string | null>();
    const decoder = new StringDecoder("utf8");
    const stdout = proc.stdout!;
    stdout.on("data", (buf: Buffer) => {
      const text = decoder.write(buf);
      if (text) outQueue.put(text);
    });
    stdout.on("end", () => {
      const tail = decoder.end();
      if (tail) outQueue.put(tail);
      outQueue.put(null);
    });
    proc.on("close", () => outQueue.put(null));
    // spawn failures (ENOENT/EACCES/ENOEXEC) surface asynchronously here, NOT as
    // a throw from spawn(). Without this listener an unhandled 'error' would
    // take down the whole process (Python's asyncio only failed the session).
    proc.on("error", (e) => {
      log.exception(`${label}: subprocess error`, e);
      void this.safeSendJson({ type: "error", message: `${label} subprocess error: ${e instanceof Error ? e.message : String(e)}` });
      ac.abort();
      outQueue.put(null);
    });

    const receive = async (): Promise<void> => {
      let pending = "";
      for (;;) {
        const text = await outQueue.get();
        if (text === null) return;
        if (!jsonUpdates) {
          await this.onTranscriptText(text);
          continue;
        }
        // --stream-json: one {"commit","tail"} object per line.
        pending += text;
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line) continue;
          let upd: { commit?: unknown; tail?: unknown };
          try {
            upd = JSON.parse(line);
          } catch {
            log.warning(`${label}: non-JSON line: ${line.slice(0, 120)}`);
            continue;
          }
          // Skip objects that are not updates, so new kinds of lines can be added.
          if (!upd || typeof upd !== "object" || (!("commit" in upd) && !("tail" in upd))) continue;
          await this.onTranscriptUpdate(
            typeof upd.commit === "string" ? upd.commit : "",
            typeof upd.tail === "string" ? upd.tail : "",
          );
        }
      }
    };

    const feedP = feed().catch((e) => log.exception(`${label} feed error`, e));
    const recvP = receive().catch((e) => log.exception(`${label} recv error`, e));
    try {
      await Promise.race([feedP, recvP]);
    } finally {
      ac.abort();
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      await waitExit(proc, 2000);
      outQueue.put(null);
      await Promise.allSettled([feedP, recvP]);
    }
    log.info(`${label} subprocess exited (rc=${proc.exitCode})`);
  }

  // ----- OpenAI Realtime ASR backend (gpt-realtime-whisper) -----

  private async openaiRealtimeAsrWorker(): Promise<void> {
    if (!OPENAI_API_KEY) {
      await this.safeSendJson({ type: "error", message: "OPENAI_API_KEY env var not set." });
      return;
    }
    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };

    while (!this.stopRequested) {
      let wsErr: unknown = null;
      try {
        const ws = await connectWs(url, headers);
        const msgQueue = new AsyncQueue<string | null>();
        ws.on("message", (data) => msgQueue.put(data.toString()));
        ws.on("close", () => msgQueue.put(null));
        // An abnormal close surfaces here; record it so we back off before
        // reopening. A clean server close leaves wsErr null → immediate reopen,
        // matching Python (which only sleeps 0.5s on an exception).
        ws.on("error", (e) => {
          wsErr = e;
          msgQueue.put(null);
        });

        const src = (this.sourceLang || "").trim().toLowerCase();
        const transcriptionCfg: Record<string, unknown> = { model: OPENAI_REALTIME_MODEL };
        if (src && src !== "auto") transcriptionCfg.language = SOURCE_LANG_ISO[src] ?? src;
        // gpt-realtime-whisper streams deltas continuously (no turn_detection);
        // our own punctuation/length cutting handles segmentation.
        ws.send(
          JSON.stringify({
            type: "session.update",
            session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: transcriptionCfg } } },
          }),
        );
        log.info(`openai-realtime: connected, model=${OPENAI_REALTIME_MODEL} lang=${transcriptionCfg.language ?? "auto"}`);
        await this.safeSendJson({ type: "asr_session", state: "open" });
        if (this.asrStartedAt === 0) this.asrStartedAt = monotonic();

        const ac = new AbortController();
        const meter = new AudioMeter();

        const feed = async (): Promise<void> => {
          for (;;) {
            let chunk: Buffer | null;
            try {
              chunk = await this.audioQueue.get(ac.signal);
            } catch {
              return;
            }
            if (chunk === null) {
              try {
                ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              } catch {
                /* ignore */
              }
              return;
            }
            this.statsChunks += 1;
            this.statsBytes += chunk.length;
            this.chunksFedToAsr += 1; // no audio gate; server VAD handles it
            const peak = chunkPeak(chunk);
            const stats = meter.add(peak);
            if (stats) await this.safeSendJson({ type: "audio_stats", peak: stats.peak, chunks_per_sec: stats.chunksPerSec });
            if (this.isStatsSample()) this.perfLogCloud("openai-realtime");
            // Browser worklet emits 24kHz for this backend — no resample. Awaited
            // for backpressure (see wsSendAsync).
            await wsSendAsync(ws, JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
          }
        };

        const recv = async (): Promise<void> => {
          for (;;) {
            const raw = await msgQueue.get();
            if (raw === null) return;
            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(raw);
            } catch {
              log.warning(`openai-realtime: non-JSON frame: ${raw.slice(0, 120)}`);
              continue;
            }
            const t = (evt.type as string) ?? "";
            if (t === "conversation.item.input_audio_transcription.delta") {
              const delta = (evt.delta as string) ?? "";
              if (delta) await this.onTranscriptText(delta);
            } else if (t === "conversation.item.input_audio_transcription.completed") {
              // Server VAD says this turn ended; flush as a clean boundary.
              await this.finalizePendingSentence();
            } else if (t === "input_audio_buffer.speech_stopped") {
              // informational
            } else if (t === "error") {
              const err = (evt.error as Record<string, unknown>) ?? {};
              log.error(`openai-realtime error: ${err.type} — ${err.message}`);
              await this.safeSendJson({ type: "error", message: `OpenAI Realtime: ${err.message ?? JSON.stringify(err)}` });
            }
          }
        };

        const raceErr = await this.runCloudSession(feed, recv, ac, ws, msgQueue);
        if (this.stopRequested) return;
        const err = raceErr ?? wsErr;
        if (err) {
          log.exception("openai-realtime: session error; will reopen", err);
          await sleep(0.5);
        }
      } catch (e) {
        if (this.stopRequested) return;
        log.exception("openai-realtime: session crashed; will reopen", e);
        await sleep(0.5);
      }
    }
  }

  // ----- DashScope Qwen3-ASR-Flash-Realtime backend (cloud Qwen ASR) -----

  private async dashscopeAsrWorker(): Promise<void> {
    if (!DASHSCOPE_API_KEY) {
      await this.safeSendJson({ type: "error", message: "DASHSCOPE_API_KEY env var not set." });
      return;
    }
    const url = `${DASHSCOPE_BASE_URL}?model=${DASHSCOPE_REALTIME_MODEL}`;
    const headers = { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, "OpenAI-Beta": "realtime=v1" };

    while (!this.stopRequested) {
      let wsErr: unknown = null;
      try {
        const ws = await connectWs(url, headers);
        const msgQueue = new AsyncQueue<string | null>();
        ws.on("message", (data) => msgQueue.put(data.toString()));
        ws.on("close", () => msgQueue.put(null));
        // Abnormal close → back off before reopening; clean close → immediate.
        ws.on("error", (e) => {
          wsErr = e;
          msgQueue.put(null);
        });

        const src = (this.sourceLang || "").trim().toLowerCase();
        const sessionCfg: Record<string, unknown> = {
          modalities: ["text"],
          input_audio_format: "pcm",
          sample_rate: 16000,
          turn_detection: { type: "server_vad", threshold: DASHSCOPE_VAD_THRESHOLD, silence_duration_ms: 600 },
        };
        if (src && src !== "auto") sessionCfg.input_audio_transcription = { language: SOURCE_LANG_ISO[src] ?? src };
        ws.send(JSON.stringify({ type: "session.update", session: sessionCfg }));
        const lang = (sessionCfg.input_audio_transcription as { language?: string } | undefined)?.language ?? "auto";
        log.info(`dashscope: connected, model=${DASHSCOPE_REALTIME_MODEL} lang=${lang}`);
        await this.safeSendJson({ type: "asr_session", state: "open" });
        if (this.asrStartedAt === 0) this.asrStartedAt = monotonic();

        const ac = new AbortController();
        const meter = new AudioMeter();

        const feed = async (): Promise<void> => {
          for (;;) {
            let chunk: Buffer | null;
            try {
              chunk = await this.audioQueue.get(ac.signal);
            } catch {
              return;
            }
            if (chunk === null) {
              try {
                ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              } catch {
                /* ignore */
              }
              return;
            }
            this.statsChunks += 1;
            this.statsBytes += chunk.length;
            this.chunksFedToAsr += 1;
            const peak = chunkPeak(chunk);
            const stats = meter.add(peak);
            if (stats) await this.safeSendJson({ type: "audio_stats", peak: stats.peak, chunks_per_sec: stats.chunksPerSec });
            if (this.isStatsSample()) this.perfLogCloud("dashscope");
            await wsSendAsync(ws, JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
          }
        };

        const recv = async (): Promise<void> => {
          // The turn's confirmed text already moved into sentenceBuffer.
          // Events carry the whole turn so far; only what follows this is new.
          let turnFed = "";
          for (;;) {
            const raw = await msgQueue.get();
            if (raw === null) return;
            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(raw);
            } catch {
              log.warning(`dashscope: non-JSON frame: ${raw.slice(0, 120)}`);
              continue;
            }
            const t = (evt.type as string) ?? "";
            if (t === "conversation.item.input_audio_transcription.text") {
              // `text` = confirmed cumulative prefix of the turn, `stash` =
              // provisional tail. Sentences are cut from the confirmed text as
              // it grows, so a long turn without a VAD pause is not one line;
              // the client shows the uncut rest plus the stash.
              const textConfirmed = (evt.text as string) ?? "";
              const stashPending = (evt.stash as string) ?? "";
              if (!textConfirmed && !stashPending) continue;
              if (this.currentSegFirstChunk === 0) this.currentSegFirstChunk = monotonic();
              if (textConfirmed.length > turnFed.length && textConfirmed.startsWith(turnFed)) {
                this.sentenceBuffer += textConfirmed.slice(turnFed.length);
                turnFed = textConfirmed;
                if (/^\s/u.test(this.sentenceBuffer)) this.sentenceBuffer = this.sentenceBuffer.replace(/^\s+/u, "");
                await this.cutSentence(true);
              }
              const live = (this.sentenceBuffer + stashPending).replace(/^\s+/u, "");
              await this.safeSendJson({ type: "transcript_replace", sid: this.nextSid, text: live });
              await this.maybeTriggerPartial();
            } else if (t === "conversation.item.input_audio_transcription.completed") {
              // VAD boundary + canonical transcript of the turn: dispatch what
              // has not been cut yet.
              const final = (evt.transcript as string) ?? "";
              const rest = final.startsWith(turnFed) ? final.slice(turnFed.length) : final.slice(Math.min(turnFed.length, final.length));
              const sentence = (this.sentenceBuffer + rest).trim();
              this.sentenceBuffer = "";
              this.lastChunkTime = 0;
              turnFed = "";
              if (sentence) {
                // Sync the client's visible src to the canonical final first.
                await this.safeSendJson({ type: "transcript_replace", sid: this.nextSid, text: sentence });
                await this.dispatchSentence(sentence);
              }
            } else if (t === "session.finished") {
              return;
            } else if (t === "error") {
              const err = (evt.error as Record<string, unknown>) ?? {};
              log.error(`dashscope error: ${err.type} — ${err.message}`);
              await this.safeSendJson({ type: "error", message: `DashScope: ${err.message ?? JSON.stringify(err)}` });
            }
          }
        };

        const raceErr = await this.runCloudSession(feed, recv, ac, ws, msgQueue);
        if (this.stopRequested) return;
        const err = raceErr ?? wsErr;
        if (err) {
          log.exception("dashscope: session error; will reopen", err);
          await sleep(0.5);
        }
      } catch (e) {
        if (this.stopRequested) return;
        log.exception("dashscope: session crashed; will reopen", e);
        await sleep(0.5);
      }
    }
  }

  private perfLogCloud(label: string): void {
    const elapsed = monotonic() - this.asrStartedAt;
    const audioFed = this.chunksFedToAsr * 0.04;
    const rt = elapsed > 0 ? audioFed / elapsed : 0;
    const queueLag = this.audioQueue.qsize() * 0.04;
    log.info(`${label} perf chunks=${this.statsChunks} audio=${audioFed.toFixed(1)}s elapsed=${elapsed.toFixed(1)}s realtime=${rt.toFixed(2)}x queue_lag=${queueLag.toFixed(1)}s`);
  }

  // Run a cloud feed/recv pair to first-completion, then tear down. Returns the
  // error that ended the race (or null on a clean completion) so the caller can
  // decide whether to back off before reopening.
  private async runCloudSession(
    feed: () => Promise<void>,
    recv: () => Promise<void>,
    ac: AbortController,
    ws: WebSocket,
    msgQueue: AsyncQueue<string | null>,
  ): Promise<unknown> {
    const feedP = feed();
    const recvP = recv();
    let raceErr: unknown = null;
    try {
      await Promise.race([feedP, recvP]);
    } catch (e) {
      raceErr = e;
    }
    ac.abort();
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    msgQueue.put(null);
    await Promise.allSettled([feedP, recvP]);
    return raceErr;
  }

  // ----- Gemini Live backend (gemini-3.5-transcribe-live) -----

  // Glossary -> customVocabulary terms for ASR token biasing. Glossary only —
  // scene stays out of the ASR path (same rule as qwen's --prompt).
  private buildGeminiVocabulary(): string[] {
    return this.glossary
      .split(/[,、;;\n]/u)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 64);
  }

  private async runOneAsrSession(): Promise<void> {
    if (!this.gemini) throw new Error("gemini client not configured");
    const msgQueue = new AsyncQueue<LiveServerMessage | null>();
    // Transcribe-live setup: automatic VAD DISABLED, one manual activity held
    // open all session — the server VAD detected 0.9s of a 50s announcement on
    // noisy audio; do not re-enable. No systemInstruction (pure ASR model) and
    // no sessionResumption (no conversational context; goAway reopens fresh).
    const transcriptionCfg: Record<string, unknown> = {};
    const src = this.sourceLang.trim().toLowerCase();
    if (src && src !== "auto") transcriptionCfg.languageCodes = [SOURCE_LANG_ISO[src] ?? src];
    const vocab = this.buildGeminiVocabulary();
    if (vocab.length) transcriptionCfg.customVocabulary = vocab;
    const session: Session = await this.gemini.live.connect({
      model: ASR_MODEL,
      callbacks: {
        onopen: () => {},
        onmessage: (m: LiveServerMessage) => msgQueue.put(m),
        onerror: (e) => {
          log.exception("gemini live: error", e);
          msgQueue.put(null);
        },
        onclose: () => msgQueue.put(null),
      },
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: transcriptionCfg,
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    });
    log.info(`ASR session opened (transcribe-live, langs=${JSON.stringify(transcriptionCfg.languageCodes ?? "auto")} vocab=${vocab.length})`);
    await this.safeSendJson({ type: "asr_session", state: "open" });
    session.sendRealtimeInput({ activityStart: {} });

    const ac = new AbortController();
    const meter = new AudioMeter();

    const feed = async (): Promise<void> => {
      if (this.asrStartedAt === 0) this.asrStartedAt = monotonic();
      for (;;) {
        let chunk: Buffer | null;
        try {
          chunk = await this.audioQueue.get(ac.signal);
        } catch {
          return;
        }
        if (chunk === null) return;
        this.statsChunks += 1;
        this.statsBytes += chunk.length;
        this.chunksFedToAsr += 1; // no audio gate on Gemini path
        const peak = chunkPeak(chunk);
        const stats = meter.add(peak);
        if (stats) await this.safeSendJson({ type: "audio_stats", peak: stats.peak, chunks_per_sec: stats.chunksPerSec });
        if (this.isStatsSample()) this.perfLogCloud("gemini");
        // sendRealtimeInput is synchronous in the JS SDK (no backpressure hook);
        // queue_lag stays ~0 for this backend by construction.
        session.sendRealtimeInput({ audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
      }
    };

    // interimInputTranscription is a growing FULL hypothesis (replace
    // semantics), NOT an append stream. Consume it positionally, holding back
    // the tail: the model rewrites its last ~15 chars in place, and forwarding
    // them eagerly duplicates/drops words. Captions can't retract — rewrites
    // deeper than the hold-back degrade to a few wrong chars.
    let interimConsumed = 0;
    let lastInterim = "";
    let lastInterimAt = 0;

    // Forward the held-back tail (idle hypothesis / session ending).
    const flushTail = async (): Promise<void> => {
      if (interimConsumed < lastInterim.length) {
        const delta = lastInterim.slice(interimConsumed);
        interimConsumed = lastInterim.length;
        await this.onTranscriptText(delta);
      }
    };

    const recv = async (): Promise<void> => {
      // Keep one queue read pending across timeout ticks — re-issuing get()
      // after a lost race would drop a message.
      let pending = msgQueue.get();
      for (;;) {
        const winner = await Promise.race([pending, sleep(0.5).then(() => RECV_TICK)]);
        if (winner === RECV_TICK) {
          if (lastInterimAt && monotonic() - lastInterimAt >= GEMINI_INTERIM_FLUSH_SEC) await flushTail();
          continue;
        }
        const resp = winner as LiveServerMessage | null;
        if (resp === null) {
          // Abrupt error/close: flush the held tail — the next session's fresh
          // hypothesis won't restate it.
          await flushTail();
          return;
        }
        pending = msgQueue.get();
        const goAway = resp.goAway;
        if (goAway) {
          log.info(`go_away time_left=${goAway.timeLeft}; will reopen`);
          await this.safeSendJson({ type: "asr_session", state: "go_away" });
          await flushTail();
          return;
        }
        const sc = resp.serverContent;
        if (!sc) continue;
        // The single held-open activity gets a final after about 220 s of
        // audio, and the session transcribes little after it (on a 30-min
        // broadcast 63% of the speech went missing). Its text restates the
        // interims: flush the tail and reopen; queued audio is kept.
        const fin = sc.inputTranscription?.text;
        if (fin) {
          log.info(`ASR final segment (${fin.length} chars); reopening session`);
          await this.safeSendJson({ type: "asr_session", state: "reset" });
          await flushTail();
          return;
        }
        const interim = sc.interimInputTranscription?.text;
        if (interim) {
          lastInterim = interim;
          lastInterimAt = monotonic();
          const target = interim.length - GEMINI_INTERIM_HOLDBACK_CHARS;
          if (target > interimConsumed) {
            const delta = interim.slice(interimConsumed, target);
            interimConsumed = target;
            await this.onTranscriptText(delta);
          }
        }
        if (sc.turnComplete) {
          log.info("ASR turn_complete (reopening session)");
          await this.safeSendJson({ type: "asr_session", state: "reset" });
          await flushTail();
          return;
        }
      }
    };

    const feedP = feed();
    const recvP = recv();
    let raceErr: unknown = null;
    try {
      await Promise.race([feedP, recvP]);
    } catch (e) {
      raceErr = e;
    }
    ac.abort();
    try {
      session.close();
    } catch {
      /* ignore */
    }
    msgQueue.put(null);
    await Promise.allSettled([feedP, recvP]);
    if (raceErr) throw raceErr;
  }

  // ----- transcript accumulation + sentence boundary detection -----

  // Entry point for ASR text of ANY size. Node pipes do not preserve the
  // subprocess's write boundaries — under load a single 'data' event can
  // deliver several KB at once. onTranscriptChunk() cuts at the LAST
  // punctuation in the buffer and dispatches once per call, so feeding a burst
  // whole would send a multi-sentence mega-segment to translation and
  // SENTENCE_MAX_CHARS could never engage. Slicing to <=256 chars per feed
  // (the Python server read 256 bytes per iteration) keeps boundaries local.
  private async onTranscriptText(text: string): Promise<void> {
    for (let i = 0; i < text.length; ) {
      let end = Math.min(i + 256, text.length);
      // Don't split a surrogate pair across slices: JSON-escaped lone
      // surrogates survive the client round-trip, but keep slices well-formed.
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end -= 1;
      }
      await this.onTranscriptChunk(text.slice(i, end));
      i = end;
    }
  }

  private async onTranscriptChunk(text: string): Promise<void> {
    const now = monotonic();
    await this.safeSendJson({ type: "transcript", sid: this.nextSid, text });
    if (this.currentSegFirstChunk === 0) this.currentSegFirstChunk = now;
    this.sentenceBuffer += text;
    // qwen-asr emits each token as " text" with a leading space. Without this
    // strip the length fallback's rfind(" ",0,MAX) matches index 0, dispatches
    // nothing, and the buffer grows forever (the 445-char infinite loop).
    if (this.sentenceBuffer.length > 0 && /^\s/u.test(this.sentenceBuffer)) {
      this.sentenceBuffer = this.sentenceBuffer.replace(/^\s+/u, "");
    }
    this.lastChunkTime = now;
    // No boundary yet: live partial translation (anthropic/openai backends).
    if (!(await this.cutSentence(false))) await this.maybeTriggerPartial();
  }

  // Committed text plus a provisional tail (qwen --stream-json). Sentence
  // boundaries are taken from committed text only: the tail routinely ends in
  // a period that the next chunk takes back. The client shows both, replaced
  // wholesale on every update.
  private async onTranscriptUpdate(commit: string, tail: string): Promise<void> {
    const now = monotonic();
    if ((commit || tail) && this.currentSegFirstChunk === 0) this.currentSegFirstChunk = now;
    if (commit) {
      this.sentenceBuffer += commit;
      // Same leading-space strip as onTranscriptChunk (see the note there).
      if (/^\s/u.test(this.sentenceBuffer)) this.sentenceBuffer = this.sentenceBuffer.replace(/^\s+/u, "");
      this.lastChunkTime = now;
      await this.cutSentence(true);
    }
    const live = (this.sentenceBuffer + tail).replace(/^\s+/u, "");
    const sid = this.nextSid;
    if (sid === this.liveSid ? live !== this.liveText : live !== "") {
      await this.safeSendJson({ type: "transcript_replace", sid, text: live });
      this.liveSid = sid;
      this.liveText = live;
    }
    // After a cut the rest of the buffer is a new sentence; translate it
    // now rather than at the next update, which is a chunk away.
    if (commit) await this.maybeTriggerPartial();
  }

  // Dispatch a sentence from sentenceBuffer if a boundary is present. Returns
  // true when the caller should not go on to partial translation. syncClient
  // first overwrites the client's line with exactly the dispatched text, for
  // callers whose client line also holds text that is not part of it.
  private async cutSentence(syncClient: boolean): Promise<boolean> {
    const dispatch = async (sentence: string): Promise<void> => {
      if (syncClient) await this.safeSendJson({ type: "transcript_replace", sid: this.nextSid, text: sentence });
      await this.dispatchSentence(sentence);
    };
    // 1) hard-punctuation cut — preferred boundary.
    let idx = findLastPunct(this.sentenceBuffer, false);
    if (idx >= 0) {
      const sentence = this.sentenceBuffer.slice(0, idx + 1).trim();
      if (sentence) {
        this.sentenceBuffer = this.sentenceBuffer.slice(idx + 1);
        await dispatch(sentence);
        return true;
      }
    }
    // 2) soft-punctuation cut once the buffer is long enough.
    if (this.sentenceBuffer.length >= SOFT_CUT_THRESHOLD) {
      idx = findLastPunct(this.sentenceBuffer, true);
      if (idx >= 0) {
        const sentence = this.sentenceBuffer.slice(0, idx + 1).trim();
        if (sentence) {
          this.sentenceBuffer = this.sentenceBuffer.slice(idx + 1);
          await dispatch(sentence);
          return true;
        }
      }
    }
    // 3) length fallback — hard cap buffer growth.
    if (this.sentenceBuffer.length >= SENTENCE_MAX_CHARS) {
      let cut = this.sentenceBuffer.lastIndexOf(" ", SENTENCE_MAX_CHARS - 1);
      // cut <= 0 (not just < 0): a lone space at position 0 would slice [:0]
      // and dispatch nothing, stalling. Cut at the cap instead.
      if (cut <= 0) cut = SENTENCE_MAX_CHARS;
      const sentence = this.sentenceBuffer.slice(0, cut).trim();
      this.sentenceBuffer = this.sentenceBuffer.slice(cut);
      if (sentence) await dispatch(sentence);
      return true;
    }
    return false;
  }

  private nextRev(): number {
    this.globalRev += 1;
    return this.globalRev;
  }

  private async maybeTriggerPartial(): Promise<void> {
    const backendCfg = getTranslateBackend(this.translateBackend);
    const sdk = backendCfg?.sdk;
    if (sdk !== "anthropic" && sdk !== "openai" && sdk !== "bergamot") return;
    const textNow = this.sentenceBuffer.trim();
    if (!textNow) return;
    const now = monotonic();
    // Hard floor bounds API call rate; below ~400ms is imperceptible anyway.
    if (now - this.lastPartialTime < PARTIAL_HARD_FLOOR_SEC) return;
    // vsync gate: drop the trigger if the previous partial is still in flight;
    // the next ASR event after completion picks it up.
    if (this.inFlightPartial && !this.inFlightPartial.done) return;
    // UTF-8 bytes (not code points) — ASCII 1B, CJK 3B; keeps a consistent
    // "fire on ~a phrase of new content" semantics across languages.
    const bufBytes = Buffer.byteLength(this.sentenceBuffer, "utf8");
    if (bufBytes - this.lastPartialBufLen < PARTIAL_MIN_NEW_BYTES) return;
    this.lastPartialTime = now;
    this.lastPartialBufLen = bufBytes;
    const sid = this.nextSid;
    const rev = this.nextRev();
    const snapshot = textNow;
    const historySnapshot = [...this.history];
    const ac = new AbortController();
    const handle: PartialHandle = { done: false, ac };
    this.inFlightPartial = handle;
    void this.runPartial(sid, rev, snapshot, historySnapshot, ac.signal).finally(() => {
      handle.done = true;
      // A trigger dropped while this was in flight would otherwise wait for
      // the next ASR update, which with local qwen is a whole chunk away.
      if (!this.stopRequested && !ac.signal.aborted && this.inFlightPartial === handle && this.nextSid === sid) {
        void this.maybeTriggerPartial();
      }
    });
  }

  private async runPartial(sid: number, rev: number, text: string, history: Array<[string, string]>, signal: AbortSignal): Promise<void> {
    try {
      await this.translateStreaming(sid, rev, text, history, true, false, signal);
    } catch (e) {
      if (signal.aborted || e instanceof AbortError) return;
      log.exception(`partial translation failed sid=${sid} rev=${rev}`, e);
    }
  }

  private async finalizePendingSentence(): Promise<void> {
    const rest = this.sentenceBuffer.trim();
    this.sentenceBuffer = "";
    this.lastChunkTime = 0;
    if (rest) await this.dispatchSentence(rest);
  }

  private async idleFlushLoop(): Promise<void> {
    while (!this.stopRequested) {
      await sleep(0.5);
      if (this.lastChunkTime === 0) continue;
      if (!this.sentenceBuffer.trim()) continue;
      const idle = monotonic() - this.lastChunkTime;
      if (idle >= SENTENCE_IDLE_FLUSH_SEC) {
        log.info(`idle flush: ${idle.toFixed(1)}s since last chunk, buffer=${JSON.stringify(this.sentenceBuffer.slice(0, 60))}`);
        await this.finalizePendingSentence();
      }
    }
  }

  private async dispatchSentence(sentence: string): Promise<void> {
    const now = monotonic();
    const sid = this.nextSid;
    this.nextSid += 1;
    const wall = this.currentSegStart ? now - this.currentSegStart : 0;
    const ttf = this.currentSegFirstChunk && this.currentSegStart ? this.currentSegFirstChunk - this.currentSegStart : 0;
    const asrSpan = this.currentSegFirstChunk ? now - this.currentSegFirstChunk : 0;
    const rateStr = wall >= 0.1 ? `${(sentence.length / wall).toFixed(1)}c/s` : "—";
    const preview = sentence.slice(0, 60) + (sentence.length > 60 ? "…" : "");
    log.info(
      `ASR seg sid=${sid} chars=${sentence.length} wall=${wall.toFixed(2)}s ttf=${ttf.toFixed(2)}s ` +
        `asr_span=${asrSpan.toFixed(2)}s rate=${rateStr} | ${JSON.stringify(preview)}`,
    );
    this.currentSegStart = now;
    this.currentSegFirstChunk = 0;
    // cancel any in-flight partial; the final translation supersedes it.
    if (this.inFlightPartial && !this.inFlightPartial.done) this.inFlightPartial.ac.abort();
    this.inFlightPartial = null;
    this.lastPartialTime = 0;
    this.lastPartialBufLen = 0;
    const rev = this.nextRev();
    await this.safeSendJson({ type: "transcript_done", sid });
    await this.safeSendJson({ type: "translation_start", sid });
    this.dispatchedAt.set(sid, now);
    this.sentenceQueue.put([sid, sentence, rev]);
  }

  // ----- translator worker -----

  private async translatorWorker(): Promise<void> {
    const running = new Set<Promise<void>>();
    try {
      for (;;) {
        const item = await this.sentenceQueue.get();
        if (item === null) return;
        const [sid, sentence, rev] = item;
        // Not queued behind the previous sentence: every final starts at once.
        const p = this.runFinal(sid, rev, sentence).finally(() => running.delete(p));
        running.add(p);
      }
    } finally {
      await Promise.allSettled([...running]);
      log.info("translator worker exiting");
    }
  }

  private async runFinal(sid: number, rev: number, sentence: string): Promise<void> {
    const dispatched = this.dispatchedAt.get(sid);
    const startAt = monotonic();
    this.finalsInFlight += 1;
    const concurrent = this.finalsInFlight;
    log.debug(
      `TR start sid=${sid} chars=${sentence.length} in_flight=${concurrent} ` +
        `wait=${dispatched !== undefined ? Math.trunc((startAt - dispatched) * 1000) : "—"}ms`,
    );
    let translated = "";
    try {
      translated = await this.translateFinal(sid, rev, sentence, concurrent > 1);
    } catch (e) {
      log.exception(`final translation failed for sid=${sid}`, e);
    } finally {
      this.finalsInFlight -= 1;
      const doneAt = monotonic();
      log.debug(
        `TR end sid=${sid} took=${Math.trunc((doneAt - startAt) * 1000)}ms ` +
          `since_dispatch=${dispatched !== undefined ? Math.trunc((doneAt - dispatched) * 1000) : "—"}ms in_flight=${this.finalsInFlight}`,
      );
      this.dispatchedAt.delete(sid);
      this.commitHistory(sid, translated ? [sentence, translated] : null);
    }
  }

  // Add a finished final to history in sentence order (see historyPending).
  private commitHistory(sid: number, pair: [string, string] | null): void {
    this.historyPending.set(sid, pair);
    while (this.historyPending.has(this.historyNextSid)) {
      const cur = this.historyPending.get(this.historyNextSid) ?? null;
      this.historyPending.delete(this.historyNextSid);
      if (cur) {
        this.history.push(cur);
        this.history = this.history.slice(-HISTORY_PAIRS);
        this.pairedPrevSid = this.historyNextSid;
        this.pairedPrevSrc = cur[0];
        this.pairedPrevDst = cur[1];
      }
      this.historyNextSid += 1;
    }
    if (this.historyPending.size > 0) {
      log.debug(`TR history waits for sid=${this.historyNextSid} (${this.historyPending.size} later done)`);
    }
  }

  private async translateFinal(sid: number, rev: number, sentence: string, concurrent: boolean): Promise<string> {
    // Passthrough: mirror the source as translation so the rest of the pipeline
    // (revision / translation / done events, promoteToPrev, history) is unchanged.
    if (this.translateBackend === "none") {
      await this.safeSendJson({ type: "translation_revision", sid, rev });
      await this.safeSendJson({ type: "translation", sid, rev, text: sentence });
      await this.safeSendJson({ type: "translation_done", sid, rev, final: true, ok: true });
      log.info(`TR none-passthrough sid=${sid} rev=${rev} chars=${sentence.length}`);
      return sentence;
    }

    // Paired translation — anthropic-SDK backends only, after at least one
    // prior turn, and not while another final is running: the sentence just
    // before this one may not be translated yet, so the pair would be stale.
    const backendCfg = getTranslateBackend(this.translateBackend);
    const usePaired =
      backendCfg?.sdk === "anthropic" && !concurrent && this.pairedPrevSid !== null && Boolean(this.pairedPrevDst);

    let translated = "";
    if (usePaired) {
      // The most-recent pair (which IS our prev) goes in the user message body
      // to be revised; pass the older context as history. Don't double-count.
      const olderHistory = this.history.slice(0, -1);
      const result = await this.translatePairedStreaming(sid, rev, sentence, olderHistory, this.pairedPrevSrc, this.pairedPrevDst);
      translated = result.curr;
      const prevRevised = result.prevRevised;
      if (prevRevised) {
        log.info(`  prev_revised sid=${this.pairedPrevSid}:\n    before: ${JSON.stringify(this.pairedPrevDst)}\n    after:  ${JSON.stringify(prevRevised)}`);
        // Update history's last entry so downstream context sees the fix.
        const last = this.history[this.history.length - 1];
        if (last && last[0] === this.pairedPrevSrc && last[1] === this.pairedPrevDst) {
          this.history[this.history.length - 1] = [this.pairedPrevSrc, prevRevised];
        }
        await this.safeSendJson({ type: "prev_revised", sid: this.pairedPrevSid, text: prevRevised });
      }
    } else {
      translated = await this.translateStreaming(sid, rev, sentence, [...this.history], false, true);
    }
    return translated;
  }

  private async translatePairedStreaming(
    sid: number,
    rev: number,
    text: string,
    history: Array<[string, string]>,
    prevSrc: string,
    prevDst: string,
  ): Promise<{ curr: string; prevRevised: string | null }> {
    await this.safeSendJson({ type: "translation_revision", sid, rev });
    let result: { curr: string; prevRevised: string | null } = { curr: "", prevRevised: null };
    let failed = false;
    const tStart = monotonic();
    const metrics: Metrics = { firstChunkAt: null };
    try {
      result = await this.translateOneClaudePaired(sid, rev, text, history, prevSrc, prevDst, metrics);
    } catch (e) {
      failed = true;
      log.exception(`paired translate sid=${sid} rev=${rev} failed`, e);
    } finally {
      const tDone = monotonic();
      const ttftMs = metrics.firstChunkAt !== null ? Math.trunc((metrics.firstChunkAt - tStart) * 1000) : null;
      const totalMs = Math.trunc((tDone - tStart) * 1000);
      log.info(
        `TR final-paired sid=${sid} rev=${rev} in_chars=${text.length} out_chars=${result.curr.length} ` +
          `decision=${result.prevRevised ? "revise" : "keep"} ttft=${ttftMs !== null ? `${ttftMs}ms` : "—"} total=${totalMs}ms${failed ? " FAILED" : ""}`,
      );
      if (failed && !result.curr) {
        const placeholder = "[translation failed — rate limit or network]";
        await this.safeSendJson({ type: "translation", sid, rev, text: placeholder });
        result.curr = placeholder;
      }
      await this.safeSendJson({ type: "translation_done", sid, rev, final: true, ok: !failed });
    }
    return result;
  }

  // Run one translation revision (partial or final). Emits translation_revision,
  // streams text chunks, then translation_done. On abort (partial superseded) it
  // still emits translation_done (ok=true) then rethrows, matching Python's
  // CancelledError-through-finally behaviour.
  private async translateStreaming(
    sid: number,
    rev: number,
    text: string,
    history: Array<[string, string]>,
    isPartial: boolean,
    isFinal: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.safeSendJson({ type: "translation_revision", sid, rev });
    let full = "";
    let failed = false;
    let aborted = false;
    const tStart = monotonic();
    const metrics: Metrics = { firstChunkAt: null };
    const backendCfg = getTranslateBackend(this.translateBackend);
    const sdk = backendCfg?.sdk ?? "gemini";
    try {
      if (sdk === "anthropic") full = await this.translateOneClaude(sid, rev, text, history, isPartial, metrics, signal);
      else if (sdk === "openai") full = await this.translateOneOpenai(sid, rev, text, history, isPartial, metrics, signal);
      else if (sdk === "bergamot") full = await this.translateOneLocal(sid, rev, text, metrics, signal);
      else full = await this.translateOneGemini(sid, rev, text, history, isPartial, metrics);
    } catch (e) {
      if (signal?.aborted || e instanceof AbortError) {
        aborted = true;
      } else {
        failed = true;
        log.exception(`translate sid=${sid} rev=${rev} failed`, e);
      }
    } finally {
      const tDone = monotonic();
      const ttftMs = metrics.firstChunkAt !== null ? Math.trunc((metrics.firstChunkAt - tStart) * 1000) : null;
      const totalMs = Math.trunc((tDone - tStart) * 1000);
      const kind = isPartial ? "partial" : "final";
      log.info(
        `TR ${kind} sid=${sid} rev=${rev} backend=${this.translateBackend} in_chars=${text.length} out_chars=${full.length} ` +
          `ttft=${ttftMs !== null ? `${ttftMs}ms` : "—"} total=${totalMs}ms${failed ? " FAILED" : ""}`,
      );
      if (isFinal && failed && !full) {
        const placeholder = "[translation failed — rate limit or network]";
        await this.safeSendJson({ type: "translation", sid, rev, text: placeholder });
        full = placeholder;
      }
      // ok=False signals the inner stream raised; the client uses it to avoid
      // clobbering good visible dst with an empty/half pendingDst.
      await this.safeSendJson({ type: "translation_done", sid, rev, final: isFinal, ok: !failed });
    }
    if (aborted) throw new AbortError();
    return full;
  }

  private async translateOneGemini(
    sid: number,
    rev: number,
    text: string,
    history: Array<[string, string]>,
    isPartial: boolean,
    metrics: Metrics,
  ): Promise<string> {
    if (!this.gemini) throw new Error("gemini client not configured");
    const prompt = buildTranslationPrompt(text, history, isPartial);
    const sys = buildTranslationSystemInstruction(this.targetLang, this.sourceLang, this.scene, this.glossary);
    // thinkingLevel, not thinkingBudget: gemini-3.5-flash-lite 400s on
    // thinkingBudget: 0.
    const config = { systemInstruction: sys, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }, temperature: 0.2 };

    let attempts = 0;
    const maxAttempts = 2;
    for (;;) {
      attempts += 1;
      const full: string[] = [];
      try {
        const stream = await this.gemini.models.generateContentStream({ model: TRANSLATE_MODEL, contents: prompt, config });
        for await (const chunk of stream) {
          const chunkText = chunk.text;
          if (chunkText) {
            if (metrics.firstChunkAt === null) metrics.firstChunkAt = monotonic();
            full.push(chunkText);
            await this.safeSendJson({ type: "translation", sid, rev, text: chunkText });
          }
        }
        return full.join("").trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const is429 = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
        if (is429 && attempts < maxAttempts) {
          const delay = extractRetryDelay(msg, 5.0);
          log.warning(`translate sid=${sid} hit rate limit, retrying in ${delay.toFixed(1)}s`);
          await sleep(delay);
          continue;
        }
        throw e;
      }
    }
  }

  // A sentence it can't translate (same language, no model) shows as is.
  private async translateOneLocal(sid: number, rev: number, text: string, metrics: Metrics, signal?: AbortSignal): Promise<string> {
    const to = this.mtTarget;
    if (!to) throw new Error(`no local translation model for target ${JSON.stringify(this.targetLang)}`);
    const from = this.mtSource ?? detectLang(text);
    const route = from ? mtRoute(from, to) : null;
    let out = text;
    if (route && route.length > 0 && route.every(mtModelReady)) {
      const engine = this.mtEngine(route);
      try {
        out = polishOutput(await engine.translate(text), to);
      } catch (e) {
        // A dead engine stays dead; the next sentence starts a new one.
        this.mtEngines.delete(engine.key);
        releaseEngine(engine);
        throw e;
      }
    } else if (route?.length !== 0) {
      const what = `${from ?? "unknown"}-${to}`;
      if (!this.mtWarned.has(what)) {
        this.mtWarned.add(what);
        log.warning(`local translation: no downloaded model for ${what}; showing the transcript`);
      }
    }
    if (signal?.aborted) throw new AbortError();
    metrics.firstChunkAt = monotonic();
    await this.safeSendJson({ type: "translation", sid, rev, text: out });
    return out;
  }

  private mtEngine(route: MtModel[]): MtEngine {
    const key = routeKey(route);
    let engine = this.mtEngines.get(key);
    if (!engine) {
      engine = acquireEngine(route);
      this.mtEngines.set(key, engine);
    }
    return engine;
  }

  private async translateOneClaude(
    sid: number,
    rev: number,
    text: string,
    history: Array<[string, string]>,
    isPartial: boolean,
    metrics: Metrics,
    signal?: AbortSignal,
  ): Promise<string> {
    const backendCfg = getTranslateBackend(this.translateBackend);
    if (!backendCfg || backendCfg.sdk !== "anthropic") return ""; // validator should prevent this
    const model = backendCfg.model as string;
    if (this.claude === null) {
      const apiKeyEnv = backendCfg.api_key_env;
      const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
      if (apiKeyEnv && !apiKey) {
        await this.safeSendJson({ type: "error", message: `${apiKeyEnv} env var not set.` });
        return "";
      }
      this.claude = new Anthropic({ apiKey: apiKey || "dummy", ...(backendCfg.base_url ? { baseURL: backendCfg.base_url } : {}) });
    }

    const sys = buildTranslationSystemInstruction(this.targetLang, this.sourceLang, this.scene, this.glossary);
    const messages = this.buildClaudeMessages(history, text, isPartial);

    let attempts = 0;
    const maxAttempts = 2;
    for (;;) {
      attempts += 1;
      const full: string[] = [];
      try {
        // cache_control is a top-level auto-cache param (matches server.py).
        const params: Anthropic.MessageStreamParams = {
          model,
          max_tokens: 512,
          system: sys,
          messages,
          thinking: anthropicThinkingOff(model),
          cache_control: { type: "ephemeral" },
        };
        const stream = this.claude.messages.stream(params, signal ? { signal } : undefined);
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const chunkText = event.delta.text;
            if (chunkText) {
              if (metrics.firstChunkAt === null) metrics.firstChunkAt = monotonic();
              full.push(chunkText);
              await this.safeSendJson({ type: "translation", sid, rev, text: chunkText });
            }
          }
        }
        return full.join("").trim();
      } catch (e) {
        if (signal?.aborted) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        if (this.isRetryable(msg) && attempts < maxAttempts) {
          log.warning(`claude sid=${sid} transient error, retrying in 3s: ${msg.slice(0, 120)}`);
          await sleep(3.0);
          continue;
        }
        throw e;
      }
    }
  }

  private async translateOneOpenai(
    sid: number,
    rev: number,
    text: string,
    history: Array<[string, string]>,
    isPartial: boolean,
    metrics: Metrics,
    signal?: AbortSignal,
  ): Promise<string> {
    const backendCfg = getTranslateBackend(this.translateBackend);
    if (!backendCfg || backendCfg.sdk !== "openai") return "";
    const model = backendCfg.model as string;
    if (this.openaiClient === null) {
      const apiKeyEnv = backendCfg.api_key_env;
      const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
      if (apiKeyEnv && !apiKey) {
        await this.safeSendJson({ type: "error", message: `${apiKeyEnv} env var not set.` });
        return "";
      }
      this.openaiClient = new OpenAI({ apiKey: apiKey || "dummy", ...(backendCfg.base_url ? { baseURL: backendCfg.base_url } : {}) });
    }

    const sys = buildTranslationSystemInstruction(this.targetLang, this.sourceLang, this.scene, this.glossary);
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: sys }];
    for (const [s, d] of history) {
      messages.push({ role: "user", content: `Translate: ${s}` });
      messages.push({ role: "assistant", content: d });
    }
    messages.push({ role: "user", content: partialOrPlainUser(text, isPartial) });

    let attempts = 0;
    const maxAttempts = 2;
    for (;;) {
      attempts += 1;
      const full: string[] = [];
      try {
        const stream = await this.openaiClient.chat.completions.create(
          { model, messages, max_tokens: 512, stream: true },
          signal ? { signal } : undefined,
        );
        for await (const event of stream) {
          if (!event.choices || event.choices.length === 0) continue;
          const delta = event.choices[0].delta?.content || "";
          if (delta) {
            if (metrics.firstChunkAt === null) metrics.firstChunkAt = monotonic();
            full.push(delta);
            await this.safeSendJson({ type: "translation", sid, rev, text: delta });
          }
        }
        return full.join("").trim();
      } catch (e) {
        if (signal?.aborted) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        if (this.isRetryable(msg) && attempts < maxAttempts) {
          log.warning(`openai sid=${sid} transient error, retrying in 3s: ${msg.slice(0, 120)}`);
          await sleep(3.0);
          continue;
        }
        throw e;
      }
    }
  }

  private async translateOneClaudePaired(
    sid: number,
    rev: number,
    text: string,
    history: Array<[string, string]>,
    prevSrc: string,
    prevDst: string,
    metrics: Metrics,
  ): Promise<{ curr: string; prevRevised: string | null }> {
    if (this.claude === null) return { curr: "", prevRevised: null };
    const backendCfg = getTranslateBackend(this.translateBackend);
    if (!backendCfg || backendCfg.sdk !== "anthropic") return { curr: "", prevRevised: null };
    const model = backendCfg.model as string;

    const sys = buildPairedTranslationSystemInstruction(this.targetLang, this.sourceLang, this.scene, this.glossary);
    const messages: Anthropic.MessageParam[] = [];
    for (const [s, d] of history) {
      messages.push({ role: "user", content: `Translate: ${s}` });
      messages.push({ role: "assistant", content: d });
    }
    messages.push({ role: "user", content: `Previous source: ${prevSrc}\nPrevious translation: ${prevDst}\nNew source: ${text}` });

    let attempts = 0;
    const maxAttempts = 2;
    let parser = new PairedStreamParser();
    for (;;) {
      attempts += 1;
      parser = new PairedStreamParser();
      try {
        const params: Anthropic.MessageStreamParams = {
          model,
          max_tokens: 512,
          system: sys,
          messages,
          thinking: anthropicThinkingOff(model),
          cache_control: { type: "ephemeral" },
        };
        const stream = this.claude.messages.stream(params);
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const chunkText = event.delta.text;
            if (!chunkText) continue;
            const emit = parser.feed(chunkText);
            if (emit) {
              if (metrics.firstChunkAt === null) metrics.firstChunkAt = monotonic();
              await this.safeSendJson({ type: "translation", sid, rev, text: emit });
            }
          }
        }
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (this.isRetryable(msg) && attempts < maxAttempts) {
          log.warning(`claude paired sid=${sid} transient error, retrying in 3s: ${msg.slice(0, 120)}`);
          await sleep(3.0);
          continue;
        }
        throw e;
      }
    }

    const parsed = parser.finalize();
    let curr = parsed.curr.trim();
    const prevOut = (parsed.prev ?? "").trim();
    const decision = parsed.decision ?? "";

    // Fallback when paired returned no usable CURR (garbled/fragment input):
    // retry with the simpler non-paired prompt so the user always gets output.
    if (!curr) {
      log.warning(`paired sid=${sid} returned empty CURR — falling back to non-paired. raw response head: ${JSON.stringify(parser.full.slice(0, 300))}`);
      curr = await this.translateOneClaude(sid, rev, text, history, false, metrics);
      return { curr: curr.trim(), prevRevised: null };
    }

    // Treat as a revision only when the model explicitly says revise AND the
    // text actually differs. KEEP + drifted text is a no-op (avoid flicker).
    let prevRevised: string | null = null;
    if (decision === "revise" && prevOut && prevOut !== prevDst) {
      prevRevised = prevOut;
    } else if (decision !== "revise" && prevOut && prevOut !== prevDst) {
      log.info(`paired sid=${sid} decision=keep but PREV drifted; ignoring (orig=${JSON.stringify(prevDst.slice(0, 40))} got=${JSON.stringify(prevOut.slice(0, 40))})`);
    }
    return { curr, prevRevised };
  }

  private buildClaudeMessages(history: Array<[string, string]>, text: string, isPartial: boolean): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];
    for (const [s, d] of history) {
      messages.push({ role: "user", content: `Translate: ${s}` });
      messages.push({ role: "assistant", content: d });
    }
    messages.push({ role: "user", content: partialOrPlainUser(text, isPartial) });
    return messages;
  }

  // Same transient-error policy as the Python translate paths.
  private isRetryable(msg: string): boolean {
    const ml = msg.toLowerCase();
    return (
      msg.includes("429") ||
      ml.includes("rate_limit") ||
      ml.includes("overloaded") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      ml.includes("bad gateway") ||
      ml.includes("service unavailable") ||
      ml.includes("gateway timeout")
    );
  }
}
