"use strict"

const { execFileSync } = require("child_process")
const path = require("path")

// electron-builder / @electron/osx-sign signs nested Mach-O, frameworks and
// helpers inside-out when mac.identity is "-". This hook runs after that
// signature exists and before the dmg target is built. A non-zero codesign
// status fails the build, so a broken ad-hoc signature never gets packaged.
async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`codesign --verify --deep --strict ${appPath}`)
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  })
  console.log("codesign --verify --deep --strict: passed")
  console.log(`codesign -dv ${appPath}`)
  execFileSync("/usr/bin/codesign", ["-dv", appPath], {
    stdio: "inherit",
  })
}

module.exports = afterSign
module.exports.default = afterSign
module.exports.afterSign = afterSign
