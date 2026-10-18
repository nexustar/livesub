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
    opt.textContent = "(none configured)";
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
    opt.textContent = it.ready === false ? `${it.label} — not downloaded` : it.label;
    opt.dataset.ready = it.ready === false ? "0" : "1";
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
    if (statusEl.textContent === MODEL_MISSING_STATUS) setStatus("idle");
    return;
  }
  const pct = m.size ? Math.floor((m.done / m.size) * 100) : 0;
  let text;
  let btn = "";
  if (m.state === "downloading") {
    text = `Downloading ${pct}% of ${fmtBytes(m.size)}…`;
  } else if (m.state === "ready") {
    text = "Downloaded — loading…";  // the select is about to refresh
  } else if (m.state === "error") {
    text = `Download failed: ${m.error}`;
    btn = "Retry";
  } else {
    text = m.done > 0 ? `Partly downloaded · ${pct}% of ${fmtBytes(m.size)}` : `Not downloaded yet · ${fmtBytes(m.size)}`;
    btn = m.done > 0 ? "Resume" : "Download";
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

function modelEl(m) {
  let el = modelEls.get(m.id);
  if (el) return el;
  const item = document.createElement("div");
  item.className = "model-item";
  const name = document.createElement("span");
  name.className = "model-name";
  name.textContent = m.label;
  const status = document.createElement("span");
  status.className = "model-status";
  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.type = "button";
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (action === "delete" && !confirm(`Delete ${m.label} (${fmtBytes(m.size)})?`)) return;
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
  chunkInput.setAttribute("aria-label", `${m.label}: latency vs. CPU`);
  const chunkValue = document.createElement("span");
  chunkValue.className = "slider-value";
  const showChunk = () => { chunkValue.textContent = `${chunkInput.value} s`; };
  chunkInput.addEventListener("input", () => {
    localStorage.setItem(LS_QWEN_CHUNK + m.id, chunkInput.value);
    showChunk();
  });
  showChunk();
  const ends = ["Lower latency", "Lower CPU"].map((t) => {
    const s = document.createElement("span");
    s.className = "slider-end";
    s.textContent = t;
    return s;
  });
  chunk.append(ends[0], chunkInput, ends[1], chunkValue);
  item.append(name, status, btn, bar, chunk);
  modelsListEl.appendChild(item);
  el = { status, bar, fill, btn, chunk };
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
  // The Local models section only exists when the qwen_asr binary was found.
  modelsSection.hidden = !data.available;
  localUnavailable = data.available ? null : { kind: data.unavailable_kind, reason: data.unavailable_reason || "" };
  if (!data.available) {
    updateAsrModelHint();  // its wording depends on localUnavailable
    renderWelcome();
    return;
  }
  for (const m of data.models) modelsById.set(m.id, m);
  updateAsrModelHint();
  modelsDirEl.textContent = `Downloads go to ${data.data_dir}`;
  let busy = false;
  let changed = false;
  const now = performance.now();
  for (const m of data.models) {
    const el = modelEl(m);
    const prev = modelPrev.get(m.id);
    if (prev && prev.state !== m.state) changed = true;
    const pct = m.size ? Math.floor((m.done / m.size) * 100) : 0;
    let status = "";
    let action = "";
    switch (m.state) {
      case "ready":
        status = m.managed ? "Ready" : `Ready — from ${m.env}`;
        action = m.managed ? "delete" : "";
        break;
      case "missing":
        status = `${m.env} points to a missing directory: ${m.dir}`;
        break;
      case "downloading": {
        busy = true;
        status = `Downloading ${pct}% · ${fmtBytes(m.done)} / ${fmtBytes(m.size)}`;
        if (prev && prev.state === "downloading" && now > prev.t) {
          const rate = ((m.done - prev.done) / (now - prev.t)) * 1000;
          if (rate > 0) status += ` · ${fmtBytes(rate)}/s`;
        }
        action = "cancel";
        break;
      }
      case "error":
        status = `Failed: ${m.error}`;
        action = "download";
        break;
      default:
        status = m.done > 0 ? `Paused at ${pct}%` : "Not downloaded";
        action = "download";
    }
    el.status.textContent = m.state === "downloading" ? status : `${fmtBytes(m.size)} · ${status}`;
    el.status.classList.toggle("err", m.state === "error" || m.state === "missing");
    el.bar.hidden = !(m.state === "downloading" || (m.state === "absent" && m.done > 0));
    el.fill.style.width = `${pct}%`;
    el.btn.hidden = !action;
    el.btn.dataset.action = action;
    el.btn.textContent = { download: m.done > 0 ? "Resume" : "Download", cancel: "Cancel", delete: "Delete" }[action] || "";
    el.chunk.hidden = m.state !== "ready";
    modelPrev.set(m.id, { state: m.state, done: m.done, t: now });
  }
  // A model that finished (or was deleted) changes the ASR dropdown.
  if (changed) loadBackends();
  if (busy) modelsPollTimer = setTimeout(loadModels, 1000);
  renderWelcome();
}
loadModels();

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
    hintStatusEl.textContent = "Type a scene seed first.";
    hintStatusEl.className = "muted err";
    return;
  }
  hintGenerateBtn.disabled = true;
  hintStatusEl.textContent = "Researching (may take 5–15s)…";
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
    const tail = data.searches_used
      ? ` (${data.searches_used} web search${data.searches_used === 1 ? "" : "es"})`
      : "";
    const via = data.backend
      ? ` via ${data.backend.charAt(0).toUpperCase() + data.backend.slice(1)}`
      : "";
    hintStatusEl.textContent =
      `Generated${via}: scene (${scene.length}ch) + glossary (${glossary.length}ch)${tail}. Edit below as needed.`;
    hintStatusEl.className = "muted ok";
  } catch (e) {
    console.error(e);
    hintStatusEl.textContent = "Failed: " + e.message;
    hintStatusEl.className = "muted err";
  } finally {
    hintGenerateBtn.disabled = false;
  }
}

hintGenerateBtn.addEventListener("click", generateHintsFromScene);

inputSourceSel.addEventListener("change", () => {
  localStorage.setItem(LS_INPUT, inputSourceSel.value);
});
asrBackendSel.addEventListener("change", () => {
  localStorage.setItem(LS_ASR, asrBackendSel.value);
  updateAsrModelHint();
  renderWelcome();
});

function qwenChunkSec(modelId) {
  return localStorage.getItem(LS_QWEN_CHUNK + modelId) || "2";
}

translateBackendSel.addEventListener("change", () => {
  localStorage.setItem(LS_TR, translateBackendSel.value);
  renderWelcome();
});

targetLangInput.addEventListener("input", () => {
  localStorage.setItem(LS_LANG, targetLangInput.value);
  renderWelcome();
});
sourceLangSel.addEventListener("change", () => {
  localStorage.setItem(LS_SRC, sourceLangSel.value);
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

function lockSettings(locked) {
  targetLangInput.disabled = locked;
  sourceLangSel.disabled = locked;
  sourceLangInput.disabled = locked;
  sceneSeedInput.disabled = locked;
  sceneInput.disabled = locked;
  glossaryInput.disabled = locked;
  inputSourceSel.disabled = locked;
  asrBackendSel.disabled = locked;
  translateBackendSel.disabled = locked;
  for (const r of modelsListEl.querySelectorAll('input[type="range"]')) r.disabled = locked;
  hintGenerateBtn.disabled = locked;
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

function setStatus(s) {
  statusEl.textContent = s;
}

function setToggleState(rec) {
  toggleBtn.querySelector(".icon").textContent = rec ? "■" : "▶";
  toggleBtn.querySelector(".label").textContent = rec ? "Stop" : "Start";
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
      throw new Error("getDisplayMedia not supported in this browser");
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
        "No audio track delivered. " +
        (navigator.userAgent.includes("Firefox") && navigator.userAgent.includes("Linux")
          ? "Firefox on Linux Wayland does not implement audio capture via " +
            "getDisplayMedia — try Chrome/Chromium, or route system audio " +
            "through a PipeWire virtual mic and use Mic mode."
          : "Pick a TAB (not 'Entire screen' or 'Window') and check 'Share tab audio'.")
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

    setStatus("connecting…");
    // Resolve the /ws endpoint relative to the page's base URI so the app works
    // under a non-root path (reverse-proxy subpath), not just at the domain root.
    const wsBase = new URL("ws", document.baseURI);
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${wsProto}//${wsBase.host}${wsBase.pathname}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({
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
      workletNode.port.onmessage = (e) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      switch (msg.type) {
        case "ready":
          setStatus("listening");
          break;
        case "transcript": {
          const s = getOrCreate(msg.sid);
          s.src += msg.text;
          render();
          break;
        }
        case "transcript_replace": {
          // Used by backends that stream a cumulative transcript that
          // revises itself mid-segment (DashScope qwen3-asr-flash-realtime).
          // Overwrite src wholesale instead of appending.
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
          setStatus("error: " + msg.message);
          badgeAsrEl.classList.add("error");
          console.error("server error:", msg.message);
          break;
      }
    };

    ws.onerror = (e) => console.error("ws error", e);
    ws.onclose = async (e) => {
      if (recording) await stop();
      // A session the server refused carries its reason; stop() resets the
      // status, so set it afterwards.
      setStatus(e.reason ? `error: ${e.reason}` : "disconnected");
    };

    recording = true;
    setToggleState(true);
    lockSettings(true);
    renderWelcome();
  } catch (err) {
    console.error(err);
    setStatus("error: " + err.message);
    await stop();
  }
}

async function stop() {
  recording = false;
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
  // Push the PREV card's content into history, then drop all sentence
  // state. The server resets `next_sid` to 0 on every new WS connection,
  // so without this clear the next session's transcripts for sid=0/1/...
  // would `getOrCreate` and resurrect the previously-archived entries —
  // new content gets routed into stale `srcDone:true` records, render()
  // can't promote them as "current", and the UI shows empty captions
  // with old prev+history below. Strip data-sid off existing history
  // items for the same reason: the next session's `prev_revised` events
  // (sids start at 0 again) would otherwise target the wrong DOM nodes.
  if (prevSlotSid !== null) {
    const oldPrev = sentences.get(prevSlotSid);
    if (oldPrev) appendToHistory(oldPrev);
    prevCardEl.hidden = true;
    prevCardEl.classList.remove("entering");
    prevTranscriptEl.textContent = "";
    prevTranslationEl.textContent = "";
    prevSlotSid = null;
  }
  sentences.clear();
  for (const item of historyEl.querySelectorAll(".history-item[data-sid]")) {
    item.removeAttribute("data-sid");
  }
  transcriptEl.textContent = "";
  translationEl.textContent = "";
  latestEl.textContent = "";
  latestEl.hidden = true;
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
    return "QWEN_ASR_BIN in .env points to a missing file. Fix or remove it, then restart livesub.";
  }
  return "Local speech-to-text isn't supported on this computer yet. Add a cloud API key " +
    "(e.g. DASHSCOPE_API_KEY) to .env and restart livesub.";
}

function welcomeNoBackend() {
  return [
    h("h2", {}, "Speech-to-text isn't available"),
    h("p", {}, noBackendText()),
    localUnavailable?.reason ? h("p", { className: "muted" }, `Details: ${localUnavailable.reason}.`) : "",
  ];
}

// The models a new user picks between on the download card.
const WELCOME_MODELS = {
  "qwen-small": { name: "Standard", note: "Fast, runs on most computers.", recommended: true },
  "qwen-large": { name: "High accuracy", note: "More accurate, needs a fast computer." },
};

function welcomeDownload() {
  welcomeDl = new Map();
  const rows = [...modelsById.values()].filter((m) => m.managed && WELCOME_MODELS[m.id]).map((m) => {
    const info = WELCOME_MODELS[m.id];
    const name = h("span", { className: "model-name" }, info.name,
      info.recommended ? h("span", { className: "tag" }, "recommended") : "");
    const status = h("span", { className: "model-status" });
    const btn = h("button", { type: "button" });
    btn.addEventListener("click", () => welcomeModelAction(m.id, btn.dataset.action));
    const fill = h("div");
    const bar = h("div", { className: "model-bar" }, fill);
    welcomeDl.set(m.id, { status, btn, bar, fill });
    return h("div", { className: "model-item" }, name, status, btn, bar);
  });
  const missing = [...modelsById.values()].filter((m) => m.state === "missing")
    .map((m) => h("p", { className: "muted" }, `${m.env} in .env points to a missing directory: ${m.dir}`));
  return [
    h("h2", {}, "Download a speech model"),
    h("p", {}, rows.length > 1 ? "Runs offline on this computer. Pick one:" : "Runs offline on this computer."),
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
    let status = `${fmtBytes(m.size)} · ${info.note}`;
    let action = "download";
    let label = "Download";
    if (m.state === "downloading") {
      status = `Downloading ${pct}% · ${fmtBytes(m.done)} / ${fmtBytes(m.size)}`;
      action = "cancel";
      label = "Cancel";
    } else if (m.state === "error") {
      status = `Failed: ${m.error}`;
      label = "Retry";
    } else if (m.state === "ready") {
      status = `${fmtBytes(m.size)} · Downloaded`;
      action = "use";
      label = "Use";
    } else if (m.done > 0) {
      status = `Paused at ${pct}% · ${fmtBytes(m.size)}`;
      label = "Resume";
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
  if (translateBackendSel.value === "none") return [`Speech-to-text: ${asr}`, "Translation: off"];
  const src = currentSourceLang();
  const tgt = (targetLangInput.value || "Chinese (Simplified)").trim();
  return [`Speech-to-text: ${asr}`, `Translation: ${tr} · ${src === "auto" ? "Auto-detect" : src} → ${tgt}`];
}

function welcomeReady(summary) {
  return [
    h("h2", {}, "Ready to caption"),
    h("ol", {},
      h("li", {}, "Pick ", h("b", {}, "🎤 Mic"), ", or ", h("b", {}, "📺 Tab"),
        " for a browser tab (turn on “Share tab audio”)."),
      h("li", {}, "Press ", h("b", {}, "Start"), "."),
    ),
    translateBackendSel.value === "none" ? "" : h("p", {}, "For better translations, add the topic and key names in ",
      settingsLink("Settings → Session", "session"), "."),
    h("p", { className: "muted" }, summary[0], h("br"), summary[1]),
  ];
}
