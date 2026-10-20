import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The README pictures gate (#187), run the way `npm run gate` runs it.
const script = join(import.meta.dirname, '../../scripts/check-readme-images.mjs')

const run = (dir?: string) =>
  spawnSync(process.execPath, dir ? [script, dir] : [script], { encoding: 'utf8' })

describe('check-readme-images', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-readme-'))
    mkdirSync(join(dir, 'docs', 'images', 'logos'), { recursive: true })
    writeFileSync(
      join(dir, 'docs', 'images', 'logos', 'a.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    writeFileSync(
      join(dir, 'docs', 'images', 'logos', 'PROVENANCE.org'),
      '| a.svg | A | https://a | 2026-10-20 |\n',
    )
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes on the real repository', () => {
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('passes when every picture is there', () => {
    writeFileSync(
      join(dir, 'README.md'),
      '<img src="docs/images/logos/a.svg" height="20">\n\n```mermaid\nflowchart LR\n  a --> b\n```\n',
    )
    expect(run(dir).status).toBe(0)
  })

  it('fails on a missing image, an unclosed fence and a logo without provenance', () => {
    writeFileSync(join(dir, 'docs', 'images', 'logos', 'b.png'), 'x')
    writeFileSync(
      join(dir, 'README.md'),
      '![gone](docs/images/gone.png)\n\n```mermaid\nflowchart LR\n',
    )
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing image: docs/images/gone.png')
    expect(result.stderr).toContain('never closed')
    expect(result.stderr).toContain('without a PROVENANCE.org row: b.png')
  })

  it('ignores remote images', () => {
    writeFileSync(join(dir, 'README.md'), '![x](https://example.org/x.png)\n')
    expect(run(dir).status).toBe(0)
  })
})
