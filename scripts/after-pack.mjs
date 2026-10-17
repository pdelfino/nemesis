// electron-builder's afterPack hook: flip the Electron fuses (SECURITY.org T1,
// #47). Fuses are bits in the Electron binary that turn off escape hatches the
// app never uses, so a page or a local process cannot ask the shipped binary to
// behave as a Node interpreter.
//
// afterPack is the right moment: it runs after the app directory is assembled
// and before electron-builder signs it, so the signature covers the flipped
// binary. Flipping after signing would invalidate it.
//
// The read-back on the packaged binary is an M5 test (`getCurrentFuseWire`);
// what is tested here is the configuration object, in tests/unit/fuses.test.ts.

import { join } from 'node:path'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'

/**
 * The six fuses the security baseline requires, and why each one:
 *
 * - RunAsNode off: ELECTRON_RUN_AS_NODE can no longer turn the binary into a
 *   general-purpose Node interpreter running arbitrary scripts.
 * - EnableNodeOptionsEnvironmentVariable off: NODE_OPTIONS can no longer inject
 *   a --require module into the main process.
 * - EnableNodeCliInspectArguments off: --inspect cannot open a debugger port
 *   that would hand out main-process evaluation.
 * - EnableCookieEncryption on: the cookie store is encrypted at rest with the
 *   OS keychain, so another local process cannot read session cookies.
 * - OnlyLoadAppFromAsar on: the app is loaded from app.asar only, never from an
 *   unpacked directory someone dropped next to it.
 * - EnableEmbeddedAsarIntegrityValidation on: the asar is checked against the
 *   hash embedded in the binary, so a tampered bundle refuses to start.
 */
export const FUSE_CONFIG = Object.freeze({
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // electron-builder code-signs after this hook, so the ad-hoc signature the
  // flip invalidates is replaced by the real one. M5 owns the identity.
  resetAdHocDarwinSignature: false,
})

/**
 * Where the Electron binary sits inside the packed output, per platform.
 * Exported so a unit test can assert the path without packaging anything.
 */
export function electronBinaryPath(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const product = packager.appInfo.productFilename
  const executable = packager.executableName ?? product
  if (electronPlatformName === 'darwin') {
    return join(appOutDir, `${product}.app`, 'Contents', 'MacOS', executable)
  }
  if (electronPlatformName === 'win32') {
    return join(appOutDir, `${executable}.exe`)
  }
  return join(appOutDir, executable)
}

export default async function afterPack(context) {
  const binary = electronBinaryPath(context)
  console.log(`[fuses] flipping the security fuses on ${binary}`)
  await flipFuses(binary, FUSE_CONFIG)
}
