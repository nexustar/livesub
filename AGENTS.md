# livesub — notes for developers and agents

Real-time bilingual captions: a Node/TypeScript server and a static browser
frontend. User-facing docs are in `README.md`; this file holds only what you
need to change the code safely.

## Layout

- `src/server.ts` — HTTP routes (`/api/backends`, `/api/models/*`, `/api/hints`, static files), the `/ws` endpoint, startup.
- `src/pipeline.ts` — the per-session `Pipeline`: audio in, the ASR workers (qwen, voxtral, openai-realtime, dashscope, gemini), sentence segmentation, translation, events out to the client.
- `src/config.ts` — env, translate-backend registry, Qwen model registry, data dir, where `qwen_asr` comes from (`QWEN_ASR_BIN`, then the `qwen-asr` npm package, then `PATH`).
- `src/models.ts` — model downloads behind `/api/models`.
- `src/prompts.ts` — translation prompts and `PairedStreamParser`; `src/hints.ts` — `/api/hints`; `src/util.ts` — queue, logger, helpers.
- `static/` — the frontend: vanilla JS/HTML/CSS, no build step, one file per role.
- `bin/livesub.mjs` — the CLI; `scripts/` — manual check scripts (not shipped, no test runner).

## Run, verify, release

- `npm install`, then `npm start` (http://0.0.0.0:8000; the port is fixed). `.env` / `livesub.toml` are read from the working directory.
- After editing `src/`: `npm run typecheck`. There are no frontend tests: check UI changes in a browser.
- `qwen_asr` comes from the optional dependency `qwen-asr` (prebuilt, built from github.com/nexustar/qwen-asr); a `QWEN_ASR_BIN` in `.env` overrides it.
- Before changing a default model: `npx tsx scripts/bench-models.ts translate [sdk:model ...]` (or `hints`), N>=12 rounds; small samples swing by 2x.
- Release: push a `v*` tag; `.github/workflows/release.yml` tests the packed package and publishes it (prereleases on the `next` tag). The tag sets the version.

## Tuned behaviour — don't change without understanding why

Each has a comment at the site.

- `pipeline.ts`: the leading-space lstrip in `onTranscriptChunk` and `cut <= 0` (not `< 0`) in the length fallback — both prevent stalls; the `<=256`-char slicing in `onTranscriptText` — piped subprocess output arrives in bursts that would otherwise become huge segments.
- qwen-asr flags: keep `--skip-silence` and `--past-text yes`, don't add `--repeat-penalty`, and don't pass a `--prompt` (the model copies term lists into the transcript; the glossary goes to the translator).
- Pre-buffer replay on silence→speech, or word onsets get clipped.
- Gemini ASR (`gemini-3.5-transcribe-live`): automatic VAD stays disabled with one manual `activityStart` per session (its VAD misses speech in noisy audio), no `systemInstruction` (bias via `customVocabulary`). Interims are a growing full-replace hypothesis, consumed with a tail hold-back (`GEMINI_INTERIM_HOLDBACK_CHARS`). A final arrives after about 220 s of audio and the session goes quiet after it: flush and reopen.
- `PairedStreamParser` holds back any partial `</curr>` so a closing tag never streams into the caption.
- `safeSendJson` awaits the ws flush (client backpressure, send errors).
- Client: a failed revision (`translation_done` with `ok: false`) keeps the previous translation; `stop()` clears `ws.onclose` so only server-side closes report a reason.
- Thinking-off is per model on the Anthropic SDK path (`anthropicThinkingOff`): `claude-sonnet-5-5` needs `{type: "between_tools"}`, others `disabled`; probe a new Claude model before adding it. Gemini translate uses `thinkingLevel: MINIMAL` (`thinkingBudget: 0` 400s on 3.5); default stays `gemini-3.1-flash-lite` (3.5 measured slower; re-bench before 3.1's 2027-05-07 shutdown).
- Hints: keep `web_search_20250305` (newer versions slower and costlier), `max_tokens: 4096` (thinking counts against it), and the effort level. Gemini hints stays `gemini-2.5-flash` (no free-tier Search grounding on 3.x).
- Model downloads: files land as `.part` and are renamed only after the size and sha256 check; the HF revision, sizes and hashes in `QWEN_MODELS` change together. Model POSTs require a JSON content type so other sites can't trigger multi-GB downloads.
- Frontend: polled UI (model rows, the welcome card) is updated in place, not rebuilt, so a click isn't lost mid-poll; `#settings-panel [hidden] { display: none }` must stay, as row/button display rules otherwise beat the `hidden` attribute.
- Model IDs were last re-evaluated 2026-10 with measurements; confirm before bumping.

## Conventions

- Comment density high; match the existing style. No emojis in code.
- One module per role; no premature abstractions.
- Log with `log.*`, not `console.log`; keep `log.info` under ~100 per session.
- Use the vendor's JS SDK rather than hand-rolled HTTP.
- Commits: short imperative subject (`Area: what changed`), a few lines on why; author `nexustar <inexustar@gmail.com>`.
