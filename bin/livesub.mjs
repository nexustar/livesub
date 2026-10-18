#!/usr/bin/env node
// CLI entry for `npx livesub` / a global `livesub`. Thin wrapper so the shebang
// is guaranteed on the bin file; the real server is the compiled dist/server.js
// (importing it starts the HTTP + WS listener). Config (.env, model dir) is read
// from the current working directory — see src/config.ts.
import { readFileSync } from "node:fs";

const HELP = `Usage: livesub [--host ADDR] [--port N] [--help | --version]

Starts the caption server on http://127.0.0.1:8000. Settings are read from
.env and livesub.toml in the current directory (or LIVESUB_CONFIG_DIR);
downloaded models are kept in the platform data dir (or LIVESUB_DATA_DIR).

  --host ADDR  address to listen on (LIVESUB_HOST); 0.0.0.0 opens the
               captions to other devices on your network, and with them
               your API keys
  --port N     port to listen on (LIVESUB_PORT); 0 picks a free one

https://github.com/nexustar/livesub`;

// Flags become the env vars src/config.ts reads; they win over .env, which
// doesn't override variables that are already set.
const FLAG_ENV = { "--host": "LIVESUB_HOST", "--port": "LIVESUB_PORT" };

function fail(msg) {
  console.error(`livesub: ${msg}\n\n${HELP}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let run = true;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--version" || arg === "-v") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    run = false;
    break;
  }
  if (arg === "--help" || arg === "-h") {
    console.log(HELP);
    run = false;
    break;
  }
  const [flag, inline] = arg.split(/=(.*)/s);
  if (!(flag in FLAG_ENV)) fail(`unknown option ${arg}`);
  const value = inline ?? args[++i];
  if (value === undefined || value === "") fail(`${flag} needs a value`);
  if (flag === "--port" && !(/^\d+$/.test(value) && Number(value) <= 65535)) fail(`--port must be 0-65535`);
  process.env[FLAG_ENV[flag]] = value;
}
if (run) await import("../dist/server.js");
