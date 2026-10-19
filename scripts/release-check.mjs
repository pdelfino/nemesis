// The signature half of `npm run release:check` (#74): checks the packaged
// Nemesis.app with the same tools Gatekeeper uses, so a bundle whose seal is
// broken, or that would be refused on another Mac, never gets a tag. The fuses
// half is tests/release/fuses.spec.ts.
//
// Three modes. The default checks a local build: the seal must verify, ad hoc
// or not, because Apple silicon kills a binary whose signature does not match
// (the note on #74). `--hardened` checks `npm run package:hardened` (#36): the
// app runs under the hardened runtime with exactly the entitlements of
// build/entitlements.adhoc.plist. `--distribution` is the mode the release
// checklist runs before a tag: a Developer ID signature with a team, the
// hardened runtime with exactly build/entitlements.mac.plist, `spctl --assess`
// accepting it as notarized, and the notarization ticket stapled.
//
// Every mode also checks the Agent SDK's CLI binary inside the bundle: it keeps
// Anthropic's own Developer ID signature, hardened and timestamped (signIgnore
// in electron-builder.yml), and it runs.
//
// Usage: node scripts/release-check.mjs [--hardened | --distribution] [path/to/Nemesis.app]

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_APP = join('release', 'mac-arm64', 'Nemesis.app')

/** The entitlements a Developer ID build carries, and the ones the ad hoc hardened check carries (#36). */
export const DISTRIBUTION_ENTITLEMENTS = join('build', 'entitlements.mac.plist')
export const HARDENED_ENTITLEMENTS = join('build', 'entitlements.adhoc.plist')

/** Anthropic's team, which signs the Agent SDK's CLI binary; Nemesis never re-signs it (#36). */
export const SDK_SIGNER_TEAM = 'Q6L2SF6YDW'

/** Where the Agent SDK's CLI binaries sit in the bundle, unpacked next to the asar. */
const SDK_SCOPE = join(
  'Contents',
  'Resources',
  'app.asar.unpacked',
  'node_modules',
  '@anthropic-ai',
)

/** Runs a tool and returns its exit status and both streams joined. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/**
 * Reads the signature kind out of `codesign -dv --verbose=4` output: ad hoc,
 * or signed by a named authority chain with a team identifier. Exported so the
 * parsing is unit tested without a signed bundle.
 */
export function parseCodesignDisplay(output) {
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim())
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim()
  const flags = /flags=0x[0-9a-f]*\(([^)]*)\)/.exec(output)?.[1]?.split(',') ?? []
  return {
    adhoc: /^Signature=adhoc$/m.test(output) || flags.includes('adhoc'),
    authorities,
    teamIdentifier: team === undefined || team === 'not set' ? null : team,
    runtime: flags.includes('runtime'),
    timestamped: /^Timestamp=/m.test(output),
  }
}

/**
 * Whether `spctl --assess --verbose` accepted the bundle as a notarized
 * Developer ID app. A plain Developer ID signature without notarization is
 * reported as `source=Developer ID`, which Gatekeeper refuses on a fresh Mac.
 */
export function parseSpctl(status, output) {
  return {
    accepted: status === 0 && /: accepted$/m.test(output),
    notarized: /^source=Notarized Developer ID$/m.test(output),
  }
}

/** The entitlement keys of a plist, as `codesign -d --entitlements - --xml` prints one or a file holds it. */
export function entitlementKeys(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  return [...body.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1].trim()).sort()
}

/** What differs between the entitlements found and the ones the plist allows: both ways count. */
export function entitlementFailures(found, expected, source) {
  const failures = []
  for (const key of found) {
    if (!expected.includes(key)) failures.push(`entitlement ${key} is not in ${source}`)
  }
  for (const key of expected) {
    if (!found.includes(key)) failures.push(`entitlement ${key} from ${source} is missing`)
  }
  return failures
}

/** The failures for the Agent SDK's CLI binary: Anthropic's own signature, hardened and timestamped. */
export function sdkBinaryFailures(signature) {
  const failures = []
  if (signature.adhoc || signature.teamIdentifier !== SDK_SIGNER_TEAM) {
    failures.push(
      `the Agent SDK binary is not signed by team ${SDK_SIGNER_TEAM} (Anthropic): it was re-signed, or the SDK changed signer`,
    )
  }
  if (!signature.runtime)
    failures.push('the Agent SDK binary is not signed for the hardened runtime')
  if (!signature.timestamped)
    failures.push('the Agent SDK binary signature has no secure timestamp')
  return failures
}

/** The failures for one signature reading, empty when the bundle passes. */
export function signatureFailures(signature, { distribution, hardened = false }) {
  const failures = []
  if ((distribution || hardened) && !signature.runtime) {
    failures.push('the app is not signed for the hardened runtime')
  }
  if (!distribution) return failures
  if (signature.adhoc) failures.push('the app is signed ad hoc, not with a Developer ID')
  if (!signature.authorities.some((name) => name.startsWith('Developer ID Application:'))) {
    failures.push('no "Developer ID Application" authority in the signature')
  }
  if (signature.teamIdentifier === null) failures.push('the signature names no team identifier')
  return failures
}

function check(app, { distribution, hardened }) {
  const failures = []
  const say = (line) => console.log(`[release-check] ${line}`)

  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  if (verify.status === 0) say('codesign --verify: the seal is valid')
  else failures.push(`codesign --verify failed:\n${verify.output}`)

  const display = run('codesign', ['-dv', '--verbose=4', app])
  if (display.status !== 0) {
    failures.push(`codesign -dv failed:\n${display.output}`)
  } else {
    const signature = parseCodesignDisplay(display.output)
    say(
      signature.adhoc
        ? 'codesign -dv: signed ad hoc (a local build)'
        : `codesign -dv: signed by ${signature.authorities[0] ?? 'an unnamed authority'}, team ${signature.teamIdentifier ?? 'not set'}`,
    )
    failures.push(...signatureFailures(signature, { distribution, hardened }))
  }

  if (distribution || hardened) {
    const source = distribution ? DISTRIBUTION_ENTITLEMENTS : HARDENED_ENTITLEMENTS
    const shown = run('codesign', ['-d', '--entitlements', '-', '--xml', app])
    const found = entitlementKeys(shown.output)
    const entitlementProblems = entitlementFailures(
      found,
      entitlementKeys(readFileSync(source, 'utf8')),
      source,
    )
    if (entitlementProblems.length === 0)
      say(`entitlements: exactly ${source} (${found.join(', ')})`)
    failures.push(...entitlementProblems)
  }

  const scope = join(app, SDK_SCOPE)
  const binaries = existsSync(scope)
    ? readdirSync(scope)
        .filter((name) => name.startsWith('claude-agent-sdk-darwin-'))
        .map((name) => join(scope, name, 'claude'))
        .filter((path) => existsSync(path))
    : []
  if (binaries.length === 0) failures.push('no Agent SDK CLI binary unpacked in the bundle')
  for (const binary of binaries) {
    const shown = run('codesign', ['-dv', '--verbose=4', binary])
    const problems = sdkBinaryFailures(parseCodesignDisplay(shown.output))
    const version = run(binary, ['--version'])
    if (version.status !== 0) problems.push(`the Agent SDK binary does not run:\n${version.output}`)
    if (problems.length === 0) {
      say(
        `Agent SDK binary: Anthropic's signature kept, hardened, timestamped, runs (${version.output.trim()})`,
      )
    }
    failures.push(...problems)
  }

  if (!distribution) {
    say('local mode: spctl and stapler are skipped; run with --distribution before a tag')
    return failures
  }

  const assess = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
  const gatekeeper = parseSpctl(assess.status, assess.output)
  if (!gatekeeper.accepted) failures.push(`spctl --assess rejected the app:\n${assess.output}`)
  else if (!gatekeeper.notarized) {
    failures.push(`spctl --assess accepted the app but not as notarized:\n${assess.output}`)
  } else say('spctl --assess: accepted, source=Notarized Developer ID')

  const staple = run('xcrun', ['stapler', 'validate', app])
  if (staple.status === 0) say('stapler validate: the notarization ticket is stapled')
  else failures.push(`xcrun stapler validate failed:\n${staple.output}`)

  return failures
}

function main(argv) {
  const distribution = argv.includes('--distribution')
  const hardened = argv.includes('--hardened')
  if (distribution && hardened) {
    console.error('[release-check] pass --hardened or --distribution, not both')
    return 1
  }
  const app = resolve(argv.find((arg) => !arg.startsWith('--')) ?? DEFAULT_APP)
  if (process.platform !== 'darwin') {
    console.error('[release-check] codesign and spctl exist on macOS only')
    return 1
  }
  if (!existsSync(app)) {
    console.error(`[release-check] no app at ${app}; run npm run package first`)
    return 1
  }
  const failures = check(app, { distribution, hardened })
  for (const failure of failures) console.error(`[release-check] FAIL: ${failure}`)
  if (failures.length === 0) console.log(`[release-check] ${app}: ok`)
  return failures.length === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
