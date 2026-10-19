import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a repository script run under plain Node, so plain ESM
// JavaScript rather than a typed module in src/.
import * as releaseCheck from '../../scripts/release-check.mjs'

const {
  entitlementFailures,
  entitlementKeys,
  parseCodesignDisplay,
  parseSpctl,
  sdkBinaryFailures,
  signatureFailures,
  DISTRIBUTION_ENTITLEMENTS,
  HARDENED_ENTITLEMENTS,
  SDK_SIGNER_TEAM,
} = releaseCheck

/**
 * The parsing half of scripts/release-check.mjs (#74), against the output
 * codesign and spctl print, so the distribution mode is tested before there is
 * a Developer ID to sign with (#36).
 */

const ADHOC = `Identifier=com.pdelfino.nemesis
CodeDirectory v=20400 size=301 flags=0x2(adhoc) hashes=3+3 location=embedded
Signature=adhoc
TeamIdentifier=not set
`

const DEVELOPER_ID = `Identifier=com.pdelfino.nemesis
CodeDirectory v=20500 size=301 flags=0x10000(runtime) hashes=3+3 location=embedded
Authority=Developer ID Application: Pedro Delfino (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDE12345
`

const ADHOC_HARDENED = `Identifier=com.pdelfino.nemesis
CodeDirectory v=20500 size=437 flags=0x10002(adhoc,runtime) hashes=3+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
`

const SDK_BINARY = `Identifier=com.anthropic.claude-code
CodeDirectory v=20500 size=522661 flags=0x10000(runtime) hashes=16322+7 location=embedded
Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Oct 16, 2026 at 12:02:07 PM
TeamIdentifier=Q6L2SF6YDW
`

describe('codesign -dv output', () => {
  it('reads an ad hoc signature with no team', () => {
    expect(parseCodesignDisplay(ADHOC)).toEqual({
      adhoc: true,
      authorities: [],
      teamIdentifier: null,
      runtime: false,
      timestamped: false,
    })
  })

  it('reads the hardened runtime flag and the secure timestamp (#36)', () => {
    expect(parseCodesignDisplay(ADHOC_HARDENED)).toMatchObject({ adhoc: true, runtime: true })
    expect(parseCodesignDisplay(SDK_BINARY)).toMatchObject({
      adhoc: false,
      runtime: true,
      timestamped: true,
      teamIdentifier: 'Q6L2SF6YDW',
    })
  })

  it('reads a Developer ID signature and its team', () => {
    const signature = parseCodesignDisplay(DEVELOPER_ID)
    expect(signature.adhoc).toBe(false)
    expect(signature.authorities[0]).toBe('Developer ID Application: Pedro Delfino (ABCDE12345)')
    expect(signature.teamIdentifier).toBe('ABCDE12345')
  })
})

describe('signature requirements', () => {
  it('lets an ad hoc local build through the default mode', () => {
    expect(signatureFailures(parseCodesignDisplay(ADHOC), { distribution: false })).toEqual([])
  })

  it('refuses an ad hoc build in distribution mode', () => {
    const failures = signatureFailures(parseCodesignDisplay(ADHOC), { distribution: true })
    expect(failures).toHaveLength(4)
    expect(failures).toContain('the app is not signed for the hardened runtime')
  })

  it('takes an ad hoc build under the hardened runtime in hardened mode, and refuses one without it', () => {
    const options = { distribution: false, hardened: true }
    expect(signatureFailures(parseCodesignDisplay(ADHOC_HARDENED), options)).toEqual([])
    expect(signatureFailures(parseCodesignDisplay(ADHOC), options)).toEqual([
      'the app is not signed for the hardened runtime',
    ])
  })

  it('accepts a Developer ID build in distribution mode', () => {
    const signature = parseCodesignDisplay(DEVELOPER_ID)
    expect(signatureFailures(signature, { distribution: true })).toEqual([])
  })
})

describe('spctl --assess output', () => {
  it('accepts a notarized Developer ID app', () => {
    const output = 'Nemesis.app: accepted\nsource=Notarized Developer ID\n'
    expect(parseSpctl(0, output)).toEqual({ accepted: true, notarized: true })
  })

  it('tells a signed but unnotarized app apart', () => {
    const output = 'Nemesis.app: accepted\nsource=Developer ID\n'
    expect(parseSpctl(0, output)).toEqual({ accepted: true, notarized: false })
  })

  it('reports a rejection', () => {
    expect(parseSpctl(3, 'Nemesis.app: rejected\n').accepted).toBe(false)
  })
})

describe('entitlements (#36)', () => {
  const SHOWN = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>`

  it('reads the keys, comments left out', () => {
    expect(entitlementKeys(SHOWN)).toEqual(['com.apple.security.cs.allow-jit'])
    expect(entitlementKeys('<!-- <key>commented.out</key> --><key>b</key><key>a</key>')).toEqual([
      'a',
      'b',
    ])
  })

  it('reports an extra entitlement and a missing one', () => {
    expect(entitlementFailures(['a', 'extra'], ['a', 'needed'], 'the.plist')).toEqual([
      'entitlement extra is not in the.plist',
      'entitlement needed from the.plist is missing',
    ])
    expect(entitlementFailures(['a'], ['a'], 'the.plist')).toEqual([])
  })

  it('keeps the committed sets minimal: allow-jit, and library validation off for the ad hoc check only', () => {
    expect(entitlementKeys(readFileSync(DISTRIBUTION_ENTITLEMENTS, 'utf8'))).toEqual([
      'com.apple.security.cs.allow-jit',
    ])
    expect(entitlementKeys(readFileSync(HARDENED_ENTITLEMENTS, 'utf8'))).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.disable-library-validation',
    ])
  })
})

describe('the Agent SDK CLI binary keeps its own signature (#36)', () => {
  it("accepts Anthropic's hardened, timestamped Developer ID signature", () => {
    expect(SDK_SIGNER_TEAM).toBe('Q6L2SF6YDW')
    expect(sdkBinaryFailures(parseCodesignDisplay(SDK_BINARY))).toEqual([])
  })

  it('refuses a binary Nemesis re-signed, or one signed ad hoc', () => {
    const resigned = SDK_BINARY.replace(/Q6L2SF6YDW/g, 'ABCDE12345')
    expect(sdkBinaryFailures(parseCodesignDisplay(resigned))[0]).toContain('was re-signed')
    expect(sdkBinaryFailures(parseCodesignDisplay(ADHOC_HARDENED))[0]).toContain('was re-signed')
  })

  it('refuses one without the hardened runtime or the timestamp', () => {
    const plain = SDK_BINARY.replace('flags=0x10000(runtime)', 'flags=0x0(none)').replace(
      /^Timestamp=.*\n/m,
      '',
    )
    expect(sdkBinaryFailures(parseCodesignDisplay(plain))).toEqual([
      'the Agent SDK binary is not signed for the hardened runtime',
      'the Agent SDK binary signature has no secure timestamp',
    ])
  })
})
