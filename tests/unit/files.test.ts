import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listFilesWithGit, listWorkingFiles, walkFiles, WorkingFiles } from '../../src/main/files'

// The files `@` lists (#83): git's view of the working directory, ignores
// respected, or a bounded walk where there is no checkout.

const folders: string[] = []

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  folders.push(dir)
  return dir
}

function populate(dir: string): void {
  mkdirSync(join(dir, 'src', 'main'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}\n')
  writeFileSync(join(dir, 'src', 'main', 'index.ts'), 'export {}\n')
  writeFileSync(join(dir, 'src', 'untracked.ts'), 'export {}\n')
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '\n')
  writeFileSync(join(dir, 'out', 'bundle.js'), '\n')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\nout/\n')
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the git listing', () => {
  it('lists tracked and untracked files, never the ignored ones', async () => {
    const dir = folder('nemesis-files-git-')
    populate(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['add', 'package.json', 'src/main/index.ts'], { cwd: dir })
    const files = await listFilesWithGit(dir)
    expect([...files].sort()).toEqual([
      '.gitignore',
      'package.json',
      'src/main/index.ts',
      'src/untracked.ts',
    ])
    expect(await listWorkingFiles(dir)).toEqual(files)
  })

  it('rejects outside a checkout, so the walk takes over', async () => {
    const dir = folder('nemesis-files-plain-')
    populate(dir)
    await expect(listFilesWithGit(dir)).rejects.toThrow()
    expect(await listWorkingFiles(dir)).toEqual(walkFiles(dir))
  })
})

describe('the fallback walk', () => {
  it('walks the folder, skipping dependency and build folders, sorted', () => {
    const dir = folder('nemesis-files-walk-')
    populate(dir)
    expect(walkFiles(dir)).toEqual([
      '.gitignore',
      'package.json',
      'src/main/index.ts',
      'src/untracked.ts',
    ])
  })

  it('stops a few levels down', () => {
    const dir = folder('nemesis-files-deep-')
    let deep = dir
    for (let level = 1; level <= 8; level += 1) {
      deep = join(deep, `l${level}`)
      mkdirSync(deep)
      writeFileSync(join(deep, 'f.txt'), '')
    }
    const files = walkFiles(dir)
    expect(files).toContain('l1/l2/l3/l4/l5/l6/f.txt')
    expect(files).not.toContain('l1/l2/l3/l4/l5/l6/l7/f.txt')
  })
})

describe('the working files', () => {
  it('lists nothing until refreshed, then what the lister says', async () => {
    const files = new WorkingFiles({
      cwd: '/nowhere',
      list: (cwd) => Promise.resolve([`${cwd}/a.ts`, 'b.ts']),
    })
    expect(files.files).toEqual([])
    expect(await files.refresh()).toEqual(['/nowhere/a.ts', 'b.ts'])
    expect(files.files).toEqual(['/nowhere/a.ts', 'b.ts'])
  })
})
