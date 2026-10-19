import { t, tNodes, applyI18n, setUiLang, savedUiLang, UI_LANGS } from "./i18n.js";

const toggleBtn = document.getElementById("toggle");
const clearBtn = document.getElementById("clear");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const translationEl = document.getElementById("translation");
const latestEl = document.getElementById("latest");
const prevCardEl = document.getElementById("caption-prev");
const prevTranscriptEl = document.getElementById("prev-transcript");
const prevTranslationEl = document.getElementById("prev-translation");
const historyEl = document.getElementById("history");
const settingsToggleBtn = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const targetLangInput = document.getElementById("target-lang");
const sourceLangSel = document.getElementById("source-lang-select");
const sourceLangInput = document.getElementById("source-lang-input");
const sceneSeedInput = document.getElementById("scene-seed");
const sceneInput = document.getElementById("scene");
const glossaryInput = document.getElementById("glossary");
const inputSourceSel = document.getElementById("input-source");
const asrBackendSel = document.getElementById("asr-backend");
const translateBackendSel = document.getElementById("translate-backend");
const hintGenerateBtn = document.getElementById("hint-generate");
const hintStatusEl = document.getElementById("hint-status");
const vuFillEl = document.getElementById("vu-fill");
const badgeMicEl = document.getElementById("badge-mic");
const badgeAsrEl = document.getElementById("badge-asr");
const badgeTranslateEl = document.getElementById("badge-translate");
const debugModeInput = document.getElementById("debug-mode");
const fontLargeInput = document.getElementById("font-large");
const uiLangSel = document.getElementById("ui-lang");
// Status as an English key + vars, so a language switch can redo it.
let statusMsg = ["idle"];

// Interface language; switching re-renders in place (see refreshLanguage).
for (const [code, name] of UI_LANGS) uiLangSel.append(new Option(name, code));
uiLangSel.value = savedUiLang();
if (!uiLangSel.value) uiLangSel.value = "auto";
setUiLang(uiLangSel.value);
// Code-written text (no data-i18n, which a language switch would reset).
setToggleState(false);
setStatus("idle");
uiLangSel.addEventListener("change", () => {
  setUiLang(uiLangSel.value);
  refreshLanguage();
});

const LS_LANG = "livesub.targetLang";
const LS_SRC = "livesub.sourceLang";
const LS_INPUT = "livesub.inputSource";
const LS_ASR = "livesub.asrBackend";
const LS_TR = "livesub.translateBackend";
const LS_SCENE_SEED = "livesub.sceneSeed";
const LS_SCENE = "livesub.scene";
const LS_GLOSSARY = "livesub.glossary";
const LS_DEBUG = "livesub.debugMode";
const LS_FONT_LARGE = "livesub.fontLarge";
const LS_SETTINGS_TAB = "livesub.settingsTab";
// Per local model, suffixed with its id (qwen-small / qwen-large).
const LS_QWEN_CHUNK = "livesub.qwenChunkSec.";

targetLangInput.value = localStorage.getItem(LS_LANG) || "Chinese (Simplified)";
// Source-lang has two visible elements (see HTML): a <select> for normal
// mode and a free-text <input> for debug mode. Both bind to the same
// localStorage key. If the persisted value isn't one of the select's
// intersection-language options (e.g. user previously typed "Cantonese" in
// debug mode), keep it in the input but default the visible select to auto
// so the user isn't staring at a blank dropdown.
const savedSrc = localStorage.getItem(LS_SRC) || "auto";
sourceLangInput.value = savedSrc;
sourceLangSel.value = [...sourceLangSel.options].some(o => o.value === savedSrc)
  ? savedSrc : "auto";

function currentSourceLang() {
  // Whichever element is currently visible is the source of truth at the
  // moment Start is pressed (or hints are generated).
  const v = document.body.classList.contains("debug-mode")
    ? sourceLangInput.value : sourceLangSel.value;
  return (v || "auto").trim();
}
inputSourceSel.value = localStorage.getItem(LS_INPUT) || "mic";
if (!inputSourceSel.value) inputSourceSel.value = "mic";  // stale saved value
// Shows the picked source's icon (CSS keys on it).
function syncInputSourceIcon() {
  inputSourceSel.parentElement.dataset.source = inputSourceSel.value;
}
syncInputSourceIcon();
sceneSeedInput.value = localStorage.getItem(LS_SCENE_SEED) || "";
sceneInput.value = localStorage.getItem(LS_SCENE) || "";
glossaryInput.value = localStorage.getItem(LS_GLOSSARY) || "";
// Debug mode shows the diagnostic badges (mic peak / asr session / tr
// counter). Off by default; toggling it just adds/removes a body class
// since CSS does the work (.debug-mode reveals .badge).
const debugOn = localStorage.getItem(LS_DEBUG) === "1";
debugModeInput.checked = debugOn;
document.body.classList.toggle("debug-mode", debugOn);
debugModeInput.addEventListener("change", () => {
  const on = debugModeInput.checked;
  document.body.classList.toggle("debug-mode", on);
  localStorage.setItem(LS_DEBUG, on ? "1" : "0");
});

// Large captions toggle. First-run default picked from UA (mobile → on,
// desktop → off); after that the localStorage value sticks regardless of
// device. Spoofing the UA via "request desktop site" flips the default
// for that visit, which is by design — same logic on the other dimension.
const savedFontLarge = localStorage.getItem(LS_FONT_LARGE);
const fontLargeDefault = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const fontLargeOn = savedFontLarge !== null ? savedFontLarge === "1" : fontLargeDefault;
fontLargeInput.checked = fontLargeOn;
document.body.classList.toggle("font-large", fontLargeOn);
fontLargeInput.addEventListener("change", () => {
  const on = fontLargeInput.checked;
  document.body.classList.toggle("font-large", on);
  localStorage.setItem(LS_FONT_LARGE, on ? "1" : "0");
});

// Backend dropdowns are populated dynamically from /api/backends so the user
// only sees options that are actually configured server-side (have an API
// key or a local binary). Saved choice restored if still present; otherwise
// the first available wins (browser-default for an empty value).
function populateBackendSelect(sel, items, savedValue) {
  sel.innerHTML = "";
  if (items.length === 0) {
    // No backend configured for this kind on the server side. Show a clear
    // disabled placeholder so the user sees they need to set a key/binary,
    // instead of getting a mysterious WS-close error after pressing Start.
    // Selected explicitly: a lone disabled option otherwise renders blank.
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("(none configured)");
    opt.disabled = true;
    opt.selected = true;
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.id;
    // Local models are listed before they're downloaded (ready: false);
    // picking one offers the download under the select.
    opt.textContent = it.ready === false ? t("{label} — not downloaded", { label: t(it.label) }) : t(it.label);
    opt.dataset.ready = it.ready === false ? "0" : "1";
    opt.dataset.context = it.context ? "1" : "0";
    opt.dataset.glossary = it.glossary ? "1" : "0";
    sel.appendChild(opt);
  }
  if (savedValue && [...sel.options].some(o => o.value === savedValue)) {
    sel.value = savedValue;
  } else {
    // No saved choice: default to something that can run right away.
    const usable = [...sel.options].find(o => o.dataset.ready === "1");
    if (usable) sel.value = usable.value;
  }
}

async function loadBackends() {
  let data;
  try {
    const res = await fetch("api/backends");
    data = await res.json();
  } catch (e) {
    console.error("failed to fetch /api/backends", e);
    return;
  }
  populateBackendSelect(asrBackendSel, data.asr || [], localStorage.getItem(LS_ASR));
  updateAsrModelHint();
  // Migrate old single "claude" value (pre-variant split) → claude-haiku.
  let savedTr = localStorage.getItem(LS_TR);
  if (savedTr === "claude") savedTr = "claude-haiku";
  populateBackendSelect(translateBackendSel, data.translate || [], savedTr);
  updateMtHint();
  applyContextUse();
  // Hide the topic/Research row entirely if no hints backend is configured.
  // Manually-filled Scene + Glossary fields stay — they work independently.
  if (!data.hints_available) {
    const row = document.getElementById("scene-seed-row");
    if (row) row.hidden = true;
  }
  renderWelcome();
}
loadBackends();

// Local models: one row per model with its state and a single action button.
// Rows are built once and updated in place, so polling during a download
// doesn't swap the button out from under a click.
const modelsSection = document.getElementById("models-section");
const modelsListEl = document.getElementById("models-list");
const mtModelsSection = document.getElementById("mt-models-section");
const mtModelsListEl = document.getElementById("mt-models-list");
const modelsDirEl = document.getElementById("models-dir");
const modelEls = new Map();  // id -> {status, bar, fill, btn}
const modelPrev = new Map();  // id -> {state, done, t} from the last poll
const modelsById = new Map();  // id -> latest /api/models entry
let localUnavailable = null;  // {kind, reason} when there's no local qwen_asr
let modelsPollTimer = null;
const asrModelHintEl = document.getElementById("asr-model-hint");
const asrModelHintText = asrModelHintEl.querySelector("span");
const asrModelHintBtn = asrModelHintEl.querySelector("button");

const MODEL_MISSING_STATUS = "download the speech-to-text model first";

function asrModelMissing() {
  return asrBackendSel.selectedOptions[0]?.dataset.ready === "0";
}

// Under the ASR select: when the picked local model isn't downloaded, say so
// and offer the download (with progress) right there.
function updateAsrModelHint() {
  // Backends loaded but none usable: the select only holds its placeholder.
  if (asrBackendSel.options.length > 0 && !asrBackendSel.value) {
    asrModelHintText.textContent = noBackendText();
    asrModelHintBtn.hidden = true;
    asrModelHintEl.classList.add("err");
    asrModelHintEl.hidden = false;
    return;
  }
  const m = modelsById.get(asrBackendSel.value);
  if (!asrModelMissing() || !m) {
    asrModelHintEl.hidden = true;
    if (statusMsg[0] === MODEL_MISSING_STATUS) setStatus("idle");
    return;
  }
  const pct = m.size ? Math.floor((m.done / m.size) * 100) : 0;
  let text;
  let btn = "";
  if (m.state === "downloading") {
    text = t("Downloading {pct}% of {size}…", { pct, size: fmtBytes(m.size) });
  } else if (m.state === "ready") {
    text = t("Downloaded — loading…");  // the select is about to refresh
  } else if (m.state === "error") {
    text = t("Download failed: {error}", { error: m.error });
    btn = t("Retry");
  } else {
    text = m.done > 0
      ? t("Partly downloaded · {pct}% of {size}", { pct, size: fmtBytes(m.size) })
      : t("Not downloaded yet · {size}", { size: fmtBytes(m.size) });
    btn = m.done > 0 ? t("Resume") : t("Download");
  }
  asrModelHintText.textContent = text;
  asrModelHintBtn.textContent = btn;
  asrModelHintBtn.hidden = !btn;
  asrModelHintEl.classList.toggle("err", m.state === "error");
  asrModelHintEl.hidden = false;
}
asrModelHintBtn.addEventListener("click", () => modelAction(asrBackendSel.value, "download"));

function fmtBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

async function modelAction(id, action) {
  const res = action === "delete"
    ? await fetch(`api/models/${id}`, { method: "DELETE" })
    : await fetch(`api/models/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) alert(data.error || `HTTP ${res.status}`);
  loadModels();
}

function modelLabel(m) {
  return m.from ? `${langName(m.from)} → ${langName(m.to)}` : m.label;
}

function modelEl(m) {
  let el = modelEls.get(m.id);
  if (el) return el;
  const item = document.createElement("div");
  item.className = "model-item";
  const name = document.createElement("span");
  name.className = "model-name";
  const status = document.createElement("span");
  status.className = "model-status";
  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.type = "button";
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (action === "delete" && !confirm(t("Delete {label} ({size})?", { label: modelLabel(m), size: fmtBytes(m.size) }))) return;
    if (action) modelAction(m.id, action);
  });
  const bar = document.createElement("div");
  bar.className = "model-bar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  // Latency / CPU trade-off for this model: qwen-asr's --stream-chunk-sec.
  // Smaller chunks show text sooner but re-run the model more often.
  const chunk = document.createElement("div");
  chunk.className = "slider-row model-chunk";
  const chunkInput = document.createElement("input");
  Object.assign(chunkInput, { type: "range", min: "1", max: "8", step: "0.5" });
  chunkInput.value = qwenChunkSec(m.id);
  const chunkValue = document.createElement("span");
  chunkValue.className = "slider-value";
  const showChunk = () => { chunkValue.textContent = `${chunkInput.value} s`; };
  chunkInput.addEventListener("input", () => {
    localStorage.setItem(LS_QWEN_CHUNK + m.id, chunkInput.value);
    showChunk();
  });
  showChunk();
  const ends = ["Lower latency", "Lower CPU"].map((label) => {
    const s = document.createElement("span");
    s.className = "slider-end";
    s.dataset.i18n = label;
    return s;
  });
  chunk.append(ends[0], chunkInput, ends[1], chunkValue);
  applyI18n(chunk);
  item.append(name, status, btn, bar, chunk);
  (m.from ? mtModelsListEl : modelsListEl).appendChild(item);
  el = { item, name, status, bar, fill, btn, chunk, chunkInput };
  modelEls.set(m.id, el);
  return el;
}

async function loadModels() {
  clearTimeout(modelsPollTimer);
  let data;
  try {
    data = await (await fetch("api/models")).json();
  } catch (e) {
    console.error("failed to fetch /api/models", e);
    return;
  }
  // Qwen rows only when the qwen_asr binary was found.
  const mt = data.mt || [];
  modelsSection.hidden = !data.available;
  mtModelsSection.hidden = mt.length === 0;
  modelsDirEl.hidden = modelsSection.hidden && mtModelsSection.hidden;
  localUnavailable = data.available ? null : { kind: data.unavailable_kind, reason: data.unavailable_reason || "" };
  if (data.available) for (const m of data.models) modelsById.set(m.id, m);
  updateAsrModelHint();  // its wording depends on localUnavailable
  modelsDirEl.textContent = t("Downloads go to {dir}", { dir: data.data_dir });
  for (const [id, el] of modelEls) {
    if (id.startsWith("mt-") && !mt.some((m) => m.id === id)) {
      el.item.remove();
      modelEls.delete(id);
    }
  }
  let busy = false;
  let changed = false;
  const now = performance.now();
  for (const m of [...(data.available ? data.models : []), ...mt]) {
    const el = modelEl(m);
    el.name.textContent = modelLabel(m);
    const prev = modelPrev.get(m.id);
    if (prev && prev.state !== m.state) changed = true;
    const pct = m.size ? Math.floor((m.done / m.size) * 100) : 0;
    let status = "";
    let action = "";
    switch (m.state) {
      case "ready":
        status = m.managed ? t("Ready") : t("Ready — from {env}", { env: m.env });
        action = m.managed ? "delete" : "";
        break;
      case "missing":
        status = t("{env} points to a missing directory: {dir}", { env: m.env, dir: m.dir });
        break;
      case "downloading": {
        busy = true;
        status = t("Downloading {pct}% · {done} / {size}", { pct, done: fmtBytes(m.done), size: fmtBytes(m.size) });
        if (prev && prev.state === "downloading" && now > prev.t) {
          const rate = ((m.done - prev.done) / (now - prev.t)) * 1000;
          if (rate > 0) status += ` · ${fmtBytes(rate)}/s`;
        }
        action = "cancel";
        break;
      }
      case "error":
        status = t("Failed: {error}", { error: m.error });
        action = "download";
        break;
      default:
        status = m.done > 0 ? t("Paused at {pct}%", { pct }) : t("Not downloaded");
        action = "download";
    }
    el.status.textContent = m.state === "downloading" ? status : `${fmtBytes(m.size)} · ${status}`;
    el.status.classList.toggle("err", m.state === "error" || m.state === "missing");
    el.bar.hidden = !(m.state === "downloading" || (m.state === "absent" && m.done > 0));
    el.fill.style.width = `${pct}%`;
    el.btn.hidden = !action;
    el.btn.dataset.action = action;
    el.btn.textContent = t({ download: m.done > 0 ? "Resume" : "Download", cancel: "Cancel", delete: "Delete" }[action] || "");
    el.chunk.hidden = m.state !== "ready" || Boolean(m.from);
    el.chunkInput.setAttribute("aria-label", t("{label}: latency vs. CPU", { label: m.label }));
    modelPrev.set(m.id, { state: m.state, done: m.done, t: now });
  }
  // A model that finished (or was deleted) changes the ASR dropdown.
  if (changed) loadBackends();
  if (busy) modelsPollTimer = setTimeout(loadModels, 1000);
  renderWelcome();
  updateMtHint();
}
loadModels();

// Local translation: the models the language pair needs, under the select.
const mtHintEl = document.getElementById("mt-model-hint");
const mtHintText = mtHintEl.querySelector("span");
const mtHintBtn = mtHintEl.querySelector("button");
const MT_MISSING_STATUS = "download the translation models first";
let mtRoute = null;  // latest /api/mt-route answer
let mtRouteSeq = 0;

function langName(code) {
  try {
    return new Intl.DisplayNames([document.documentElement.lang], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

function currentTargetLang() {
  return (targetLangInput.value || "Chinese (Simplified)").trim();
}

function mtModelsMissing() {
  return translateBackendSel.value === "local" && Boolean(mtRoute?.models?.some((m) => m.state !== "ready"));
}

async function updateMtHint() {
  if (translateBackendSel.value !== "local") {
    mtRoute = null;
    mtHintEl.hidden = true;
    return;
  }
  const seq = ++mtRouteSeq;
  const q = new URLSearchParams({ source: currentSourceLang(), target: currentTargetLang() });
  let data;
  try {
    data = await (await fetch(`api/mt-route?${q}`)).json();
  } catch (e) {
    console.error("failed to fetch /api/mt-route", e);
    return;
  }
  if (seq !== mtRouteSeq) return;  // the pair changed meanwhile
  mtRoute = data;
  renderMtHint();
}

function renderMtHint() {
  const r = mtRoute;
  if (!r || translateBackendSel.value !== "local") {
    mtHintEl.hidden = true;
    return;
  }
  const models = r.models || [];
  const missing = models.filter((m) => m.state !== "ready");
  const sum = (list, key) => list.reduce((n, m) => n + m[key], 0);
  let text;
  let btn = "";
  let err = false;
  let info = false;  // grey: nothing to do
  if (!r.target) {
    text = t("No local model translates into “{lang}”.", { lang: currentTargetLang() });
    err = true;
  } else if (!r.source) {
    text = t("No local model translates from {lang}.", { lang: t(currentSourceLang()) });
    err = true;
  } else if (!r.models) {
    text = t("No local models for {src} → {tgt}.", { src: langName(r.source), tgt: langName(r.target) });
    err = true;
  } else if (r.source === "auto") {
    text = t("With Auto-detect, each sentence's language is guessed from its script (Latin script counts as English), and only languages with downloaded models are translated. Pick the source language to download its models.");
  } else if (models.length === 0) {
    text = t("Source and target are the same language: captions show the transcript.");
    info = true;
  } else {
    const path = [r.source, ...models.map((m) => m.to)].map(langName).join(" → ");
    const failed = missing.find((m) => m.state === "error");
    if (missing.some((m) => m.state === "downloading")) {
      const size = sum(missing, "size");
      text = t("Downloading {pct}% of {size}…", { pct: Math.floor((sum(missing, "done") / size) * 100), size: fmtBytes(size) });
    } else if (failed) {
      text = t("Download failed: {error}", { error: failed.error });
      btn = t("Retry");
      err = true;
    } else if (missing.length) {
      text = t("Translation models for {path} ({size})", { path, size: fmtBytes(sum(missing, "size")) });
      btn = t("Download");
    } else {
      text = t("Models from Firefox: {path}", { path });
      info = true;
    }
  }
  mtHintText.textContent = text;
  mtHintBtn.textContent = btn;
  mtHintBtn.hidden = !btn;
  mtHintEl.classList.toggle("err", err);
  mtHintEl.classList.toggle("info", info);
  mtHintEl.hidden = false;
  if (!mtModelsMissing() && statusMsg[0] === MT_MISSING_STATUS) setStatus("idle");
}

mtHintBtn.addEventListener("click", async () => {
  const todo = (mtRoute?.models || []).filter((m) => m.state === "absent" || m.state === "error");
  const results = await Promise.all(todo.map((m) => fetch(`api/models/${m.id}/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then(async (res) => (res.ok ? null : (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`))));
  const failed = results.find(Boolean);
  if (failed) alert(failed);
  loadModels();
});

let mtHintTimer = null;
function updateMtHintSoon() {
  clearTimeout(mtHintTimer);
  mtHintTimer = setTimeout(updateMtHint, 300);
}

sceneSeedInput.addEventListener("input", () => {
  localStorage.setItem(LS_SCENE_SEED, sceneSeedInput.value);
});
sceneInput.addEventListener("input", () => {
  localStorage.setItem(LS_SCENE, sceneInput.value);
});
glossaryInput.addEventListener("input", () => {
  localStorage.setItem(LS_GLOSSARY, glossaryInput.value);
});

async function generateHintsFromScene() {
  const desc = sceneSeedInput.value.trim();
  if (!desc) {
    hintStatusEl.textContent = t("Type a topic first.");
    hintStatusEl.className = "muted err";
    return;
  }
  hintGenerateBtn.disabled = true;
  hintStatusEl.textContent = t("Researching (may take 5–15s)…");
  hintStatusEl.className = "muted busy";
  try {
    const res = await fetch("api/hints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: desc,
        // Pin glossary language to source_lang: it is matched against the
        // source transcript (translator, Gemini custom vocabulary), so terms
        // in another language are wasted. "auto" leaves Claude to infer from
        // description.
        source_lang: currentSourceLang(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const scene = (data.scene || "").trim();
    const glossary = (data.glossary || "").trim();
    if (!scene && !glossary) throw new Error("empty response");
    sceneInput.value = scene;
    glossaryInput.value = glossary;
    localStorage.setItem(LS_SCENE, scene);
    localStorage.setItem(LS_GLOSSARY, glossary);
    const n = data.searches_used;
    const searches = !n ? "" : n === 1 ? t(" (1 web search)") : t(" ({n} web searches)", { n });
    const via = data.backend
      ? t(" via {backend}", { backend: data.backend.charAt(0).toUpperCase() + data.backend.slice(1) })
      : "";
    hintStatusEl.textContent = t(
      "Generated{via}: scene ({scene} chars) + glossary ({glossary} chars){searches}. Edit below as needed.",
      { via, scene: scene.length, glossary: glossary.length, searches });
    hintStatusEl.className = "muted ok";
  } catch (e) {
    console.error(e);
    hintStatusEl.textContent = t("Failed: {error}", { error: e.message });
    hintStatusEl.className = "muted err";
  } finally {
    applyContextUse();
  }
}

hintGenerateBtn.addEventListener("click", generateHintsFromScene);

inputSourceSel.addEventListener("change", () => {
  localStorage.setItem(LS_INPUT, inputSourceSel.value);
  syncInputSourceIcon();
});
asrBackendSel.addEventListener("change", () => {
  localStorage.setItem(LS_ASR, asrBackendSel.value);
  updateAsrModelHint();
  applyContextUse();
  renderWelcome();
});

function qwenChunkSec(modelId) {
  return localStorage.getItem(LS_QWEN_CHUNK + modelId) || "2";
}

translateBackendSel.addEventListener("change", () => {
  localStorage.setItem(LS_TR, translateBackendSel.value);
  updateMtHint();
  applyContextUse();
  renderWelcome();
});

targetLangInput.addEventListener("input", () => {
  localStorage.setItem(LS_LANG, targetLangInput.value);
  updateMtHintSoon();
  renderWelcome();
});
sourceLangSel.addEventListener("change", () => {
  localStorage.setItem(LS_SRC, sourceLangSel.value);
  updateMtHint();
  renderWelcome();
  // Keep input synced so flipping into debug mode doesn't lose the choice.
  sourceLangInput.value = sourceLangSel.value;
});
sourceLangInput.addEventListener("input", () => {
  localStorage.setItem(LS_SRC, sourceLangInput.value);
  // Mirror into select only when the typed value is one of its options —
  // exotic values (Cantonese / Thai / ...) leave the select on auto.
  if ([...sourceLangSel.options].some(o => o.value === sourceLangInput.value)) {
    sourceLangSel.value = sourceLangInput.value;
  }
  updateMtHintSoon();
  renderWelcome();
});

// Settings tabs; the last one opened is remembered.
const settingsTabBtns = [...document.querySelectorAll(".settings-tabs button")];
const settingsTabs = [...document.querySelectorAll(".settings-tab")];
function showSettingsTab(name) {
  const btn = settingsTabBtns.find(b => b.dataset.tab === name && !b.hidden);
  if (!btn) name = "session";
  for (const b of settingsTabBtns) {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const t of settingsTabs) t.classList.toggle("active", t.dataset.tab === name);
}
for (const b of settingsTabBtns) {
  b.addEventListener("click", () => {
    showSettingsTab(b.dataset.tab);
    localStorage.setItem(LS_SETTINGS_TAB, b.dataset.tab);
  });
}
showSettingsTab(localStorage.getItem(LS_SETTINGS_TAB) || "session");

settingsToggleBtn.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  document.body.classList.toggle("settings-open", !settingsPanel.hidden);
});

let settingsLocked = false;
const contextNoteEl = document.getElementById("context-note");

function lockSettings(locked) {
  settingsLocked = locked;
  targetLangInput.disabled = locked;
  sourceLangSel.disabled = locked;
  sourceLangInput.disabled = locked;
  inputSourceSel.disabled = locked;
  asrBackendSel.disabled = locked;
  translateBackendSel.disabled = locked;
  for (const r of modelsListEl.querySelectorAll('input[type="range"]')) r.disabled = locked;
  applyContextUse();
}

// Grey out the scene/glossary/research rows the picked backends don't use
// (LLM translators use both, Gemini Live the glossary).
function applyContextUse() {
  const tr = translateBackendSel.selectedOptions[0]?.dataset.context === "1";
  const asr = asrBackendSel.selectedOptions[0]?.dataset.glossary === "1";
  const uses = { scene: tr, glossary: tr || asr, context: tr || asr };
  for (const row of document.querySelectorAll("#settings-panel [data-uses]")) {
    const used = uses[row.dataset.uses];
    row.classList.toggle("unused", !used);
    for (const el of row.querySelectorAll("input, textarea, button")) el.disabled = settingsLocked || !used;
  }
  contextNoteEl.hidden = tr;
  contextNoteEl.textContent = asr
    ? t("The scene summary is only used with LLM translation (Claude, DeepSeek, Gemini, …).")
    : t("These are only used with LLM translation (Claude, DeepSeek, Gemini, …).");
}

let ws = null;
let audioCtx = null;
let stream = null;
let workletNode = null;
let sourceNode = null;
let muteGain = null;
let analyserNode = null;
let vuRafId = null;
let recording = false;
let pcmRate = 16000;  // what the worklet sends; sizes the reconnect backlog

// Unexpected closes reopen the session on the same capture; 1003 (config
// refused) is final. A transcript or RECONNECT_STABLE_MS of uptime resets the
// failure count.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const RECONNECT_STABLE_MS = 30000;
// Audio captured while disconnected, replayed after the next config.
const RECONNECT_BACKLOG_SEC = 15;
let wsReady = false;  // config sent; audio may flow
let reconnectTimer = null;
let reconnectFailures = 0;
let audioBacklog = [];
let audioBacklogBytes = 0;

let asrSessionCount = 0;
let translationsDone = 0;
let translationsPending = 0;
let lastServerPeak = 0;

// Sentence map: sid -> {sid, src, dst, srcDone, dstDone, archived}
const sentences = new Map();
// Which sid is currently shown in the PREV zone. Sentences live in three
// places linearly: CURRENT zone (in-flight) → PREV zone (just finalized,
// stable, animated slide-in) → HISTORY list (older). prev_revised events
// target one of these.
let prevSlotSid = null;

function setStatus(msg, vars) {
  statusMsg = [msg, vars];
  statusEl.textContent = t(msg, vars);
}

function setToggleState(rec) {
  toggleBtn.querySelector(".icon").textContent = rec ? "■" : "▶";
  toggleBtn.querySelector(".label").textContent = rec ? t("Stop") : t("Start");
  toggleBtn.classList.toggle("recording", rec);
}

function updateBadges() {
  badgeMicEl.textContent = `mic ${lastServerPeak || "—"}`;
  badgeMicEl.classList.toggle("active", lastServerPeak > 1000);
  badgeMicEl.classList.toggle("warn", lastServerPeak > 0 && lastServerPeak <= 500);
  badgeAsrEl.textContent = `asr ${asrSessionCount}`;
  badgeAsrEl.classList.toggle("active", asrSessionCount > 0 && recording);
  badgeTranslateEl.textContent = `tr ${translationsDone}/${translationsPending + translationsDone}`;
  badgeTranslateEl.classList.toggle("active", translationsPending > 0);
}

function startVU() {
  if (!analyserNode) return;
  const buf = new Float32Array(analyserNode.fftSize);
  let smoothed = 0;
  const tick = () => {
    if (!analyserNode) return;
    analyserNode.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
    }
    // Log-scaled meter (speech amplitudes are tiny on a linear scale). Fast
    // rise (α=0.9) so spikes are visible; slow decay (α=0.15) so the eye can
    // read them. Both branches must compare and blend in the same scale —
    // mixing linear `peak` into the rise branch with log `smoothed` made
    // the rise branch fire only on very loud sounds and then yank the bar
    // *down* to the linear value.
    const target = Math.min(1, Math.max(0, (Math.log10(peak + 0.001) + 3) / 3));
    smoothed = target > smoothed
      ? target * 0.9 + smoothed * 0.1
      : smoothed * 0.85 + target * 0.15;
    vuFillEl.style.width = `${Math.min(100, smoothed * 100)}%`;
    vuRafId = requestAnimationFrame(tick);
  };
  vuRafId = requestAnimationFrame(tick);
}

function stopVU() {
  if (vuRafId) cancelAnimationFrame(vuRafId);
  vuRafId = null;
  vuFillEl.style.width = "0%";
}

function getOrCreate(sid) {
  let s = sentences.get(sid);
  if (!s) {
    s = {
      sid, src: "", dst: "",
      srcDone: false, dstDone: false, archived: false,
      promoted: false,  // moved to PREV (in sid order, see promoteReady)
      currentRev: 0,    // latest revision known for this sentence's translation
      // Two-phase revision rendering: streaming chunks for the FIRST
      // revision go straight into `dst` so the user gets feedback as
      // soon as Claude starts emitting tokens. Once `dst` has any
      // content, subsequent revisions buffer their chunks into
      // `pendingDst` (invisible) and atomically swap on `translation_done`.
      // This eliminates the "clear → typewriter → clear → typewriter"
      // flicker we used to see every PARTIAL_INTERVAL_SEC.
      pendingDst: "",
      usePending: false,
    };
    sentences.set(sid, s);
  }
  return s;
}

function render() {
  // CURRENT zone shows whatever sentence is "live" right now. With the
  // prev zone broken out, current is the lowest sid that is unarchived
  // AND not currently in the prev slot (so we don't render the same
  // sentence in two zones). Falls back to the newest unarchived.
  // Translations finish out of order, so a sentence can be done yet still
  // wait here for an earlier one; anything not yet promoted counts as live.
  let current = null;
  let newestUnarchived = null;
  for (const [, s] of sentences) {
    if (s.archived) continue;
    if (s.sid === prevSlotSid) continue;
    if (!s.promoted) {
      if (current === null || s.sid < current.sid) current = s;
    }
    if (newestUnarchived === null || s.sid > newestUnarchived.sid) newestUnarchived = s;
  }
  const display = current || newestUnarchived;
  transcriptEl.textContent = display ? display.src : "";
  translationEl.textContent = display ? display.dst : "";
  // Sentences after the one shown are still waiting for their translation
  // (or still being spoken); show their source so it is not held back
  // behind the translation in progress.
  let latest = "";
  if (display) {
    for (const [, s] of sentences) {
      if (s.archived || s.sid === prevSlotSid || s.sid <= display.sid) continue;
      if (!s.promoted) {
        const next = s.src.trim();
        // Space between sentences, except around CJK / full-width text.
        const cjk = /[　-鿿＀-￯]/;
        const sep = !latest || !next || cjk.test(latest.slice(-1)) || cjk.test(next[0]) ? "" : " ";
        latest += sep + next;
      }
    }
  }
  latest = latest.trim();
  latestEl.textContent = latest;
  latestEl.hidden = latest === "";
}

// Promote a finalized sentence into the PREV zone. The sentence currently
// in PREV (if any) gets pushed to history (no animation — user said the
// prev → history transition can be instant). PREV gets the new content
// with a slide-up-from-below animation looking like the LIVE card (which
// sits at the very bottom) scrolled up into the prev slot just above it.
function promoteToPrev(s) {
  if (prevSlotSid !== null && prevSlotSid !== s.sid) {
    const oldPrev = sentences.get(prevSlotSid);
    if (oldPrev) {
      appendToHistory(oldPrev);
      oldPrev.archived = true;
    }
  }
  prevSlotSid = s.sid;
  prevTranscriptEl.textContent = s.src.trim();
  prevTranslationEl.textContent = s.dst.trim();
  prevCardEl.dataset.sid = String(s.sid);
  prevCardEl.hidden = false;
  // Restart slide-in animation by toggling the class with a forced reflow.
  prevCardEl.classList.remove("entering");
  void prevCardEl.offsetWidth;
  prevCardEl.classList.add("entering");
}

// Promote the oldest unpromoted sentences while they are finished. A later
// sentence whose translation finished first waits for the earlier ones.
function promoteReady() {
  for (;;) {
    let next = null;
    for (const [, s] of sentences) {
      if (s.archived || s.promoted) continue;
      if (next === null || s.sid < next.sid) next = s;
    }
    if (!next || !next.srcDone || !next.dstDone) return;
    next.promoted = true;
    promoteToPrev(next);
  }
}

function appendToHistory(s) {
  const item = document.createElement("div");
  item.className = "history-item";
  item.dataset.sid = String(s.sid);
  const srcDiv = document.createElement("div");
  srcDiv.className = "src";
  srcDiv.textContent = s.src.trim();
  const dstDiv = document.createElement("div");
  dstDiv.className = "dst";
  dstDiv.textContent = s.dst.trim();
  item.append(srcDiv, dstDiv);
  // Append (not prepend) so DOM order is chronological — copy-paste then
  // gives oldest→newest, matching the visual top-to-bottom reading order.
  // Anchor scroll: if the user was already at the bottom, follow the
  // newest item; otherwise leave their scroll position alone so they can
  // keep reading older entries without being yanked away.
  const wasAtBottom =
    historyEl.scrollHeight - historyEl.clientHeight - historyEl.scrollTop < 4;
  historyEl.append(item);
  if (wasAtBottom) historyEl.scrollTop = historyEl.scrollHeight;
}

function applyPrevRevision(sid, text) {
  const s = sentences.get(sid);
  const before = s ? s.dst : "(unknown)";
  if (s) s.dst = text;
  console.log(
    `[prev_revised] sid=${sid}\n  before: ${before}\n  after:  ${text}`
  );
  // Where does this sid live? Three possibilities, in order of likelihood:
  // (1) PREV zone — most common (paired-translation revises the most
  //     recently finalized sentence, which is exactly what's in PREV).
  // (2) HISTORY list — if the sentence has already been pushed out of
  //     PREV by a newer sentence finalizing.
  // (3) Still in CURRENT zone — rare but possible if the revision races
  //     ahead of translation_done.
  if (prevSlotSid === sid) {
    prevTranslationEl.textContent = text.trim();
    prevTranslationEl.classList.add("revised");
    setTimeout(() => {
      prevTranslationEl.classList.remove("revised");
      prevTranslationEl.classList.add("revised-faded");
      setTimeout(() => prevTranslationEl.classList.remove("revised-faded"), 4000);
    }, 1500);
    return;
  }
  const item = historyEl.querySelector(`.history-item[data-sid="${sid}"]`);
  if (item) {
    const dstEl = item.querySelector(".dst");
    if (dstEl) {
      dstEl.textContent = text.trim();
      dstEl.classList.add("revised");
      setTimeout(() => {
        dstEl.classList.remove("revised");
        dstEl.classList.add("revised-faded");
        setTimeout(() => dstEl.classList.remove("revised-faded"), 4000);
      }, 1500);
    }
    return;
  }
  // Fall through: still in CURRENT — re-render picks up s.dst.
  render();
}

async function acquireStream(source) {
  if (source === "screen") {
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error(t("Tab capture isn't supported in this browser."));
    }
    setStatus("pick a tab/window with audio…");
    // Chrome requires video:true; many implementations refuse audio-only.
    const captured = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        // Tab audio is already a clean digital signal — disable processing
        // that would distort it.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    // Diagnostic: log everything the browser returned, before we touch it.
    const allTracks = captured.getTracks().map(t => ({
      kind: t.kind,
      label: t.label,
      readyState: t.readyState,
      muted: t.muted,
      enabled: t.enabled,
      settings: t.getSettings?.(),
    }));
    console.log("getDisplayMedia returned tracks:", allTracks);

    // Stop the video tracks we don't need, then build a fresh audio-only
    // MediaStream. Chrome's createMediaStreamSource can stall if the original
    // stream still has stopped video tracks attached.
    captured.getVideoTracks().forEach(t => t.stop());
    const audioTracks = captured.getAudioTracks();
    if (audioTracks.length === 0) {
      captured.getTracks().forEach(t => t.stop());
      throw new Error(
        t("No audio track delivered.") + " " +
        (navigator.userAgent.includes("Firefox") && navigator.userAgent.includes("Linux")
          ? t("Firefox on Linux Wayland can't capture tab audio. Try Chrome or Chromium, or route system audio through a PipeWire virtual mic and use Mic.")
          : t("Pick a tab (not \u201cEntire screen\u201d or \u201cWindow\u201d) and turn on \u201cShare tab audio\u201d."))
      );
    }
    console.log("tab audio acquired:",
      audioTracks.map(t => ({label: t.label, settings: t.getSettings?.()})));
    return new MediaStream(audioTracks);
  }
  setStatus("requesting mic…");
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // For low-SNR scenarios (phone speaker captured by laptop mic)
      // browser-side processing helps a lot more than it hurts.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

async function start() {
  // Nothing to run (no backend at all, or the picked model isn't downloaded):
  // point at the hint under the select instead of failing server-side.
  if (!asrBackendSel.value || asrModelMissing()) {
    setStatus(asrBackendSel.value ? MODEL_MISSING_STATUS : "no speech-to-text backend configured");
    if (welcomeEl.hidden) openSettings("backends");
    return;
  }
  if (mtModelsMissing()) {
    setStatus(MT_MISSING_STATUS);
    if (welcomeEl.hidden) openSettings("backends");
    return;
  }
  try {
    const inputSource = inputSourceSel.value || "mic";
    stream = await acquireStream(inputSource);
    // If the user stops sharing from the browser's picker (Tab mode), the
    // tracks end and we should stop too.
    stream.getAudioTracks().forEach(t => {
      t.addEventListener("ended", () => {
        if (recording) stop();
      });
    });

    // Each ASR backend has its own preferred input rate. OpenAI Realtime's
    // minimum is 24kHz; everyone else (Gemini Live, Qwen, Voxtral) wants
    // 16kHz natively. Sending the right rate from the browser avoids
    // server-side resampling and — more importantly — gives 24kHz-only
    // backends real high-frequency content from the mic instead of fake
    // interpolated upsampling.
    const targetRate =
      (asrBackendSel.value === "openai-realtime") ? 24000 : 16000;
    try {
      audioCtx = new AudioContext({ sampleRate: targetRate });
    } catch {
      audioCtx = new AudioContext();
    }
    console.log(`AudioContext: ${audioCtx.sampleRate}Hz (worklet will resample to ${targetRate}Hz)`);
    await audioCtx.audioWorklet.addModule("static/pcm-worklet.js");
    sourceNode = audioCtx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(audioCtx, "pcm-worklet", {
      processorOptions: { targetRate },
    });
    sourceNode.connect(workletNode);
    muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    workletNode.connect(muteGain).connect(audioCtx.destination);
    // VU meter taps the mic source directly (independent of worklet path).
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserNode.smoothingTimeConstant = 0.5;
    sourceNode.connect(analyserNode);
    startVU();

    pcmRate = targetRate;
    workletNode.port.onmessage = (e) => sendAudio(e.data);
    recording = true;
    setToggleState(true);
    lockSettings(true);
    renderWelcome();
    connect();
  } catch (err) {
    console.error(err);
    setStatus("error: {message}", { message: err.message });
    await stop();
  }
}

// Until the socket has its config, audio goes to the bounded backlog.
function sendAudio(buf) {
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(buf);
    return;
  }
  audioBacklog.push(buf);
  audioBacklogBytes += buf.byteLength;
  const cap = RECONNECT_BACKLOG_SEC * pcmRate * 2;  // 16-bit mono
  while (audioBacklogBytes > cap && audioBacklog.length > 1) {
    audioBacklogBytes -= audioBacklog.shift().byteLength;
  }
}

function clearAudioBacklog() {
  audioBacklog = [];
  audioBacklogBytes = 0;
}

// Open a session socket; called by start() and by the reconnect timer.
function connect() {
  setStatus(reconnectFailures ? "reconnecting…" : "connecting…");
  // Resolve the /ws endpoint relative to the page's base URI so the app works
  // under a non-root path (reverse-proxy subpath), not just at the domain root.
  const wsBase = new URL("ws", document.baseURI);
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${wsProto}//${wsBase.host}${wsBase.pathname}`);
  sock.binaryType = "arraybuffer";
  ws = sock;
  wsReady = false;
  let openedAt = 0;
  let gotTranscript = false;
  let lastError = "";

  sock.onopen = () => {
    openedAt = Date.now();
    sock.send(JSON.stringify({
      type: "config",
      target_lang: (targetLangInput.value || "Chinese (Simplified)").trim(),
      source_lang: currentSourceLang(),
      scene: sceneInput.value.trim(),
      glossary: glossaryInput.value.trim(),
      asr_backend: asrBackendSel.value || "gemini",
      translate_backend: translateBackendSel.value || "gemini",
      qwen_chunk_sec: Number(qwenChunkSec(asrBackendSel.value)),
    }));
    // Tag <body> so CSS can hide the redundant transcript line in
    // passthrough mode (when we mirror src into the translation slot).
    document.body.dataset.translateBackend =
        translateBackendSel.value || "gemini";
    // The server buffers audio that arrives right behind the config.
    for (const buf of audioBacklog) sock.send(buf);
    clearAudioBacklog();
    wsReady = true;
  };

  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case "ready":
        setStatus("listening");
        break;
      case "transcript": {
        gotTranscript = true;
        const s = getOrCreate(msg.sid);
        s.src += msg.text;
        render();
        break;
      }
      case "transcript_replace": {
        // Used by backends that stream a cumulative transcript that
        // revises itself mid-segment (DashScope qwen3-asr-flash-realtime).
        // Overwrite src wholesale instead of appending.
        gotTranscript = true;
        const s = getOrCreate(msg.sid);
        s.src = msg.text;
        render();
        break;
      }
      case "transcript_done": {
        const s = getOrCreate(msg.sid);
        s.srcDone = true;
        render();
        break;
      }
      case "translation_revision": {
        // A new revision (partial or final) starts.
        //   First revision (dst still empty): stream chunks directly so
        //   the user sees translation tokens flow in as Claude emits them.
        //   Subsequent revisions: buffer in pendingDst, atomically swap on
        //   translation_done — keeps the visible dst stable, no flicker.
        const s = getOrCreate(msg.sid);
        if (msg.rev >= s.currentRev) {
          s.currentRev = msg.rev;
          if (s.dst) {
            s.usePending = true;
            s.pendingDst = "";
          } else {
            s.usePending = false;
          }
          render();
        }
        break;
      }
      case "translation": {
        const s = getOrCreate(msg.sid);
        // Drop chunks from a stale revision that was cancelled/superseded.
        if (msg.rev != null && msg.rev !== s.currentRev) break;
        if (s.usePending) {
          // Invisible accumulation — no render() until done-swap.
          s.pendingDst += msg.text;
        } else {
          s.dst += msg.text;
          render();
        }
        break;
      }
      case "translation_done": {
        const s = getOrCreate(msg.sid);
        // Stale done — ignore.
        if (msg.rev != null && msg.rev !== s.currentRev) break;
        // Atomic swap: replace the visible dst with the buffered version,
        // but ONLY if the upstream stream succeeded. msg.ok === false
        // means Claude / Gemini raised mid-stream (502, network, etc.) —
        // the pendingDst is empty or half-formed and would clobber the
        // previously-shown good translation. Discard it instead.
        if (s.usePending) {
          if (msg.ok !== false) {
            s.dst = s.pendingDst;
            render();
          } else {
            console.log(
              `[translation_done] sid=${msg.sid} rev=${msg.rev} failed; keeping previous dst`
            );
          }
          s.pendingDst = "";
          s.usePending = false;
        }
        // Only the FINAL revision locks the sentence. Partial revs keep
        // the sentence alive for more updates.
        if (msg.final) {
          s.dstDone = true;
          translationsDone++;
          translationsPending = Math.max(0, translationsPending - 1);
          updateBadges();
          // Promote finished sentences to PREV in sid order (with slide-in
          // animation); the old PREV gets pushed to history.
          promoteReady();
          render();
        }
        break;
      }
      case "translation_start":
        translationsPending++;
        updateBadges();
        break;
      case "prev_revised":
        // Claude (paired-translation) revised the previous sentence's
        // translation in light of the new sentence. Update wherever it
        // currently lives (history list or live captions).
        if (msg.sid != null && typeof msg.text === "string") {
          applyPrevRevision(msg.sid, msg.text);
        }
        break;
      case "asr_session": {
        // asr_session events: {state: "open"|"reset"|"go_away"}.
        // Status bar stays at "listening" — the per-turn counter was
        // diagnostic noise for normal users (Gemini Live increments it
        // every sentence). The debug badge still reflects the count.
        if (msg.state === "open") asrSessionCount++;
        updateBadges();
        break;
      }
      case "audio_stats":
        // {peak, chunks_per_sec}
        lastServerPeak = msg.peak || 0;
        updateBadges();
        break;
      case "error":
        lastError = msg.message;
        setStatus("error: {message}", { message: msg.message });
        badgeAsrEl.classList.add("error");
        console.error("server error:", msg.message);
        break;
    }
  };

  sock.onerror = (e) => console.error("ws error", e);
  sock.onclose = async (e) => {
    if (ws !== sock) return;
    ws = null;
    wsReady = false;
    if (!recording) return;
    if (gotTranscript || (openedAt && Date.now() - openedAt >= RECONNECT_STABLE_MS)) {
      reconnectFailures = 0;
    }
    const reason = e.reason || lastError;
    // A socket that never opened (server down, no network) retries forever.
    const n = RECONNECT_DELAYS_MS.length;
    if (e.code === 1003 || (openedAt && reconnectFailures >= n)) {
      await stop();
      // A session the server refused carries its reason; stop() resets the
      // status, so set it afterwards.
      if (reason) setStatus("error: {message}", { message: reason });
      else setStatus("disconnected");
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectFailures, n - 1)];
    reconnectFailures++;
    console.warn(`ws closed (code ${e.code}${reason ? `, ${reason}` : ""}); reconnecting in ${delay} ms`);
    retireSentences();
    translationsPending = 0;
    updateBadges();
    if (reason) setStatus("error: {message}; retrying in {s}s…", { message: reason, s: delay / 1000 });
    else setStatus("disconnected, retrying in {s}s…", { s: delay / 1000 });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (recording) connect();
    }, delay);
  };
}

// Move on-screen sentences into history and drop their state: each
// connection restarts sids at 0, so stale entries would catch new sentences.
function retireSentences() {
  const onScreen = [...sentences.values()]
    .filter((s) => !s.archived && (s.sid === prevSlotSid || s.src.trim()))
    .sort((a, b) => a.sid - b.sid);
  for (const s of onScreen) appendToHistory(s);
  prevCardEl.hidden = true;
  prevCardEl.classList.remove("entering");
  prevTranscriptEl.textContent = "";
  prevTranslationEl.textContent = "";
  prevSlotSid = null;
  sentences.clear();
  for (const item of historyEl.querySelectorAll(".history-item[data-sid]")) {
    item.removeAttribute("data-sid");
  }
  transcriptEl.textContent = "";
  translationEl.textContent = "";
  latestEl.textContent = "";
  latestEl.hidden = true;
}

async function stop() {
  recording = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectFailures = 0;
  clearAudioBacklog();
  stopVU();
  if (workletNode) {
    workletNode.port.onmessage = null;
    try { workletNode.disconnect(); } catch {}
    workletNode = null;
  }
  if (analyserNode) {
    try { analyserNode.disconnect(); } catch {}
    analyserNode = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch {}
    sourceNode = null;
  }
  if (muteGain) {
    try { muteGain.disconnect(); } catch {}
    muteGain = null;
  }
  if (audioCtx) {
    try { await audioCtx.close(); } catch {}
    audioCtx = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (ws) {
    // Our own close: skip onclose, which reports server-side disconnects.
    ws.onclose = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  wsReady = false;
  retireSentences();
  setToggleState(false);
  lockSettings(false);
  setStatus("idle");
  asrSessionCount = 0;
  translationsDone = 0;
  translationsPending = 0;
  lastServerPeak = 0;
  badgeAsrEl.classList.remove("error", "active", "warn");
  updateBadges();
  renderWelcome();
}

toggleBtn.addEventListener("click", () => {
  if (recording) stop(); else start();
});

clearBtn.addEventListener("click", () => {
  historyEl.innerHTML = "";
  sentences.clear();
  transcriptEl.textContent = "";
  translationEl.textContent = "";
  latestEl.textContent = "";
  latestEl.hidden = true;
  prevTranscriptEl.textContent = "";
  prevTranslationEl.textContent = "";
  prevCardEl.hidden = true;
  prevCardEl.classList.remove("entering");
  prevSlotSid = null;
  renderWelcome();
});

// ---------- Pop-out captions (Document Picture-in-Picture) ----------

// The caption stack node itself moves into the PiP window and back, so the
// element references above stay valid. Chrome / Edge only.
const pipBtn = document.getElementById("pip");
const pipNoteEl = document.getElementById("pip-note");
const captionStackEl = document.getElementById("caption-stack");
// Mirrored to the PiP body (welcome-shown / settings-open would hide the stack).
const PIP_BODY_CLASSES = ["font-large", "debug-mode"];
let pipWindow = null;

function syncPipBody() {
  if (!pipWindow) return;
  const body = pipWindow.document.body;
  for (const c of PIP_BODY_CLASSES) body.classList.toggle(c, document.body.classList.contains(c));
  if (document.body.dataset.translateBackend) {
    body.dataset.translateBackend = document.body.dataset.translateBackend;
  }
}
new MutationObserver(syncPipBody).observe(document.body, {
  attributes: true, attributeFilter: ["class", "data-translate-backend"],
});

async function openPip() {
  // Fits both cards; a shorter window gets subtitle mode.
  const win = await window.documentPictureInPicture.requestWindow({ width: 640, height: 260 });
  const link = win.document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("static/style.css", document.baseURI).href;
  win.document.head.append(link);
  win.document.title = "LiveSub";
  pipWindow = win;
  syncPipBody();
  win.document.body.append(captionStackEl);
  pipNoteEl.hidden = false;
  pipBtn.classList.add("active");
  // Closed from its own button, or the opener navigated away.
  win.addEventListener("pagehide", () => {
    if (pipWindow !== win) return;
    pipWindow = null;
    pipNoteEl.before(captionStackEl);
    pipNoteEl.hidden = true;
    pipBtn.classList.remove("active");
  });
}

if ("documentPictureInPicture" in window) {
  pipBtn.hidden = false;
  pipBtn.addEventListener("click", async () => {
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    try {
      await openPip();
    } catch (err) {
      console.error(err);
      setStatus("error: {message}", { message: err.message });
    }
  });
  document.getElementById("pip-return").addEventListener("click", () => pipWindow?.close());
}

// ---------- Welcome card ----------

// Shown in the caption area while idle with nothing captioned yet: what's
// missing before Start can work (no backend, or a model to download), or a
// short how-to once everything is ready.
const welcomeEl = document.getElementById("welcome");
const welcomeCard = welcomeEl.querySelector(".welcome-card");
let welcomeKey = "";  // what the card shows; it's rebuilt only when this changes
let welcomeDl = null;  // id -> live parts of each model row, updated in place

function h(tag, props, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function openSettings(tab) {
  if (settingsPanel.hidden) settingsToggleBtn.click();
  showSettingsTab(tab);
}

function settingsLink(text, tab) {
  const b = h("button", { type: "button", className: "link" }, text);
  b.addEventListener("click", () => openSettings(tab));
  return b;
}

function renderWelcome() {
  const show = asrBackendSel.options.length > 0 && !recording &&
    historyEl.children.length === 0 && sentences.size === 0;
  welcomeEl.hidden = !show;
  document.body.classList.toggle("welcome-shown", show);
  if (!show) return;
  if (!asrBackendSel.value) {
    showWelcome(`none:${localUnavailable?.kind}:${localUnavailable?.reason}`, welcomeNoBackend);
    return;
  }
  if (asrModelMissing() && modelsById.has(asrBackendSel.value)) {
    showWelcome("download", welcomeDownload);
    updateWelcomeDownload();
    return;
  }
  // Keyed on what the summary shows, so edits in Settings refresh it.
  const summary = welcomeSummary();
  showWelcome(`ready:${summary.join("\n")}`, () => welcomeReady(summary));
}

function showWelcome(key, build) {
  if (key === welcomeKey) return;
  welcomeKey = key;
  welcomeDl = null;
  welcomeCard.replaceChildren(...build());
}

// No speech-to-text at all. With the qwen binary packaged, that's a platform
// without one, or a QWEN_ASR_BIN in .env that points nowhere.
function noBackendText() {
  if (localUnavailable?.kind === "config") {
    return t("QWEN_ASR_BIN in .env points to a missing file. Fix or remove it, then restart livesub.");
  }
  return t("Local speech-to-text isn't supported on this computer yet. Add a cloud API key " +
    "(e.g. DASHSCOPE_API_KEY) to .env and restart livesub.");
}

function welcomeNoBackend() {
  return [
    h("h2", {}, t("Speech-to-text isn't available")),
    h("p", {}, noBackendText()),
    localUnavailable?.reason ? h("p", { className: "muted" }, t("Details: {reason}.", { reason: localUnavailable.reason })) : "",
  ];
}

// The models a new user picks between on the download card (English; t() at use).
const WELCOME_MODELS = {
  "qwen-small": { name: "Standard", note: "Fast, runs on most computers.", recommended: true },
  "qwen-large": { name: "High accuracy", note: "More accurate, needs a fast computer." },
};

function welcomeDownload() {
  welcomeDl = new Map();
  const rows = [...modelsById.values()].filter((m) => m.managed && WELCOME_MODELS[m.id]).map((m) => {
    const info = WELCOME_MODELS[m.id];
    const name = h("span", { className: "model-name" }, t(info.name),
      info.recommended ? h("span", { className: "tag" }, t("recommended")) : "");
    const status = h("span", { className: "model-status" });
    const btn = h("button", { type: "button" });
    btn.addEventListener("click", () => welcomeModelAction(m.id, btn.dataset.action));
    const fill = h("div");
    const bar = h("div", { className: "model-bar" }, fill);
    welcomeDl.set(m.id, { status, btn, bar, fill });
    return h("div", { className: "model-item" }, name, status, btn, bar);
  });
  const missing = [...modelsById.values()].filter((m) => m.state === "missing")
    .map((m) => h("p", { className: "muted" }, t("{env} in .env points to a missing directory: {dir}", { env: m.env, dir: m.dir })));
  return [
    h("h2", {}, t("Download a speech model")),
    h("p", {}, rows.length > 1 ? t("Runs offline on this computer. Pick one:") : t("Runs offline on this computer.")),
    h("div", { className: "welcome-models" }, ...rows),
    ...missing,
  ];
}

// Downloading or using a model also makes it the speech-to-text backend.
function welcomeModelAction(id, action) {
  if (!action) return;
  if (action !== "cancel" && asrBackendSel.value !== id) {
    asrBackendSel.value = id;
    localStorage.setItem(LS_ASR, id);
    updateAsrModelHint();
  }
  if (action === "use") renderWelcome();
  else modelAction(id, action);
}

function updateWelcomeDownload() {
  if (!welcomeDl) return;
  for (const [id, el] of welcomeDl) {
    const m = modelsById.get(id);
    const info = WELCOME_MODELS[id];
    const pct = m.size ? Math.floor((m.done / m.size) * 100) : 0;
    let status = `${fmtBytes(m.size)} · ${t(info.note)}`;
    let action = "download";
    let label = t("Download");
    if (m.state === "downloading") {
      status = t("Downloading {pct}% · {done} / {size}", { pct, done: fmtBytes(m.done), size: fmtBytes(m.size) });
      action = "cancel";
      label = t("Cancel");
    } else if (m.state === "error") {
      status = t("Failed: {error}", { error: m.error });
      label = t("Retry");
    } else if (m.state === "ready") {
      status = t("{size} · Downloaded", { size: fmtBytes(m.size) });
      action = "use";
      label = t("Use");
    } else if (m.done > 0) {
      status = t("Paused at {pct}% · {size}", { pct, size: fmtBytes(m.size) });
      label = t("Resume");
    }
    el.status.textContent = status;
    el.status.classList.toggle("err", m.state === "error");
    el.bar.hidden = m.done === 0 || m.state === "ready";
    el.fill.style.width = `${pct}%`;
    el.btn.dataset.action = action;
    el.btn.textContent = label;
    el.btn.className = info.recommended && action !== "cancel" ? "" : "secondary";
  }
}

// Two lines: the speech-to-text backend, then translation and languages.
function welcomeSummary() {
  const asr = asrBackendSel.selectedOptions[0]?.textContent || "";
  const tr = translateBackendSel.selectedOptions[0]?.textContent || "";
  const asrLine = t("Speech-to-text: {asr}", { asr });
  if (translateBackendSel.value === "none") return [asrLine, t("Translation: off")];
  const src = currentSourceLang();
  const tgt = (targetLangInput.value || "Chinese (Simplified)").trim();
  // The select's (translated) name when it has one, else the typed value.
  const srcOpt = [...sourceLangSel.options].find((o) => o.value === src);
  return [asrLine, t("Translation: {tr} · {src} → {tgt}", { tr, src: srcOpt ? srcOpt.textContent : src, tgt })];
}

function welcomeReady(summary) {
  return [
    h("h2", {}, t("Ready to caption")),
    h("ol", {},
      h("li", {}, ...tNodes("Pick {mic}, or {tab} for a browser tab (turn on \u201cShare tab audio\u201d).",
        { mic: h("b", {}, t("Mic")), tab: h("b", {}, t("Tab")) })),
      h("li", {}, ...tNodes("Press {start}.", { start: h("b", {}, t("Start")) })),
    ),
    translateBackendSel.value === "none" ? "" : h("p", {},
      ...tNodes("For better translations, add the topic and key names in {link}.",
        { link: settingsLink(t("Settings → Session"), "session") })),
    h("p", { className: "muted" }, summary[0], h("br"), summary[1]),
  ];
}

// After a language switch, rebuild the text code writes (setUiLang() did the
// markup).
function refreshLanguage() {
  setToggleState(recording);
  setStatus(...statusMsg);
  welcomeKey = "";
  loadBackends();  // option labels; re-renders the welcome card
  loadModels();
}
