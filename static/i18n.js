// UI translations, gettext-style: the English text is the key and a missing
// entry falls back to it. `{name}` placeholders take t()'s vars. Server
// messages stay English.

const LS_UI_LANG = "livesub.uiLang";

// Shown in the Display tab, each in its own language.
export const UI_LANGS = [["en", "English"], ["zh", "简体中文"]];

const LOCALES = {
  zh: {
    // Toolbar
    "Start": "开始",
    "Stop": "停止",
    "Audio source": "音频来源",
    "Mic": "麦克风",
    "Tab": "标签页",
    "audio level": "音量",
    "Settings": "设置",
    "Show captions in an always-on-top window": "在置顶小窗中显示字幕",
    "Pop out": "弹出",
    "Clear": "清空",
    "Captions are in the pop-out window.": "字幕正显示在弹出窗口中。",
    "Bring back": "收回",

    // Status line
    "idle": "空闲",
    "listening": "正在听",
    "connecting…": "正在连接…",
    "reconnecting…": "正在重连…",
    "disconnected": "已断开",
    "disconnected, retrying in {s}s…": "已断开，{s} 秒后重试…",
    "error: {message}": "错误：{message}",
    "error: {message}; retrying in {s}s…": "错误：{message}；{s} 秒后重试…",
    "requesting mic…": "正在请求麦克风…",
    "pick a tab/window with audio…": "请选择一个有声音的标签页…",
    "no speech-to-text backend configured": "没有可用的语音识别后端",
    "download the speech-to-text model first": "请先下载语音识别模型",
    "download the translation models first": "请先下载翻译模型",
    "Tab capture isn't supported in this browser.": "此浏览器不支持标签页音频采集。",
    "No audio track delivered.": "没有收到音频。",
    "Firefox on Linux Wayland can't capture tab audio. Try Chrome or Chromium, or route system audio through a PipeWire virtual mic and use Mic.":
      "Linux Wayland 上的 Firefox 无法采集标签页音频。请改用 Chrome 或 Chromium，或者把系统音频接到 PipeWire 虚拟麦克风后使用“麦克风”。",
    "Pick a tab (not “Entire screen” or “Window”) and turn on “Share tab audio”.":
      "请选择一个标签页（不要选“整个屏幕”或“窗口”），并勾选“分享标签页音频”。",

    // Settings tabs
    "Session": "会话",
    "Backends": "后端",
    "Display": "显示",

    // Session tab
    "Source language": "源语言",
    "Auto-detect": "自动检测",
    "Chinese": "中文",
    "English": "英语",
    "Japanese": "日语",
    "Korean": "韩语",
    "Spanish": "西班牙语",
    "French": "法语",
    "German": "德语",
    "Italian": "意大利语",
    "Portuguese": "葡萄牙语",
    "Russian": "俄语",
    "Arabic": "阿拉伯语",
    "Target language": "目标语言",
    "Topic for research": "调研主题",
    "optional": "可选",
    "e.g. μ's Final Live concert; ICASSP 2026 keynote; FromSoftware Elden Ring stream":
      "例如：μ's Final Live 演唱会；ICASSP 2026 主题演讲；FromSoftware《艾尔登法环》直播",
    "Research": "调研",
    "Fills in Scene and Glossary from a web search.": "通过网页搜索自动填写场景说明和术语表。",
    "Scene summary": "场景说明",
    "e.g. Live concert by Japanese idol group μ's; use casual Chinese fan-slang and preserve idol terminology like 推し / ペンライト.":
      "例如：日本偶像组合 μ's 的演唱会；用轻松的中文饭圈用语，保留 推し / ペンライト 等偶像术语。",
    "Notes for the translator: setting, tone, style.": "给翻译的说明：场合、语气、风格。",
    "Glossary": "术语表",
    "Names and terms in the source language, comma-separated.": "源语言中的人名和术语，用逗号分隔。",
    "Type a topic first.": "请先填写调研主题。",
    "Researching (may take 5–15s)…": "正在调研（需要 5–15 秒）…",
    " via {backend}": "（{backend}）",
    "Search engine": "搜索引擎",
    "Google Search (Gemini)": "Google 搜索（Gemini）",
    "Claude web search": "Claude 网页搜索",
    "DeepSeek web search": "DeepSeek 网页搜索",
    " (1 web search)": "（1 次网页搜索）",
    " ({n} web searches)": "（{n} 次网页搜索）",
    "Generated{via}: scene ({scene} chars) + glossary ({glossary} chars){searches}. Edit below as needed.":
      "已生成{via}：场景说明 {scene} 字，术语表 {glossary} 字{searches}。可在下方修改。",
    "Failed: {error}": "失败：{error}",

    // Backends tab
    "Speech-to-text backend": "语音识别后端",
    "Translation backend": "翻译后端",
    "(none configured)": "（未配置）",
    "{label} — not downloaded": "{label}（未下载）",
    // Backend labels from /api/backends
    "Qwen (small, local)": "Qwen（小，本地）",
    "Qwen (large, local)": "Qwen（大，本地）",
    "Voxtral (local)": "Voxtral（本地）",
    "Qwen ASR (Cloud)": "Qwen ASR（云端）",
    "None (transcript only)": "无（仅转写）",
    "Local translation": "本地翻译",
    "Speech-to-text models": "语音识别模型",
    "Translation models": "翻译模型",
    "The scene summary is only used with LLM translation (Claude, DeepSeek, Gemini, …).":
      "场景说明只在使用大模型翻译（Claude、DeepSeek、Gemini 等）时生效。",
    "These are only used with LLM translation (Claude, DeepSeek, Gemini, …).":
      "以下各项只在使用大模型翻译（Claude、DeepSeek、Gemini 等）时生效。",
    "Downloads go to {dir}": "下载位置：{dir}",
    "Ready": "就绪",
    "Ready — from {env}": "就绪（来自 {env}）",
    "{env} points to a missing directory: {dir}": "{env} 指向的目录不存在：{dir}",
    "Downloading {pct}% · {done} / {size}": "正在下载 {pct}% · {done} / {size}",
    "Downloading {pct}% of {size}…": "正在下载 {pct}%，共 {size}…",
    "Downloaded — loading…": "已下载，正在加载…",
    "Download failed: {error}": "下载失败：{error}",
    "Partly downloaded · {pct}% of {size}": "已下载一部分 · {pct}%，共 {size}",
    "Not downloaded yet · {size}": "尚未下载 · {size}",
    "Paused at {pct}%": "已暂停，{pct}%",
    "Not downloaded": "未下载",
    "Download": "下载",
    "Resume": "继续",
    "Retry": "重试",
    "Cancel": "取消",
    "Delete": "删除",
    "Delete {label} ({size})?": "删除 {label}（{size}）？",
    "{label}: latency vs. CPU": "{label}：延迟与 CPU 占用",
    "{label}: device": "{label}：运行设备",
    "Lower latency": "延迟更低",
    "Lower CPU": "CPU 更省",
    // Local translation
    "No local model translates into “{lang}”.": "没有能译成“{lang}”的本地模型。",
    "No local model translates from {lang}.": "没有能翻译{lang}的本地模型。",
    "No local models for {src} → {tgt}.": "没有 {src} → {tgt} 的本地模型。",
    "With Auto-detect, each sentence's language is guessed from its script (Latin script counts as English), and only languages with downloaded models are translated. Pick the source language to download its models.":
      "自动检测时按文字判断每句的语言（拉丁字母一律当作英语），只翻译已下载模型的语言。选定源语言后即可下载对应模型。",
    "Source and target are the same language: captions show the transcript.": "源语言和目标语言相同，字幕直接显示转写。",
    "Translation models for {path} ({size})": "需要 {path} 的翻译模型（{size}）",
    "Models from Firefox: {path}": "模型来自 Firefox：{path}",

    // Display tab
    "Interface language": "界面语言",
    "Follow browser": "跟随浏览器",
    "Large captions": "大字幕",
    "For viewing from a distance.": "适合远距离观看。",
    "Debug mode": "调试模式",
    "Diagnostic badges and extra, less tested source languages.": "显示诊断指标，并提供更多尚未充分测试的源语言。",

    // Welcome card
    "Speech-to-text isn't available": "语音识别不可用",
    "QWEN_ASR_BIN in .env points to a missing file. Fix or remove it, then restart livesub.":
      ".env 中的 QWEN_ASR_BIN 指向的文件不存在。请修正或删除它，然后重启 livesub。",
    "Local speech-to-text isn't supported on this computer yet. Add a cloud API key (e.g. DASHSCOPE_API_KEY) to .env and restart livesub.":
      "这台电脑暂不支持本地语音识别。请在 .env 中添加一个云端 API key（例如 DASHSCOPE_API_KEY），然后重启 livesub。",
    "Details: {reason}.": "详情：{reason}。",
    "Download a speech model": "下载语音模型",
    "Runs offline on this computer. Pick one:": "在本机离线运行。选择一个：",
    "Runs offline on this computer.": "在本机离线运行。",
    "Standard": "标准",
    "Fast, runs on most computers.": "速度快，大多数电脑都能运行。",
    "High accuracy": "高精度",
    "More accurate, needs a fast computer.": "更准确，需要性能较好的电脑。",
    "recommended": "推荐",
    "{env} in .env points to a missing directory: {dir}": ".env 中的 {env} 指向的目录不存在：{dir}",
    "{size} · Downloaded": "{size} · 已下载",
    "Use": "使用",
    "Paused at {pct}% · {size}": "已暂停，{pct}% · {size}",
    "Ready to caption": "准备就绪",
    "Pick {mic}, or {tab} for a browser tab (turn on “Share tab audio”).":
      "选择{mic}，或选择{tab}来采集浏览器标签页的声音（勾选“分享标签页音频”）。",
    "Press {start}.": "点击{start}。",
    "For better translations, add the topic and key names in {link}.": "在{link}中填写主题和关键名词，翻译会更准确。",
    "Settings → Session": "设置 → 会话",
    "Speech-to-text: {asr}": "语音识别：{asr}",
    "Translation: off": "翻译：关闭",
    "Translation: {tr} · {src} → {tgt}": "翻译：{tr} · {src} → {tgt}",
  },
};

let dict = null;

export function savedUiLang() {
  return localStorage.getItem(LS_UI_LANG) || "auto";
}

// "auto" follows the browser: any Chinese locale gets the zh table.
export function setUiLang(pref) {
  localStorage.setItem(LS_UI_LANG, pref);
  const lang = pref === "auto" ? (/^zh\b/i.test(navigator.language) ? "zh" : "en") : pref;
  dict = LOCALES[lang] || null;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  applyI18n(document);
}

export function t(msg, vars) {
  const s = dict?.[msg] ?? msg;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

// Like t(), but placeholders may be DOM nodes: returns the pieces to append.
export function tNodes(msg, nodes) {
  return t(msg).split(/(\{\w+\})/).filter(Boolean)
    .map((p) => (/^\{\w+\}$/.test(p) && p.slice(1, -1) in nodes ? nodes[p.slice(1, -1)] : p));
}

// Markup text: data-i18n for the element's text, data-i18n-title /
// -placeholder / -aria-label for attributes. The English is kept in the data
// attribute, so switching back needs no reload.
export function applyI18n(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    if (!el.dataset.i18n) el.dataset.i18n = el.textContent.trim();
    el.textContent = t(el.dataset.i18n);
  }
  for (const attr of ["title", "placeholder", "aria-label"]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const key = el.getAttribute(`data-i18n-${attr}`) || el.getAttribute(attr);
      el.setAttribute(`data-i18n-${attr}`, key);
      el.setAttribute(attr, t(key));
    }
  }
}
