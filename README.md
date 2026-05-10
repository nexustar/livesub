# livesub

Real-time bilingual live captions for whatever's playing in a browser
tab or your microphone. Built for watching Japanese livestreams
(concerts, anime events, podcasts) with Chinese / English subtitles,
but works for any language pair the underlying ASR + translator support.

```
[browser tab audio | mic]
        │  16 kHz s16le, 40 ms chunks
        ▼
    [ ASR ]      ← Gemini Live | OpenAI Realtime | Qwen3-ASR (local) | Voxtral-4B (local)
        ▼
    [ Translator ] ← Claude Haiku/Sonnet/Opus (paired) | Gemini | DeepSeek | none
        ▼
   live captions + history (browser UI)
```

## Setup

Prereqs: Python 3.11+, [`uv`](https://github.com/astral-sh/uv), and a Modern browser.

```bash
git clone <repo> && cd livesub
cp .env.example .env       # edit
uv sync
uv run python server.py    # http://0.0.0.0:8000
```

For the local Qwen ASR backend:

```bash
git clone https://github.com/antirez/qwen-asr ~/lc/qwen-asr
cd ~/lc/qwen-asr && ./download_model.sh && make blas
```

For Voxtral ASR (larger, more accurate, multilingual):

```bash
git clone https://github.com/antirez/voxtral.c ~/lc/voxtral.c
cd ~/lc/voxtral.c && ./download_model.sh && make mps   # mps on Apple Silicon
```

## `.env`

```bash
# Cloud APIs (used when picking those backends in the UI)
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=sk-ant-...      # Claude Haiku / Sonnet / Opus
DEEPSEEK_API_KEY=sk-...           # DeepSeek (uses anthropic-compatible API)
OPENAI_API_KEY=sk-...             # OpenAI Realtime ASR (gpt-realtime-whisper)

# Local ASR — only needed if you pick that backend in the UI
QWEN_ASR_BIN=/path/to/qwen_asr
QWEN_ASR_MODEL_DIR=/path/to/qwen3-asr-0.6b

VOXTRAL_BIN=/path/to/voxtral
VOXTRAL_MODEL_DIR=/path/to/voxtral-realtime-4b
```

## Usage

Open `http://localhost:8000`, pick **🎤 Mic** or **📺 Tab**, click
**Start**, choose the source tab in the browser dialog. Settings (gear
icon) let you switch ASR / translation backends, source / target
language, and feed Claude a "scene seed" to auto-generate a glossary.

UI layout, top to bottom (newest at the bottom — like a chat log):

1. **Controls** — Start / Stop, source picker, level meter, status.
2. **History** — older finalized sentences, smaller, recessed; oldest at
   the top, newest at the bottom. Auto-scrolls to keep newest visible
   unless you've scrolled up to read older content.
3. **Prev caption** — just-finalized previous sentence, same size as
   current but dim. Slides up from the LIVE slot when current finalizes;
   revisable by paired-translation (brief blue flash).
4. **Live captions** — current sentence, blue tint + LIVE badge. Anchored
   at the very bottom.

