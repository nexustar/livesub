// electron-builder afterPack: keep only the quickasr binary for the target
// platform and arch. A pattern in `files` can't do it: its ${platform} is the
// build machine's, not the target's.

const { join } = require("node:path");
const { targetKey, keepOnlyPlatformPackage } = require("./quickasr-pkg.cjs");

exports.default = async ({ appOutDir, electronPlatformName, arch, packager }) => {
  const app = electronPlatformName === "darwin"
    ? join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources", "app")
    : join(appOutDir, "resources", "app");
  keepOnlyPlatformPackage(app, targetKey(electronPlatformName, arch));
};
