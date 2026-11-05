// Desktop app: the caption server (dist/server.js) in a utility process, its
// page in a window, plus system audio and an always-on-top caption overlay
// (the page offers them when it finds window.livesub, preload.cjs).

import {
  app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, session, shell, utilityProcess,
} from "electron";
import { randomBytes } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// App root: dist/, static/ and desktop/ sit below it, in the repo and packaged.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Chromium's profile and the desktop .env go in a folder of their own, not in
// the "livesub" data dir: the server keeps its models there, shared with the
// CLI (and on macOS "LiveSub" and "livesub" are the same folder).
app.setPath("userData", join(app.getPath("appData"), "livesub-desktop"));
const CONFIG_DIR = app.getPath("userData");
const ENV_FILE = join(CONFIG_DIR, ".env");
const STATE_FILE = join(CONFIG_DIR, "desktop.json");
const LOG_FILE = join(CONFIG_DIR, "server.log");

// Linux system audio: Chromium's loopback (the default sink's monitor, via
// PulseAudio or pipewire-pulse) is behind this feature. Before ready.
if (process.platform === "linux") app.commandLine.appendSwitch("enable-features", "PulseaudioLoopbackForScreenShare");

// Native menu text; the page has its own (static/i18n.js).
const MENU_ZH = {
  "File": "文件",
  "Open Settings Folder": "打开设置文件夹",
  "Restart Server": "重启服务",
  "Click-through Captions": "字幕窗口鼠标穿透",
  "The caption server stopped": "字幕服务已停止",
  "Restart": "重启",
  "Quit": "退出",
  "The caption server couldn't start": "字幕服务无法启动",
};
const tr = (s) => (systemUiLang() === "zh" ? MENU_ZH[s] ?? s : s);

// The first of the system's preferred languages the app has (static/i18n.js
// does the same with them for the page). After ready.
function systemUiLang() {
  for (const l of app.getPreferredSystemLanguages()) {
    const m = /^(zh|en)(?:[-_.@]|$)/i.exec(l);
    if (m) return m[1].toLowerCase();
  }
  return "en";
}

// ---------- saved state ----------

// The port is kept across launches: the page saves its settings in
// localStorage, which is per origin, port included.
let state = {};
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch {
  /* first run */
}
function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`can't save ${STATE_FILE}: ${e.message}`);
  }
}

function listenOn(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => {
      const got = s.address().port;
      s.close(() => resolve(got));
    });
  });
}

// The saved port when free, else a new one (the page's settings then reset).
async function pickPort() {
  if (state.port && (await listenOn(state.port))) return state.port;
  const port = await listenOn(0);
  state.port = port;
  saveState();
  return port;
}

// ---------- server ----------

let server = null;
let serverUrl = "";
let quitting = false;
const log = createWriteStream(LOG_FILE, { flags: "w" });

// The API and /ws require this as a cookie (src/server.ts), which only our
// windows get: the port is open to every program on this computer.
const SESSION_TOKEN = randomBytes(32).toString("hex");

// Resolves with the server's URL once it listens. .env is read from
// CONFIG_DIR, but host and port are ours: the app never opens to the network.
async function startServer() {
  const port = await pickPort();
  const child = utilityProcess.fork(join(ROOT, "dist", "server.js"), [], {
    serviceName: "LiveSub server",
    stdio: "pipe",
    env: {
      ...process.env,
      LIVESUB_CONFIG_DIR: CONFIG_DIR,
      LIVESUB_HOST: "127.0.0.1",
      LIVESUB_PORT: String(port),
      LIVESUB_SESSION_TOKEN: SESSION_TOKEN,
    },
  });
  server = child;
  for (const s of [child.stdout, child.stderr]) {
    s.on("data", (d) => {
      log.write(d);
      if (!app.isPackaged) process.stderr.write(d);
    });
  }
  return new Promise((resolve, reject) => {
    child.on("message", (m) => {
      if (m?.type === "listening") {
        const url = `http://127.0.0.1:${m.port}/`;
        session.defaultSession.cookies
          .set({ url, name: "livesub_session", value: SESSION_TOKEN, httpOnly: true, sameSite: "strict" })
          .then(() => resolve(url), reject);
      }
    });
    child.once("exit", (code) => {
      reject(new Error(`exited with code ${code}`));
      if (server === child && serverUrl && !quitting) serverDied(code);
    });
  });
}

async function stopServer() {
  const child = server;
  server = null;
  if (!child?.pid) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
}

async function restartServer() {
  await stopServer();
  serverUrl = "";
  try {
    serverUrl = await startServer();
  } catch (e) {
    return startFailed(e);
  }
  mainWindow?.loadURL(serverUrl);
}

async function serverDied(code) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "error",
    message: tr("The caption server stopped"),
    detail: `exit code ${code}. Log: ${LOG_FILE}`,
    buttons: [tr("Restart"), tr("Quit")],
  });
  if (response === 0) restartServer();
  else app.quit();
}

function startFailed(e) {
  dialog.showErrorBox(tr("The caption server couldn't start"), `${e.message}\n\nLog: ${LOG_FILE}`);
  app.quit();
}

// Opens the folder with .env, starting one from the commented example.
function openConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const example = join(ROOT, ".env.example");
  if (!existsSync(ENV_FILE) && existsSync(example)) copyFileSync(example, ENV_FILE);
  if (existsSync(ENV_FILE)) shell.showItemInFolder(ENV_FILE);
  else shell.openPath(CONFIG_DIR);
}

// ---------- windows ----------

let mainWindow = null;
let overlay = null;
let clickThrough = false;

// Saved bounds, if they still fit on a connected display.
function savedBounds(key, def) {
  const b = state[key];
  if (!b) return def;
  const area = screen.getDisplayMatching(b).workArea;
  const fits = b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y;
  return fits ? b : def;
}

function rememberBounds(win, key) {
  win.on("close", () => {
    state[key] = win.getNormalBounds();
    saveState();
  });
}

function isOwnPage(url) {
  return serverUrl !== "" && url.startsWith(serverUrl);
}

// The toolbar is the title bar (body.desktop-titlebar): traffic lights on
// macOS, window buttons drawn over it elsewhere, down to its 1px border. No
// menu bar there; the settings page has the File menu's items.
const TOOLBAR_HEIGHT = 46;
function titleBarOptions() {
  if (process.platform === "darwin") return { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 16 } };
  return { titleBarStyle: "hidden", titleBarOverlay: { color: "#0a0a0a", symbolColor: "#999999", height: TOOLBAR_HEIGHT - 1 } };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    ...savedBounds("mainBounds", { width: 960, height: 680 }),
    minWidth: 360,
    minHeight: 160,
    title: "LiveSub",
    backgroundColor: "#0a0a0a",
    ...titleBarOptions(),
    webPreferences: {
      preload: join(ROOT, "desktop", "preload.cjs"),
      additionalArguments: [`--livesub-languages=${app.getPreferredSystemLanguages().join(",")}`],
    },
  });
  rememberBounds(mainWindow, "mainBounds");
  const wc = mainWindow.webContents;
  // Pop out opens about:blank under this name (app.js); links go to the browser.
  wc.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === "livesub-popout" && (url === "" || url === "about:blank")) {
      return { action: "allow", overrideBrowserWindowOptions: overlayOptions() };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("did-create-window", setupOverlay);
  wc.on("will-navigate", (e, url) => {
    if (isOwnPage(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(serverUrl);
}

function overlayOptions() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(820, area.width - 40);
  const def = { width, height: 220, x: area.x + Math.round((area.width - width) / 2), y: area.y + area.height - 260 };
  return {
    ...savedBounds("overlayBounds", def),
    minWidth: 240,
    minHeight: 80,
    title: "LiveSub",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
  };
}

function setupOverlay(win) {
  overlay = win;
  // Above full-screen video too.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  rememberBounds(win, "overlayBounds");
  win.on("closed", () => {
    if (overlay !== win) return;
    overlay = null;
    setClickThrough(false);
  });
  updateMenu();
}

// forward: mouse moves still reach the page (it hides its hover controls).
function setClickThrough(on) {
  clickThrough = Boolean(on) && overlay !== null;
  overlay?.setIgnoreMouseEvents(clickThrough, { forward: true });
  mainWindow?.webContents.send("click-through", clickThrough);
  updateMenu();
}

ipcMain.on("click-through", (e, on) => {
  if (e.sender === mainWindow?.webContents) setClickThrough(on);
});
ipcMain.on("open-config-dir", (e) => {
  if (e.sender === mainWindow?.webContents) openConfigDir();
});
ipcMain.on("restart-server", (e) => {
  if (e.sender === mainWindow?.webContents) restartServer();
});

function updateMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: tr("File"),
      submenu: [
        { label: tr("Open Settings Folder"), click: openConfigDir },
        { label: tr("Restart Server"), click: restartServer },
        { type: "separator" },
        {
          label: tr("Click-through Captions"),
          type: "checkbox",
          checked: clickThrough,
          enabled: overlay !== null,
          click: () => setClickThrough(!clickThrough),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
}

// ---------- capture ----------

// The page talks only to the server, which makes the cloud calls: nothing it
// shows could send text elsewhere.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function setupSession() {
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!isOwnPage(details.url)) return callback({});
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
  });
  // Mic and screen capture for the server's page only.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const own = isOwnPage(details.requestingUrl ?? "");
    callback(own && (permission === "media" || permission === "display-capture" || permission === "clipboard-sanitized-write"));
  });
  // Only the audio is used, but Chromium wants a video source: the page
  // itself, which needs no screen-recording permission (a screen would).
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.frame || !isOwnPage(request.frame.url) || !request.audioRequested) return callback(null);
    // Where loopback isn't there (Linux without PulseAudio or pipewire-pulse)
    // the page gets no audio track and says so.
    callback({ video: request.frame, audio: "loopback" });
  });
}

// ---------- startup ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(async () => {
    // The page is dark: so are the menus and dialogs.
    nativeTheme.themeSource = "dark";
    setupSession();
    updateMenu();
    try {
      serverUrl = await startServer();
    } catch (e) {
      return startFailed(e);
    }
    createMainWindow();
  });
}
