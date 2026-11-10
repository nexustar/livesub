# livesub

English | [简体中文](README.zh-CN.md)

Real-time bilingual captions for livestreams, videos and calls. The
captions show in a browser page; the audio comes from a browser tab or a
microphone. Speech-to-text can run entirely on your computer with
Qwen3-ASR, which holds up even over background music; translation is
your choice of a cloud model, a local LLM, Firefox's offline translation
models, or none.

## Quick start

Needs Node.js 22.15+ and Chrome or Edge (for capturing tab audio).

```bash
npm install -g livesub@next
livesub
```

Open <http://localhost:1222>, download the speech model when asked, pick
**Mic** or **Tab** and press **Start**. **Pop out** moves the
captions into a small always-on-top window you can place over the video.
The interface follows your browser's language (English or Chinese); change
it in **Settings → Display**.

Without any API key, translation runs on your computer with Firefox's
translation models (pick **Local translation** and download the models for your
language pair). For better translations, create a `.env` file with a key,
e.g. `DEEPSEEK_API_KEY=sk-...`, and start livesub from the folder that
holds it (it reads `.env` from the current folder).

## Backends

Choose them in **Settings → Backends**.

| Speech-to-text | Setup |
|---|---|
| Qwen3-ASR 0.6B / 1.7B (local) | download from the page (int8 copies, 1.2 / 2.8 GB); 1.7B is more accurate but needs a fast computer. Next to each model's latency slider, pick CPU or a GPU (Metal on Apple Silicon, Vulkan on Linux and Windows) |
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
| Local translation | none; download the models for your language pair from the page (50–70 MB per direction) |

Local translation uses the models Firefox translates web pages with, on
the CPU (about 20–60 ms a sentence, 300–600 MB of memory). Every model
translates to or from English, so other pairs go through English and need
two models. It translates each sentence on its own: no scene notes or
glossary, and names often come out wrong. With **Auto-detect**, a
sentence's language is guessed from its script, and Latin script is taken
as English.

**Research** (Settings → Session) fills in the scene summary and glossary
from a web search on a topic you type. Pick the search engine next to the
button: Google Search through Gemini (`GEMINI_API_KEY`), Claude's web
search (`ANTHROPIC_API_KEY`) or DeepSeek's (`DEEPSEEK_API_KEY`).

## Configuration

`.env` (API keys and overrides) and `livesub.toml` (extra translation
backends) are read from the folder you start livesub in. See
`.env.example` and `livesub.toml.example` in the package for every
option. Models are downloaded to the platform data dir (e.g.
`~/Library/Application Support/livesub` on macOS) unless
`LIVESUB_DATA_DIR` is set; set `HF_ENDPOINT` to use a Hugging Face
mirror, and `MT_ENDPOINT` for a mirror of the translation models.

livesub listens on `127.0.0.1:1222`. To open the captions on another
device, such as a phone, start it with `livesub --host 0.0.0.0` and visit
`http://<this computer's IP>:1222`; anyone on that network can then use
it, and your API keys. `--port` picks another port.

Local speech-to-text runs on macOS 13.3+, on Linux (x86-64 with AVX2 or
arm64, glibc 2.28+) and on Windows (x86-64 with AVX2). Elsewhere, use a
cloud backend.

## Desktop app (preview)

The same captions in an app of its own, with two things a browser can't
do: **System audio** captures whatever the computer plays (any app, not
just a browser tab), and **Pop out** opens a frameless, transparent
caption overlay that stays on top of full-screen video. Drag it anywhere to
move it; **Click-through** (next to **Bring back**) lets clicks
reach what's below.

System audio works on macOS 14.2+ and Windows; on Linux, use Mic with a
PulseAudio or PipeWire monitor. The app reads `.env` from its settings
folder (**Settings → Open settings folder**; then **Restart server**
beside it), and shares downloaded models with the command-line livesub.

Download it from [Releases](https://github.com/nexustar/livesub/releases):
macOS (Apple Silicon), Windows (x64) and Linux (x64 AppImage). The
installers aren't signed yet; the release notes say how to open them. From
a clone (see below), `npm run desktop` runs it and `npm run desktop:dist`
builds an installer into `release/` (add `-- --x64` or `-- --arm64` for
another arch).

## Running from source

```bash
git clone https://github.com/nexustar/livesub && cd livesub
npm install
npm start
```

`.env` and `livesub.toml` then go in the cloned folder.

## License

MIT. `vendor/bergamot` holds Mozilla's translation engine (MPL-2.0, with
the licences of the libraries it is built from); the translation models
are Mozilla's, under MPL-2.0.
