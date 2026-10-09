// End-to-end check of the Gemini ASR path through the real server: connect to
// /ws like the browser does, send the config frame, stream 16 kHz mono PCM at
// realtime, and print every transcript/session event.
//
// Usage: node scripts/test-e2e-ws.mjs [16k-mono-wav]   (server must be running)

import { readFileSync } from "node:fs";
import WebSocket from "ws";

const WAV = process.argv[2] ?? "/tmp/test16k.wav";
const pcm = readFileSync(WAV).subarray(44); // 16k mono s16le payload
console.log(`streaming ${(pcm.length / 32000).toFixed(1)}s of audio at realtime`);

const ws = new WebSocket("ws://127.0.0.1:8000/ws");
const parts = [];

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "config",
      asr_backend: "gemini",
      translate_backend: "none",
      source_lang: "auto",
      target_lang: "Chinese",
      scene: "",
      glossary: "",
    }),
  );
  // 100 ms frames, realtime pacing — same shape as the browser worklet feed.
  const FRAME = 3200;
  let off = 0;
  const iv = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(iv);
      // Leave time for the trailing sentence flush before hanging up.
      setTimeout(() => ws.close(), 8000);
      return;
    }
    ws.send(pcm.subarray(off, off + FRAME));
    off += FRAME;
  }, 100);
});

ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "transcript") {
    parts.push(m.text);
    process.stdout.write(m.text.replace(/\n/g, " "));
  } else if (m.type !== "audio_stats") {
    console.log(`\n[evt] ${JSON.stringify(m).slice(0, 200)}`);
  }
});

ws.on("close", () => {
  console.log("\n\n===== FULL TRANSCRIPT =====");
  console.log(parts.join(""));
  process.exit(0);
});
ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(1);
});
