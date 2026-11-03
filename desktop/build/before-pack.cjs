// electron-builder beforePack: make sure the quickasr binary for the target
// platform and arch is in node_modules, so it gets packed.

const { targetKey, ensurePlatformPackage } = require("./quickasr-pkg.cjs");

exports.default = async ({ electronPlatformName, arch }) => {
  ensurePlatformPackage(targetKey(electronPlatformName, arch));
};
