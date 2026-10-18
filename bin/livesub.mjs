#!/usr/bin/env node
// CLI entry for `npx livesub` / a global `livesub`. Thin wrapper so the shebang
// is guaranteed on the bin file; the real server is the compiled dist/server.js
// (importing it starts the HTTP + WS listener). Config (.env, model dir) is read
// from the current working directory — see src/config.ts.
import { readFileSync } from "node:fs";

const HELP = `Usage: livesub [--help | --version]

Starts the caption server on http://0.0.0.0:8000. Settings are read from .env
and livesub.toml in the current directory (or LIVESUB_CONFIG_DIR); downloaded
models are kept in the platform data dir (or LIVESUB_DATA_DIR).

https://github.com/nexustar/livesub`;

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
} else if (arg === "--help" || arg === "-h") {
  console.log(HELP);
} else if (arg) {
  console.error(`livesub: unknown option ${arg}\n\n${HELP}`);
  process.exitCode = 2;
} else {
  await import("../dist/server.js");
}
