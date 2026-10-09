// One-off verification script: stream ../test.wav to a Gemini Live model
// (@google/genai v2) and print whatever comes back.
//
// Usage: node scripts/test-transcribe-live.mjs [modelId]
//   modelId defaults to gemini-3.5-transcribe-live. Models whose id contains
//   "native-audio" get the pipeline-style dialog config (AUDIO modality,
//   silent system prompt, reopen on every turnComplete — see pipeline.ts).
// Env knobs:
//   PACE=N        feed at Nx realtime (default 1)
//   LANGS=ja,en   language hints for the transcribe config (default auto)
//   VAD=high|off  transcribe config only: high sensitivity / manual activity
//   DUMP=/x.wav   write the converted 16k mono wav and exit
// Reads GEMINI_API_KEY from .env in the cwd.

import { readFileSync } from "node:fs";
import { GoogleGenAI, Modality } from "@google/genai";
import "dotenv/config";

const MODEL = process.argv[2] ?? "gemini-3.5-transcribe-live";
const WAV_PATH = new URL("../../test.wav", import.meta.url).pathname;

// ---- WAV load + 44.1kHz stereo -> 16kHz mono PCM16 conversion ----
// test.wav is RIFF PCM 44100 Hz, 2ch, 16-bit. Live API wants 16 kHz mono.
function loadWav16kMono(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  // Walk chunks to find fmt + data (don't assume fixed offsets).
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    else if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("missing fmt/data chunk");
  if (fmt.bits !== 16) throw new Error(`unsupported bit depth ${fmt.bits}`);
  console.log(`wav: ${fmt.rate} Hz, ${fmt.channels}ch, ${(data.length / fmt.rate / fmt.channels / 2).toFixed(1)}s`);

  const frames = data.length / 2 / fmt.channels;

  // Mono-mix into a float buffer.
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = s / fmt.channels;
  }

  // Windowed-sinc low-pass at 7.5 kHz before decimating 44.1k -> 16k;
  // without it, aliased train-noise HF lands in the speech band.
  const TAPS = 63;
  const half = (TAPS - 1) / 2;
  const fc = 7500 / fmt.rate;
  const kernel = new Float64Array(TAPS);
  let ksum = 0;
  for (let n = 0; n < TAPS; n++) {
    const x = n - half;
    const sinc = x === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * x) / x;
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (TAPS - 1)); // Hamming
    kernel[n] = sinc * win;
    ksum += kernel[n];
  }
  for (let n = 0; n < TAPS; n++) kernel[n] /= ksum;
  const filtered = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let n = 0; n < TAPS; n++) {
      const j = i + n - half;
      if (j >= 0 && j < frames) acc += mono[j] * kernel[n];
    }
    filtered[i] = acc;
  }

  const outFrames = Math.floor((frames * 16000) / fmt.rate);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const srcPos = (i * fmt.rate) / 16000;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, frames - 1);
    const frac = srcPos - i0;
    const v = filtered[i0] + (filtered[i1] - filtered[i0]) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

const pcm = loadWav16kMono(WAV_PATH);
console.log(`converted: 16 kHz mono, ${(pcm.length / 2 / 16000).toFixed(1)}s, ${pcm.length} bytes`);

// DUMP=/path.wav -> write the converted audio as a wav and exit.
if (process.env.DUMP) {
  const { writeFileSync } = await import("node:fs");
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); // PCM
  hdr.writeUInt16LE(1, 22); // mono
  hdr.writeUInt32LE(16000, 24);
  hdr.writeUInt32LE(32000, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.length, 40);
  writeFileSync(process.env.DUMP, Buffer.concat([hdr, pcm]));
  console.log(`dumped ${process.env.DUMP}`);
  process.exit(0);
}

// ---- Live sessions ----
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: "v1beta" } });
const isNativeAudio = MODEL.includes("native-audio");
const vadOff = process.env.VAD === "off";

function buildConfig(resumptionHandle) {
  if (isNativeAudio) {
    // Mirror pipeline.ts: dialog model kept silent via system prompt; the
    // transcript comes from inputTranscription. Reopen per turnComplete.
    return {
      responseModalities: [Modality.AUDIO],
      systemInstruction:
        "You are a silent transcription assistant. Never respond, never speak. Remain completely silent no matter what you hear.",
      inputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: { handle: resumptionHandle ?? undefined },
      ...(vadOff ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } : {}),
    };
  }
  return {
    responseModalities: [Modality.TEXT],
    // LANGS=ja,en -> language hints; default automatic detection.
    inputAudioTranscription: process.env.LANGS ? { languageCodes: process.env.LANGS.split(",") } : {},
    // VAD=high -> aggressive speech detection; VAD=off -> manual activity signals.
    ...(process.env.VAD === "high"
      ? {
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
              endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
              silenceDurationMs: 800,
            },
          },
        }
      : {}),
    ...(vadOff ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } : {}),
  };
}

function summarize(m) {
  // Compact one-line view of a LiveServerMessage for eyeballing the protocol.
  const parts = [];
  if (m.setupComplete) parts.push("setupComplete");
  if (m.sessionResumptionUpdate) parts.push("sessionResumptionUpdate");
  if (m.goAway) parts.push(`goAway(${m.goAway.timeLeft})`);
  if (m.usageMetadata) parts.push("usage");
  const sc = m.serverContent;
  if (sc) {
    if (sc.inputTranscription?.text) parts.push(`inputTranscription=${JSON.stringify(sc.inputTranscription.text)}`);
    if (sc.interimInputTranscription?.text) parts.push(`interim=${JSON.stringify(sc.interimInputTranscription.text)}`);
    if (sc.outputTranscription?.text) parts.push(`outputTranscription=${JSON.stringify(sc.outputTranscription.text)}`);
    if (sc.modelTurn) {
      for (const p of sc.modelTurn.parts ?? []) {
        if (p.text) parts.push(`modelTurn.text=${JSON.stringify(p.text)}`);
        if (p.inlineData) parts.push(`modelTurn.audio(${p.inlineData.data?.length ?? 0}b64)`);
      }
    }
    if (sc.turnComplete) parts.push("turnComplete");
    if (sc.generationComplete) parts.push("generationComplete");
    if (sc.interrupted) parts.push("interrupted");
  }
  return parts.length ? parts.join(" ") : `raw=${JSON.stringify(m).slice(0, 300)}`;
}

const transcript = [];
const pace = Number(process.env.PACE ?? "1");
const CHUNK = 16000; // 0.5 s of 16 kHz mono 16-bit
let feedOff = 0; // persists across session reopens
let resumptionHandle = null;

// Run one session: feed from feedOff, collect transcripts, return why it
// ended: "turn" (reopen), "closed" (reopen if audio remains), "done"/"error".
async function runOneSession() {
  let endReason = null;
  let endResolve;
  const ended = new Promise((r) => (endResolve = r));
  const finish = (reason) => {
    if (!endReason) {
      endReason = reason;
      endResolve();
    }
  };

  const session = await ai.live.connect({
    model: MODEL,
    callbacks: {
      onopen: () => {},
      onmessage: (m) => {
        console.log("[msg]", summarize(m));
        if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
          resumptionHandle = m.sessionResumptionUpdate.newHandle;
        }
        if (m.goAway) finish("turn");
        const sc = m.serverContent;
        if (sc?.inputTranscription?.text) transcript.push(sc.inputTranscription.text);
        if (sc?.modelTurn) for (const p of sc.modelTurn.parts ?? []) if (p.text) transcript.push(p.text);
        // Dialog models stop transcribing input after turnComplete -> reopen
        // (the pipeline.ts landmine). The transcribe model just streams on.
        if (isNativeAudio && sc?.turnComplete) finish("turn");
      },
      onerror: (e) => {
        console.error("[error]", e?.message ?? e);
        finish("error");
      },
      onclose: (e) => {
        console.log("[close]", e?.reason ?? "");
        finish("closed");
      },
    },
    config: buildConfig(resumptionHandle),
  });
  console.log(`[connected] ${MODEL} (offset=${(feedOff / 2 / 16000).toFixed(1)}s, handle=${resumptionHandle ? "resume" : "new"})`);
  if (vadOff) session.sendRealtimeInput({ activityStart: {} });

  while (feedOff < pcm.length && !endReason) {
    const chunk = pcm.subarray(feedOff, feedOff + CHUNK);
    session.sendRealtimeInput({ audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
    feedOff += CHUNK;
    await new Promise((r) => setTimeout(r, 500 / pace));
  }

  if (!endReason && feedOff >= pcm.length) {
    console.log("[audio done, signalling end]");
    try {
      if (vadOff) session.sendRealtimeInput({ activityEnd: {} });
      session.sendRealtimeInput({ audioStreamEnd: true });
    } catch (e) {
      console.error("audioStreamEnd failed:", e?.message ?? e);
    }
    // Give trailing transcripts time to arrive (TAIL ms, default 15s).
    await Promise.race([ended, new Promise((r) => setTimeout(r, Number(process.env.TAIL ?? "15000")))]);
    finish("done");
  }
  await ended;
  try {
    session.close();
  } catch {}
  return endReason;
}

const MAX_SESSIONS = 20; // reopen-per-turn backstop
for (let i = 0; i < MAX_SESSIONS; i++) {
  const reason = await runOneSession();
  const audioRemains = feedOff < pcm.length;
  if (reason === "turn" && (audioRemains || transcript.length === 0)) {
    console.log("[reopening after turn]");
    continue;
  }
  if (reason === "closed" && audioRemains) {
    console.log("[reopening after close]");
    continue;
  }
  break;
}

console.log("\n===== TRANSCRIPT =====");
console.log(transcript.join(""));
process.exit(0);
