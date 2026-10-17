import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a packaging hook electron-builder loads by path, so plain
// ESM JavaScript rather than a typed module in src/.
import { electronBinaryPath, FUSE_CONFIG } from '../../scripts/after-pack.mjs'

/**
 * The fuses half of T1 (#47). Reading the wire back off a packaged binary is an
 * M5 test, because there is nothing packaged until then; what is testable now
 * is that the configuration the hook hands to @electron/fuses says what
 * SECURITY.org says, and that the hook aims at the right file.
 */

describe('Electron fuses configuration (SECURITY.org T1)', () => {
  it('closes the three doors that turn the binary into a Node interpreter', () => {
    expect(FUSE_CONFIG[FuseV1Options.RunAsNode]).toBe(false)
    expect(FUSE_CONFIG[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(FUSE_CONFIG[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
  })

  it('encrypts cookies at rest', () => {
    expect(FUSE_CONFIG[FuseV1Options.EnableCookieEncryption]).toBe(true)
  })

  it('loads the app only from a validated asar', () => {
    expect(FUSE_CONFIG[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
    expect(FUSE_CONFIG[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true)
  })

  it('targets fuse wire version 1 and is frozen', () => {
    expect(FUSE_CONFIG.version).toBe(FuseVersion.V1)
    expect(Object.isFrozen(FUSE_CONFIG)).toBe(true)
  })

  it('leaves the signature to electron-builder, which signs after this hook', () => {
    expect(FUSE_CONFIG.resetAdHocDarwinSignature).toBe(false)
  })

  it('sets every fuse SECURITY.org names and no others', () => {
    const named = Object.keys(FUSE_CONFIG).filter((key) => /^\d+$/.test(key))
    expect(named.sort()).toEqual(
      [
        FuseV1Options.RunAsNode,
        FuseV1Options.EnableNodeOptionsEnvironmentVariable,
        FuseV1Options.EnableNodeCliInspectArguments,
        FuseV1Options.EnableCookieEncryption,
        FuseV1Options.OnlyLoadAppFromAsar,
        FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
      ]
        .map(String)
        .sort(),
    )
  })
})

describe('the binary the hook flips', () => {
  const context = (electronPlatformName: string, executableName?: string) => ({
    appOutDir: '/release/mac-arm64',
    electronPlatformName,
    packager: { appInfo: { productFilename: 'Nemesis' }, executableName },
  })

  it('reaches inside the bundle on macOS, where the Mach-O binary lives', () => {
    expect(electronBinaryPath(context('darwin'))).toBe(
      '/release/mac-arm64/Nemesis.app/Contents/MacOS/Nemesis',
    )
  })

  it('uses the executable name when electron-builder renames it', () => {
    expect(electronBinaryPath(context('darwin', 'nemesis'))).toBe(
      '/release/mac-arm64/Nemesis.app/Contents/MacOS/nemesis',
    )
    expect(electronBinaryPath(context('linux', 'nemesis'))).toBe('/release/mac-arm64/nemesis')
  })

  it('adds the extension on Windows', () => {
    expect(electronBinaryPath(context('win32'))).toBe('/release/mac-arm64/Nemesis.exe')
  })
})
