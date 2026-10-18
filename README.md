# livesub

English | [简体中文](README.zh-CN.md)

Real-time bilingual captions for livestreams, videos and calls. The
captions show in a browser page; the audio comes from a browser tab or a
microphone. Speech-to-text can run entirely on your computer with
Qwen3-ASR, which holds up even over background music; translation is
your choice of a cloud model, a local LLM, or none.

## Quick start

Needs Node.js 20+ and Chrome or Edge (for capturing tab audio).

```bash
npm install -g livesub@next
livesub
```

Open <http://localhost:8000>, download the speech model when asked, pick
**Mic** or **Tab** and press **Start**. **Pop out** moves the
captions into a small always-on-top window you can place over the video.
The interface follows your browser's language (English or Chinese); change
it in **Settings → Display**.

For translation, create a `.env` file with a key, e.g.
`DEEPSEEK_API_KEY=sk-...`, and start livesub from the folder that holds
it (it reads `.env` from the current folder).

## Backends

Choose them in **Settings → Backends**.

| Speech-to-text | Setup |
|---|---|
| Qwen3-ASR 0.6B / 1.7B (local) | download from the page; 1.7B is more accurate but needs a fast computer |
| Qwen Cloud | `DASHSCOPE_API_KEY` (best cloud option over music) |
| OpenAI Realtime | `OPENAI_API_KEY` (best on clean speech) |
| Gemini Live | `GEMINI_API_KEY` |
| Voxtral 4B (local) | build [voxtral.c](https://github.com/antirez/voxtral.c), set `VOXTRAL_BIN` and `VOXTRAL_MODEL_DIR` |

| Translation | Setup |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` (cheapest) |
| Claude Haiku / Sonnet | `ANTHROPIC_API_KEY` (best quality) |
| Gemini | `GEMINI_API_KEY` |
| Ollama, LM Studio, OpenRouter, ... | an entry in `livesub.toml` |

## Configuration

`.env` (API keys and overrides) and `livesub.toml` (extra translation
backends) are read from the folder you start livesub in. See
`.env.example` and `livesub.toml.example` in the package for every
option. Models are downloaded to the platform data dir (e.g.
`~/Library/Application Support/livesub` on macOS) unless
`LIVESUB_DATA_DIR` is set; set `HF_ENDPOINT` to use a Hugging Face
mirror.

livesub listens on `127.0.0.1:8000`. To open the captions on another
device, such as a phone, start it with `livesub --host 0.0.0.0` and visit
`http://<this computer's IP>:8000`; anyone on that network can then use
it, and your API keys. `--port` picks another port.

Local speech-to-text runs on macOS 13.3+ and on Linux (x86-64 with AVX2
or arm64, glibc 2.28+). Elsewhere, use a cloud backend.

## Running from source

```bash
git clone https://github.com/nexustar/livesub && cd livesub
npm install
npm start
```

`.env` and `livesub.toml` then go in the cloned folder.

## License

MIT
