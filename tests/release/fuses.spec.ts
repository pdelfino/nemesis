import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses'
// @ts-expect-error -- a packaging hook electron-builder loads by path, so plain
// ESM JavaScript rather than a typed module in src/.
import { FUSE_CONFIG } from '../../scripts/after-pack.mjs'

/**
 * The fuses half of `npm run release:check` (#74): reads the fuse wire back
 * off the packaged binary under release/ and asserts the configuration of #47,
 * for whatever build is there. The after-pack hook flips the same fuses on a
 * signed build and on an unsigned one (only the ad hoc re-sign differs, see
 * fuseConfigFor), so this spec holds for both; scripts/release-check.mjs checks
 * the signature itself. NEMESIS_APP points it at another bundle.
 */

const APP = resolve(process.env.NEMESIS_APP ?? join('release', 'mac-arm64', 'Nemesis.app'))
const BINARY = join(APP, 'Contents', 'MacOS', 'Nemesis')

const CONFIGURED = Object.keys(FUSE_CONFIG)
  .filter((key) => /^\d+$/.test(key))
  .map(Number) as FuseV1Options[]

test.beforeAll(() => {
  if (!existsSync(BINARY)) throw new Error(`no packaged binary at ${BINARY}; run npm run package`)
})

test('the fuse wire is the version the configuration targets', async () => {
  const wire = await getCurrentFuseWire(BINARY)
  expect(wire.version).toBe(FuseVersion.V1)
  expect((FUSE_CONFIG as { version: FuseVersion }).version).toBe(FuseVersion.V1)
})

test('every fuse SECURITY.org T1 names is flipped in the packaged binary', async () => {
  const wire = await getCurrentFuseWire(BINARY)
  expect(CONFIGURED).toHaveLength(6)
  for (const fuse of CONFIGURED) {
    const want = (FUSE_CONFIG as Record<number, boolean>)[fuse]
      ? FuseState.ENABLE
      : FuseState.DISABLE
    expect(wire[fuse], FuseV1Options[fuse]).toBe(want)
  }
})

test('the doors to a Node interpreter are closed, by name', async () => {
  const wire = await getCurrentFuseWire(BINARY)
  expect(wire[FuseV1Options.RunAsNode]).toBe(FuseState.DISABLE)
  expect(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(FuseState.DISABLE)
  expect(wire[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FuseState.DISABLE)
  expect(wire[FuseV1Options.OnlyLoadAppFromAsar]).toBe(FuseState.ENABLE)
  expect(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(FuseState.ENABLE)
  expect(wire[FuseV1Options.EnableCookieEncryption]).toBe(FuseState.ENABLE)
})
