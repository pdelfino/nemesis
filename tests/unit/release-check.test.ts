import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a repository script run under plain Node, so plain ESM
// JavaScript rather than a typed module in src/.
import * as releaseCheck from '../../scripts/release-check.mjs'

const { parseCodesignDisplay, parseSpctl, signatureFailures } = releaseCheck

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

describe('codesign -dv output', () => {
  it('reads an ad hoc signature with no team', () => {
    expect(parseCodesignDisplay(ADHOC)).toEqual({
      adhoc: true,
      authorities: [],
      teamIdentifier: null,
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
    expect(signatureFailures(parseCodesignDisplay(ADHOC), { distribution: true })).toHaveLength(3)
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
