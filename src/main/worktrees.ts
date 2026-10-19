import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentEvent, AgentEventListener } from './agent/events'

/**
 * A worktree per window (#87), the guide's "run multiple Claude sessions":
 * parallel sessions want isolated checkouts. `new-window-in-worktree` reads
 * a task name, slugs it, and makes `<cwd>/../<basename>-<slug>` a git
 * worktree on a new branch named by the slug; the new window's session runs
 * there. Closing that window asks whether to remove the worktree, with keep
 * as the highlighted answer, and a removal goes through `git worktree
 * remove` only when `git status --porcelain` says the worktree is clean.
 *
 * Every git call is `execFile('git', [...])` with the folder as its cwd:
 * never a shell, so nothing typed is ever part of a command line, and the
 * path is derived from the session folder and the slug, never typed. The
 * slug is letters, digits and inner dashes only, so it can be neither an
 * option nor a path.
 *
 * Node built-ins only, no Electron: the unit tests drive it with a fake git
 * and against a real repository in a temp folder.
 */

/** Runs git with `args` in `cwd`; resolves with stdout, rejects with a message safe to show. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

/** A slug longer than this is cut: a folder and a branch name, not a sentence. */
const MAX_SLUG = 48

/** The real runner: git through execFile, no shell. */
export function runGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim().split('\n')[0] ?? ''
        reject(new Error(detail || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

/** A task name as a slug: lower case letters, digits and single inner dashes; empty when nothing is left. */
export function worktreeSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, MAX_SLUG).replace(/-+$/, '')
}

/** Where the worktree of `slug` goes: beside the session folder, named after it. */
export function worktreePath(cwd: string, slug: string): string {
  return join(dirname(cwd), `${basename(cwd)}-${slug}`)
}

/** The paths `git worktree list --porcelain` names, the main checkout first. */
export function parseWorktreeList(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

/** A worktree a window was opened in. */
export interface Worktree {
  /** The folder the worktree was made from, where `git worktree remove` runs. */
  readonly repo: string
  /** The worktree's own folder, the window's session folder. */
  readonly path: string
  /** The branch made for it, the slug. */
  readonly branch: string
}

export interface WorktreesOptions {
  /** Injected by the tests; production runs git. */
  readonly git?: GitRunner | undefined
  /** Injected by the tests; production asks the disk. */
  readonly exists?: ((path: string) => boolean) | undefined
}

export class Worktrees {
  private readonly git: GitRunner
  private readonly exists: (path: string) => boolean
  private readonly listeners = new Set<AgentEventListener>()

  constructor(options: WorktreesOptions = {}) {
    this.git = options.git ?? runGit
    this.exists = options.exists ?? existsSync
  }

  /** The session bridge subscribes: a notice is shown and recorded like any event. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Makes the worktree for a task name. A name with nothing to slug, a
   * folder that is not a git checkout, or a name whose folder or branch is
   * already there is a notice and null; nothing is made.
   */
  async create(cwd: string, name: string): Promise<Worktree | null> {
    const slug = worktreeSlug(name)
    if (slug.length === 0) {
      this.notify('No worktree made: the task name needs a letter or a digit.')
      return null
    }
    try {
      await this.git(['rev-parse', '--is-inside-work-tree'], cwd)
    } catch {
      this.notify(`No worktree made: ${cwd} is not a git checkout.`)
      return null
    }
    const path = worktreePath(cwd, slug)
    if (this.exists(path) || (await this.hasBranch(cwd, slug))) {
      this.notify(`No worktree made: the name ${slug} is already used, as a folder or a branch.`)
      return null
    }
    try {
      await this.git(['worktree', 'add', path, '-b', slug], cwd)
    } catch (error) {
      this.notify(`No worktree made: git said ${messageOf(error)}`)
      return null
    }
    this.notify(`Worktree made: ${path} on the new branch ${slug}; a new window works there.`)
    return { repo: cwd, path, branch: slug }
  }

  /** The worktrees of the checkout in `cwd`, the main one first. */
  async list(cwd: string): Promise<string[]> {
    return parseWorktreeList(await this.git(['worktree', 'list', '--porcelain'], cwd))
  }

  /** Whether the worktree has nothing uncommitted, untracked files included. */
  async isClean(path: string): Promise<boolean> {
    return (await this.git(['status', '--porcelain'], path)).trim().length === 0
  }

  /**
   * Removes the worktree, only when it is clean; its branch stays. Resolves
   * true when git removed it; a dirty worktree or a git failure is a notice.
   */
  async remove(worktree: Worktree): Promise<boolean> {
    let clean: boolean
    try {
      clean = await this.isClean(worktree.path)
    } catch (error) {
      this.notify(`Worktree kept: ${worktree.path}; git status failed: ${messageOf(error)}`)
      return false
    }
    if (!clean) {
      this.notify(`Worktree kept: ${worktree.path} has uncommitted changes.`)
      return false
    }
    try {
      await this.git(['worktree', 'remove', worktree.path], worktree.repo)
    } catch (error) {
      this.notify(`Worktree kept: git said ${messageOf(error)}`)
      return false
    }
    this.notify(`Worktree removed: ${worktree.path}; the branch ${worktree.branch} stays.`)
    return true
  }

  /** Says the worktree stays, for a close answered with keep. */
  kept(worktree: Worktree): void {
    this.notify(`Worktree kept: ${worktree.path}`)
  }

  private async hasBranch(cwd: string, branch: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)
      return true
    } catch {
      return false
    }
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
