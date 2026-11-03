// window.livesub, the desktop app's extras for the page (main.mjs answers).
// CommonJS: sandboxed preloads can't be ES modules.

const { contextBridge, ipcRenderer } = require("electron");

const LANGS_ARG = "--livesub-languages=";
const languages = (process.argv.find((a) => a.startsWith(LANGS_ARG)) ?? LANGS_ARG)
  .slice(LANGS_ARG.length).split(",").filter(Boolean);

contextBridge.exposeInMainWorld("livesub", {
  platform: process.platform,
  languages,
  setClickThrough: (on) => ipcRenderer.send("click-through", Boolean(on)),
  // Also fires when the main process changes it (menu, overlay closed).
  onClickThrough: (fn) => ipcRenderer.on("click-through", (_e, on) => fn(on)),
  openConfigDir: () => ipcRenderer.send("open-config-dir"),
  restartServer: () => ipcRenderer.send("restart-server"),
});
