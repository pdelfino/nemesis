// The signature half of `npm run release:check` (#74): checks the packaged
// Nemesis.app with the same tools Gatekeeper uses, so a bundle whose seal is
// broken, or that would be refused on another Mac, never gets a tag. The fuses
// half is tests/release/fuses.spec.ts.
//
// Two modes. The default checks a local build: the seal must verify, ad hoc or
// not, because Apple silicon kills a binary whose signature does not match (the
// note on #74). `--distribution` is the mode the release checklist runs before
// a tag: the app must also carry a Developer ID signature with a team, pass
// `spctl --assess` as notarized, and have the notarization ticket stapled.
//
// Usage: node scripts/release-check.mjs [--distribution] [path/to/Nemesis.app]

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_APP = join('release', 'mac-arm64', 'Nemesis.app')

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
  return {
    adhoc: /^Signature=adhoc$/m.test(output) || /flags=0x[0-9a-f]*\(adhoc/.test(output),
    authorities,
    teamIdentifier: team === undefined || team === 'not set' ? null : team,
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

/** The failures for one signature reading, empty when the bundle passes. */
export function signatureFailures(signature, { distribution }) {
  if (!distribution) return []
  const failures = []
  if (signature.adhoc) failures.push('the app is signed ad hoc, not with a Developer ID')
  if (!signature.authorities.some((name) => name.startsWith('Developer ID Application:'))) {
    failures.push('no "Developer ID Application" authority in the signature')
  }
  if (signature.teamIdentifier === null) failures.push('the signature names no team identifier')
  return failures
}

function check(app, distribution) {
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
    failures.push(...signatureFailures(signature, { distribution }))
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
  const app = resolve(argv.find((arg) => !arg.startsWith('--')) ?? DEFAULT_APP)
  if (process.platform !== 'darwin') {
    console.error('[release-check] codesign and spctl exist on macOS only')
    return 1
  }
  if (!existsSync(app)) {
    console.error(`[release-check] no app at ${app}; run npm run package first`)
    return 1
  }
  const failures = check(app, distribution)
  for (const failure of failures) console.error(`[release-check] FAIL: ${failure}`)
  if (failures.length === 0) console.log(`[release-check] ${app}: ok`)
  return failures.length === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
