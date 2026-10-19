import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseWorktreeList,
  Worktrees,
  worktreePath,
  worktreeSlug,
  type GitRunner,
} from '../../src/main/worktrees'

// A worktree per window (#87): the task name is slugged, the path derived
// from the session folder, every git call made through execFile, and a
// worktree removed only when it is clean.

describe('worktreeSlug', () => {
  it('keeps lower case letters, digits and single inner dashes', () => {
    expect(worktreeSlug('Fix the Login bug!')).toBe('fix-the-login-bug')
    expect(worktreeSlug('  --café  au lait--  ')).toBe('cafe-au-lait')
    expect(worktreeSlug('../../etc/passwd')).toBe('etc-passwd')
    expect(worktreeSlug('-b main')).toBe('b-main')
  })

  it('is empty when nothing usable is left, and cut when long', () => {
    expect(worktreeSlug('!!!')).toBe('')
    expect(worktreeSlug('a'.repeat(100)).length).toBe(48)
    expect(worktreeSlug(`${'a'.repeat(47)} b`)).toBe('a'.repeat(47))
  })
})

describe('worktreePath', () => {
  it('is beside the session folder, named after it and the slug', () => {
    expect(worktreePath('/work/nemesis', 'fix-login')).toBe('/work/nemesis-fix-login')
  })
})

describe('parseWorktreeList', () => {
  it('reads the paths of the porcelain listing', () => {
    expect(
      parseWorktreeList(
        'worktree /work/a\nHEAD 123\nbranch refs/heads/main\n\nworktree /work/a-x\nHEAD 456\nbranch refs/heads/x\n',
      ),
    ).toEqual(['/work/a', '/work/a-x'])
  })
})

describe('Worktrees with a fake git', () => {
  function fake(fail: (args: readonly string[]) => boolean): {
    git: GitRunner
    calls: string[][]
  } {
    const calls: string[][] = []
    const git: GitRunner = (args) => {
      calls.push([...args])
      return fail(args) ? Promise.reject(new Error('fatal: nope')) : Promise.resolve('')
    }
    return { git, calls }
  }

  it('says a folder that is not a git checkout makes nothing', async () => {
    const { git, calls } = fake((args) => args[0] === 'rev-parse')
    const worktrees = new Worktrees({ git, exists: () => false })
    const notices: string[] = []
    worktrees.on((event) => {
      if (event.type === 'notice') notices.push(event.text)
    })
    expect(await worktrees.create('/work/plain', 'task')).toBeNull()
    expect(notices).toEqual(['No worktree made: /work/plain is not a git checkout.'])
    expect(calls.some((args) => args[0] === 'worktree')).toBe(false)
  })

  it('says a name already used makes nothing', async () => {
    const { git, calls } = fake(() => false)
    const worktrees = new Worktrees({ git, exists: () => false })
    const notices: string[] = []
    worktrees.on((event) => {
      if (event.type === 'notice') notices.push(event.text)
    })
    // The branch is there: rev-parse --verify succeeds.
    expect(await worktrees.create('/work/repo', 'Task')).toBeNull()
    expect(notices.at(-1)).toContain('the name task is already used')
    expect(calls.some((args) => args[0] === 'worktree')).toBe(false)
  })

  it('says a name with nothing to slug makes nothing and runs no git', async () => {
    const { git, calls } = fake(() => false)
    const worktrees = new Worktrees({ git })
    expect(await worktrees.create('/work/repo', '???')).toBeNull()
    expect(calls).toEqual([])
  })

  it('removes nothing that is dirty', async () => {
    const calls: string[][] = []
    const git: GitRunner = (args) => {
      calls.push([...args])
      return Promise.resolve(args[0] === 'status' ? ' M notes.txt\n' : '')
    }
    const worktrees = new Worktrees({ git })
    const removed = await worktrees.remove({
      repo: '/work/repo',
      path: '/work/repo-x',
      branch: 'x',
    })
    expect(removed).toBe(false)
    expect(calls).toEqual([['status', '--porcelain']])
  })
})

describe('Worktrees against a real repository', () => {
  const made: string[] = []
  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  function repository(): string {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nemesis-worktrees-')))
    made.push(parent)
    const repo = join(parent, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    }
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'notes.txt'), 'alpha\n')
    git('add', 'notes.txt')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')
    return repo
  }

  it('makes the worktree beside the folder on a new branch, lists it, and refuses the name again', async () => {
    const repo = repository()
    const worktrees = new Worktrees()
    const worktree = await worktrees.create(repo, 'Fix login')
    expect(worktree).toEqual({ repo, path: `${repo}-fix-login`, branch: 'fix-login' })
    expect(existsSync(join(`${repo}-fix-login`, 'notes.txt'))).toBe(true)
    expect(await worktrees.list(repo)).toEqual([repo, `${repo}-fix-login`])
    expect(await worktrees.create(repo, 'fix login')).toBeNull()
  })

  it('removes a clean worktree and keeps a dirty one', async () => {
    const repo = repository()
    const worktrees = new Worktrees()
    const dirty = await worktrees.create(repo, 'dirty')
    const clean = await worktrees.create(repo, 'clean')
    if (dirty === null || clean === null) throw new Error('no worktree made')
    writeFileSync(join(dirty.path, 'untracked.txt'), 'x\n')
    expect(await worktrees.isClean(dirty.path)).toBe(false)
    expect(await worktrees.remove(dirty)).toBe(false)
    expect(existsSync(dirty.path)).toBe(true)
    expect(await worktrees.isClean(clean.path)).toBe(true)
    expect(await worktrees.remove(clean)).toBe(true)
    expect(existsSync(clean.path)).toBe(false)
    expect(await worktrees.list(repo)).toEqual([repo, dirty.path])
  })

  it('says a plain folder is not a git checkout', async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nemesis-plain-')))
    made.push(parent)
    expect(await new Worktrees().create(parent, 'task')).toBeNull()
  })
})
