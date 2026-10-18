import { describe, expect, it } from 'vitest'
import {
  checkEvidenceHeader,
  describeCheckStatus,
  exitCodeIn,
  looksLikeEvidence,
  shortCommand,
  toolEvidenceHeader,
} from '../../src/shared/evidence'

// Evidence (#81): what the transcript and the Org file agree to head as a
// check, the verify key's run or a tool result that reads like one.

describe('what counts as evidence', () => {
  it('is a shell call whose command runs a check', () => {
    expect(looksLikeEvidence('Bash', 'npm test -- auth', 'nothing telling')).toBe(true)
    expect(looksLikeEvidence('Bash', 'npm run gate', '')).toBe(true)
    expect(looksLikeEvidence('Bash', 'cd app && make check', '')).toBe(true)
    expect(looksLikeEvidence('Bash', 'npx playwright test', '')).toBe(true)
    expect(looksLikeEvidence('Bash', 'cargo build --release', '')).toBe(true)
    expect(looksLikeEvidence('Bash', 'ls -la', 'a\nb')).toBe(false)
    expect(looksLikeEvidence('Bash', 'git status', '')).toBe(false)
  })

  it('or a shell call whose output reads like a test runner, a compiler or a linter', () => {
    expect(looksLikeEvidence('Bash', 'cat out.log', ' Tests  3 passed (3)')).toBe(true)
    expect(looksLikeEvidence('Bash', 'cat out.log', 'PASS src/auth.test.ts')).toBe(true)
    expect(looksLikeEvidence('Bash', null, 'src/a.ts(3,1): error TS2322: wrong')).toBe(true)
    expect(looksLikeEvidence('Bash', null, '12 passing')).toBe(true)
    expect(looksLikeEvidence('Bash', null, 'Exit code 1')).toBe(true)
    expect(looksLikeEvidence('Bash', null, 'passed the salt')).toBe(false)
  })

  it('never a call of any other tool', () => {
    expect(looksLikeEvidence('Read', null, ' Tests  3 passed (3)')).toBe(false)
    expect(looksLikeEvidence('Agent', 'npm test', 'PASS')).toBe(false)
  })
})

describe('the headers', () => {
  it('name the exit code a result spells, else whether the tool reported an error', () => {
    expect(exitCodeIn('ok\nExit code 2')).toBe(2)
    expect(exitCodeIn('exit code: 130')).toBe(130)
    expect(exitCodeIn('nothing')).toBeNull()
    expect(toolEvidenceHeader('npm test', ' 3 passed', false)).toBe('Evidence: npm test (passed)')
    expect(toolEvidenceHeader('npm test', 'FAIL', true)).toBe('Evidence: npm test (failed)')
    expect(toolEvidenceHeader('npm test', 'FAIL\nExit code 1', true)).toBe(
      'Evidence: npm test (exit 1)',
    )
    expect(toolEvidenceHeader(null, '3 passed', false)).toBe('Evidence: Bash (passed)')
  })

  it('keep a command to one line a header can hold', () => {
    expect(shortCommand('  npm   run\n gate ')).toBe('npm run gate')
    const long = `npm run ${'x'.repeat(100)}`
    expect(shortCommand(long)).toHaveLength(72)
    expect(shortCommand(long).endsWith('...')).toBe(true)
  })

  it('give the verify key its exit code and duration, or the signal, or that it did not run', () => {
    expect(describeCheckStatus({ exitCode: 0, signal: null, durationMs: 1234 })).toBe(
      'exit 0, 1.2s',
    )
    expect(describeCheckStatus({ exitCode: null, signal: 'SIGTERM', durationMs: 400 })).toBe(
      'signal SIGTERM, 0.4s',
    )
    expect(describeCheckStatus({ exitCode: null, signal: null, durationMs: 3 })).toBe(
      'did not run, 0.0s',
    )
    expect(
      checkEvidenceHeader('npm run gate', { exitCode: 1, signal: null, durationMs: 65_000 }),
    ).toBe('Evidence: npm run gate (exit 1, 65.0s)')
  })
})
