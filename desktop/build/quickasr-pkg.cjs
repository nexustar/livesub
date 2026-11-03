// The quickasr binary ships in one npm package per platform
// (@quickasr/<platform>-<arch>, an optional dependency of quickasr); npm
// installs only the build machine's. Shared by the electron-builder hooks.

const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Arch } = require("electron-builder");

const ROOT = join(__dirname, "..", "..");
const SCOPE = "@quickasr";

// "darwin-arm64", "win32-x64", ...: the package for this target.
function targetKey(electronPlatformName, arch) {
  return `${electronPlatformName}-${Arch[arch]}`;
}

// Puts @quickasr/<key> into the project's node_modules when npm didn't
// (another arch or OS than the build machine's), at the version quickasr
// pins, from the registry tarball. Throws when quickasr has no such package.
function ensurePlatformPackage(key) {
  const name = `${SCOPE}/${key}`;
  const dest = join(ROOT, "node_modules", SCOPE, key);
  if (existsSync(join(dest, "package.json"))) return;
  const pinned = require(join(ROOT, "node_modules", "quickasr", "package.json")).optionalDependencies || {};
  const version = pinned[name];
  if (!version) throw new Error(`quickasr ships no binary for ${key}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const tmp = mkdtempSync(join(tmpdir(), "quickasr-"));
  try {
    const tgz = execFileSync(npm, ["pack", `${name}@${version}`, "--silent"], { cwd: tmp, encoding: "utf8", shell: process.platform === "win32" })
      .trim().split("\n").pop();
    execFileSync("tar", ["-xzf", tgz], { cwd: tmp });
    mkdirSync(join(ROOT, "node_modules", SCOPE), { recursive: true });
    renameSync(join(tmp, "package"), dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// In the packed app: keeps @quickasr/<key> only, and checks its binary is there.
function keepOnlyPlatformPackage(appDir, key) {
  const dir = join(appDir, "node_modules", SCOPE);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  for (const name of names) if (name !== key) rmSync(join(dir, name), { recursive: true });
  // Linux and Windows builds load libggml from next to the binary, and fail
  // to start without it. macOS links it in.
  const files = key.startsWith("win32-") ? ["quickasr.exe", "ggml.dll"]
    : key.startsWith("linux-") ? ["quickasr", "libggml.so"] : ["quickasr"];
  for (const f of files) {
    if (!existsSync(join(dir, key, f))) throw new Error(`the packed app has no ${SCOPE}/${key}/${f}`);
  }
}

module.exports = { targetKey, ensurePlatformPackage, keepOnlyPlatformPackage };
