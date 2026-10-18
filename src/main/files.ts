import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The files of the working directory, for `@` in the prompt buffer (#83):
 * the guide's "reference files with @" made cheaper than typing a path. The
 * list is what `git ls-files --cached --others --exclude-standard` prints in
 * the session's folder, so `.gitignore` is respected and a build folder
 * never floods the palette; the command runs through `execFile`, never a
 * shell, with no argument that came from a page or a prompt. A folder that
 * is not a git checkout gets a bounded walk instead: a few levels deep, a
 * few thousand entries, the usual dependency and build folders skipped.
 *
 * Plain data, no Electron: the unit tests run the git path on a temporary
 * repository and the walk on a plain folder.
 */

/** Lists the files under `cwd`, relative to it, forward slashes. */
export type FileLister = (cwd: string) => Promise<readonly string[]>

/** More than this and the palette's one-time copy of the list stops paying for itself. */
export const MAX_FILES = 10_000

/** How deep the fallback walk goes below the working directory. */
const WALK_DEPTH = 6

/** Folders the fallback walk never enters: git has `.gitignore` for these. */
const WALK_SKIP = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'target', '.cache'])

/** A path longer than the palette answer limit could not be picked, so it is not listed. */
const MAX_PATH_LENGTH = 200

function usable(path: string): boolean {
  return path.length > 0 && path.length <= MAX_PATH_LENGTH && !path.includes('\n')
}

/** The git listing: tracked files plus untracked ones that are not ignored. */
export function listFilesWithGit(cwd: string): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        const files = stdout
          .split('\0')
          .filter(usable)
          .map((path) => path.split(sep).join('/'))
        resolve(files.slice(0, MAX_FILES))
      },
    )
  })
}

/** The fallback for a folder that is not a checkout: a bounded, breadth-first walk. */
export function walkFiles(cwd: string): readonly string[] {
  const files: string[] = []
  let level: string[] = [cwd]
  for (let depth = 0; depth <= WALK_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const folder of level) {
      let entries
      try {
        entries = readdirSync(folder, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!WALK_SKIP.has(entry.name)) next.push(join(folder, entry.name))
        } else if (entry.isFile()) {
          const path = relative(cwd, join(folder, entry.name)).split(sep).join('/')
          if (usable(path)) files.push(path)
          if (files.length >= MAX_FILES) return files.sort()
        }
      }
    }
    level = next
  }
  return files.sort()
}

/** Git when the folder is a checkout, the walk otherwise. */
export async function listWorkingFiles(cwd: string): Promise<readonly string[]> {
  try {
    return await listFilesWithGit(cwd)
  } catch {
    return walkFiles(cwd)
  }
}

export interface WorkingFilesOptions {
  readonly cwd: string
  /** Injected by the tests; production lists with git, then the walk. */
  readonly list?: FileLister | undefined
}

/** The files as of the last refresh: what the `files` palette source lists. */
export class WorkingFiles {
  private readonly options: WorkingFilesOptions
  private readonly list: FileLister
  private paths: readonly string[] = []

  constructor(options: WorkingFilesOptions) {
    this.options = options
    this.list = options.list ?? listWorkingFiles
  }

  get files(): readonly string[] {
    return this.paths
  }

  /** Lists the folder again; a read that follows shows the files as they are now. */
  async refresh(): Promise<readonly string[]> {
    this.paths = await this.list(this.options.cwd)
    return this.paths
  }
}
