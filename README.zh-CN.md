# livesub

[English](README.md) | 简体中文

为直播、视频和通话生成实时双语字幕。字幕显示在浏览器页面中，声音可以来自
浏览器标签页或麦克风。语音识别可以完全在本机用 Qwen3-ASR 运行，有背景音乐时
也能保持准确；翻译可以选用云端模型、本地大模型、Firefox 的离线翻译模型，或者
不翻译。

## 快速开始

需要 Node.js 22.15+，以及 Chrome 或 Edge（用于采集标签页音频）。

```bash
npm install -g livesub@next
livesub
```

打开 <http://localhost:8000>，按提示下载语音模型，选择 **麦克风** 或
**标签页**，然后点击 **开始**。**弹出** 会把字幕放进一个置顶的小窗口，可以
摆在视频上方。界面语言跟随浏览器（中文或英文），可以在 **设置 → 显示** 中修改。

没有 API key 时，翻译可以用 Firefox 的翻译模型在本机运行（选择 **本地翻译**，
再下载所用语言对的模型）。想要更好的翻译，新建一个 `.env` 文件并写入
API key，例如 `DEEPSEEK_API_KEY=sk-...`，然后在这个文件所在的目录启动
livesub（它从当前目录读取 `.env`）。

## 后端

在 **设置 → 后端** 中选择。

| 语音识别 | 配置 |
|---|---|
| Qwen3-ASR 0.6B / 1.7B（本地） | 在页面中下载；1.7B 更准确，但需要性能较好的电脑 |
| Qwen 云端 | `DASHSCOPE_API_KEY`（有背景音乐时最好的云端选项） |
| OpenAI Realtime | `OPENAI_API_KEY`（干净人声效果最好） |
| Gemini Live | `GEMINI_API_KEY` |
| Voxtral 4B（本地） | 编译 [voxtral.c](https://github.com/antirez/voxtral.c)，设置 `VOXTRAL_BIN` 和 `VOXTRAL_MODEL_DIR` |

| 翻译 | 配置 |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY`（最便宜） |
| Claude Haiku / Sonnet | `ANTHROPIC_API_KEY`（质量最好） |
| Gemini | `GEMINI_API_KEY` |
| Ollama、LM Studio、OpenRouter 等 | 在 `livesub.toml` 中添加一项 |
| 本地翻译 | 无需配置；在页面中下载所用语言对的模型（每个方向 50–70 MB） |

本地翻译使用 Firefox 翻译网页所用的模型，在 CPU 上运行（每句约 20–60 ms，
内存 300–600 MB）。所有模型都是与英语互译，其他语言对要经英语中转，需要两个
模型。它逐句独立翻译，不使用场景说明和术语表，人名常常译错。选择 **自动检测**
时，按文字判断每句的语言，拉丁字母一律当作英语。

## 配置

`.env`（API key 和其他覆盖项）和 `livesub.toml`（额外的翻译后端）都从启动
livesub 时所在的目录读取。全部选项见安装包中的 `.env.example` 和
`livesub.toml.example`。模型默认下载到系统的数据目录（例如 macOS 上的
`~/Library/Application Support/livesub`），可用 `LIVESUB_DATA_DIR` 修改；
下载慢时可以设置 `HF_ENDPOINT` 使用 Hugging Face 镜像（例如
`HF_ENDPOINT=https://hf-mirror.com`），翻译模型的镜像用 `MT_ENDPOINT` 设置。

livesub 默认监听 `127.0.0.1:8000`。想在手机等其他设备上看字幕，用
`livesub --host 0.0.0.0` 启动，然后访问 `http://<这台电脑的 IP>:8000`；此时同一
网络里的任何人都能使用它，包括你的 API key。`--port` 可以换端口。

本地语音识别支持 macOS 13.3+ 和 Linux（x86-64 需支持 AVX2，或 arm64；
glibc 2.28+）。其他系统请使用云端后端。

## 从源码运行

```bash
git clone https://github.com/nexustar/livesub && cd livesub
npm install
npm start
```

此时 `.env` 和 `livesub.toml` 放在克隆下来的目录中。

## 许可证

MIT。`vendor/bergamot` 中是 Mozilla 的翻译引擎（MPL-2.0，附有其所用各库的
许可证）；翻译模型属于 Mozilla，采用 MPL-2.0。
