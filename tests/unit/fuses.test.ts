import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a packaging hook electron-builder loads by path, so plain
// ESM JavaScript rather than a typed module in src/.
import * as afterPack from '../../scripts/after-pack.mjs'

const { electronBinaryPath, FUSE_CONFIG, fuseConfigFor, willBeSigned } = afterPack

/**
 * The fuses half of T1 (#47): the configuration the hook hands to
 * @electron/fuses says what SECURITY.org says, and the hook aims at the right
 * file. The wire is read back off the packaged binary in
 * tests/package/launch.spec.ts (#35).
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

describe('the signature after the flip (#35)', () => {
  const context = (identity?: string | null) => ({
    packager: { platformSpecificBuildOptions: identity === undefined ? {} : { identity } },
  })

  it('re-signs ad hoc when nothing signs after the hook, so the unsigned app launches', () => {
    expect(willBeSigned(context(), { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })).toBe(false)
    expect(willBeSigned(context(null), {})).toBe(false)
    expect(fuseConfigFor(false).resetAdHocDarwinSignature).toBe(true)
  })

  it('leaves the signature to electron-builder when an identity is named or discovered', () => {
    expect(willBeSigned(context(), { CSC_NAME: 'Developer ID Application: X' })).toBe(true)
    expect(willBeSigned(context(), { CSC_LINK: '/cert.p12' })).toBe(true)
    expect(willBeSigned(context('Developer ID Application: X'), {})).toBe(true)
    expect(willBeSigned(context(), {})).toBe(true)
    expect(fuseConfigFor(true).resetAdHocDarwinSignature).toBe(false)
  })

  it('never changes the fuse list', () => {
    for (const signed of [true, false]) {
      expect({ ...fuseConfigFor(signed), resetAdHocDarwinSignature: false }).toEqual(FUSE_CONFIG)
    }
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
