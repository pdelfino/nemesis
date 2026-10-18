import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { BufferInfo } from '../shared/buffers'
import type { EnvironmentContent } from '../shared/environment'
import type { AgentNoticeEvent, AgentStartedEvent } from './agent/events'
import type { BufferRegistry } from './buffers'
import { displayPath } from './diffs'

/**
 * The environment panel (#86): the guide's "configure your environment" as
 * one buffer. The files that shape a session live in different places, the
 * user's `~/.claude`, the project's `.claude`, every CLAUDE.md from the git
 * root down to the working directory, `.mcp.json`; the SDK's init frame adds
 * what the session itself reached: its MCP servers with their status, its
 * skills, subagents, slash commands, plugins, model and Claude Code version.
 * The `environment` command collects the lot for the session's working
 * directory and shows it in one `environment` buffer, read-only like the
 * help buffer, one buffer reused by every call.
 *
 * The collectors are pure functions over a working directory, a home, a git
 * root and the started event: the unit tests run them against the fixture
 * tree under tests/fixtures/environment/. They read only the files named
 * here, by name, and show only what the panel lists: the permission rules as
 * text, never granted or edited; the hooks by event and command, cut short;
 * the names of the MCP servers in `.mcp.json`, never their `env` blocks, so
 * no secret from a settings file reaches the buffer or a log. A settings
 * file that is not valid JSON is reported as such, without the parser's
 * message, which quotes the content.
 *
 * `RET` on the panel opens a listed file through the one door of #68: the
 * file is read off the palette over the panel's own list, which is the
 * allowlist, the user says yes in the prompt buffer, and then the system's
 * default application gets the path. `edit-claude-md` takes the nearest
 * CLAUDE.md through the same door, with the guide's reminder as a notice at
 * that moment. `doctor` re-runs the length check and lists the files over
 * the threshold, since the SDK exposes no pruning check of its own.
 *
 * Plain data and Node built-ins, no Electron types, like the diff buffers:
 * src/main/index.ts hands in the prompt buffer's confirm, `shell.openPath`
 * and the session manager's started event.
 */

/** The renderer element the environment buffer shows in (src/renderer/index.html). */
export const ENVIRONMENT_ELEMENT_ID = 'environment'

export const ENVIRONMENT_TITLE = 'Environment'

/** The guide's thresholds for a CLAUDE.md that still gets read: past either, the panel warns. */
export const CLAUDE_MD_MAX_LINES = 200
export const CLAUDE_MD_MAX_BYTES = 12 * 1024

/** The guide's test for every line of a CLAUDE.md, quoted by the warning and by edit-claude-md. */
export const CLAUDE_MD_TEST = 'would removing this line cause mistakes?'

/** The notice edit-claude-md shows the moment the file is about to open. */
export const CLAUDE_MD_REMINDER = `A bloated CLAUDE.md gets ignored. For every line ask: ${CLAUDE_MD_TEST} If not, cut it.`

/** A hook command longer than this is cut in the panel: the user reads which hook, not a script. */
const MAX_HOOK_COMMAND = 72

/** The line under the panel, so the one key is known. */
export const ENVIRONMENT_KEYS_HINT =
  'RET opens a listed file with the default application, after a yes'

/** One CLAUDE.md that applies to the working directory. */
export interface InstructionFile {
  readonly path: string
  readonly lines: number
  readonly bytes: number
  /** Past the guide's thresholds: the panel warns. */
  readonly long: boolean
}

/** The permission rules of one settings file, as text. */
export interface PermissionRules {
  readonly path: string
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly ask: readonly string[]
}

/** One hook of a settings file: the event, the matcher and the command, cut short. */
export interface HookEntry {
  readonly event: string
  readonly matcher: string | null
  readonly command: string
}

export interface HooksFile {
  readonly path: string
  readonly hooks: readonly HookEntry[]
}

/** A skill or a subagent found on disk: its name and the file that defines it. */
export interface NamedFile {
  readonly name: string
  readonly path: string
}

/** One settings file the panel read, or tried to. */
export interface SettingsFile {
  readonly path: string
  readonly exists: boolean
  /** Set when the file exists but is not valid JSON or not an object. */
  readonly unreadable: boolean
}

export interface EnvironmentReport {
  readonly cwd: string
  readonly home: string
  /** The git root above the working directory, or null when there is none. */
  readonly root: string | null
  readonly instructions: readonly InstructionFile[]
  readonly settings: readonly SettingsFile[]
  readonly permissions: readonly PermissionRules[]
  readonly hooks: readonly HooksFile[]
  readonly skills: readonly NamedFile[]
  readonly agents: readonly NamedFile[]
  /** The `.mcp.json` of the working directory: the file and the server names, or null when there is none. */
  readonly mcpFile: { readonly path: string; readonly names: readonly string[] } | null
  /** The init frame of the running session, or null before the first prompt. */
  readonly started: AgentStartedEvent | null
}

export interface CollectOptions {
  readonly cwd: string
  readonly home: string
  readonly root: string | null
  readonly started: AgentStartedEvent | null
}

/**
 * The git root above `cwd`, the nearest folder with a `.git` entry (a
 * folder, or the file a worktree keeps), `cwd` itself included; null when
 * no parent has one.
 */
export function findGitRoot(cwd: string): string | null {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The folders whose CLAUDE.md files apply, the root first and the working
 * directory last, as Claude Code loads them. Without a root, or with a root
 * the working directory is not under, the working directory alone.
 */
export function instructionDirs(cwd: string, root: string | null): readonly string[] {
  if (root === null || !isUnder(root, cwd)) return [cwd]
  const dirs: string[] = []
  let dir = cwd
  while (dir !== root) {
    dirs.unshift(dir)
    dir = dirname(dir)
  }
  dirs.unshift(root)
  return dirs
}

/** True when `path` is `dir` or inside it; a sibling whose name starts with two dots is not. */
function isUnder(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel.length === 0 || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Every CLAUDE.md that applies to `cwd`, in the order Claude Code reads them:
 * the user's, then `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` of
 * every folder from the root down to `cwd`. Only the files that exist.
 */
export function collectInstructions(
  cwd: string,
  home: string,
  root: string | null,
): readonly InstructionFile[] {
  const candidates = [join(home, '.claude', 'CLAUDE.md')]
  for (const dir of instructionDirs(cwd, root)) {
    candidates.push(
      join(dir, 'CLAUDE.md'),
      join(dir, 'CLAUDE.local.md'),
      join(dir, '.claude', 'CLAUDE.md'),
    )
  }
  const files: InstructionFile[] = []
  for (const path of candidates) {
    const file = measure(path)
    if (file !== null) files.push(file)
  }
  return files
}

function measure(path: string): InstructionFile | null {
  if (!isRegularFile(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = countLines(text)
  return { path, lines, bytes, long: lines > CLAUDE_MD_MAX_LINES || bytes > CLAUDE_MD_MAX_BYTES }
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

/** The settings files whose rules and hooks apply, in the order they are layered. */
export function settingsPaths(cwd: string, home: string): readonly string[] {
  return [
    join(home, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]
}

/** A parsed JSON object, or null when the file is absent, unreadable or not an object. */
function readJsonObject(path: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** The `allow`, `deny` and `ask` lists of a parsed settings file, as text. */
export function permissionsOf(path: string, settings: Record<string, unknown>): PermissionRules {
  const block = settings['permissions']
  const rules = isRecord(block) ? block : {}
  return {
    path,
    allow: strings(rules['allow']),
    deny: strings(rules['deny']),
    ask: strings(rules['ask']),
  }
}

/**
 * The hooks of a parsed settings file: `hooks` maps an event name to entries
 * with an optional `matcher` and a list of hooks, each a `command` or another
 * type; the command is cut to one line's worth.
 */
export function hooksOf(path: string, settings: Record<string, unknown>): HooksFile {
  const block = settings['hooks']
  const hooks: HookEntry[] = []
  if (isRecord(block)) {
    for (const [event, entries] of Object.entries(block)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (!isRecord(entry)) continue
        const matcher = typeof entry['matcher'] === 'string' ? entry['matcher'] : null
        const inner = Array.isArray(entry['hooks']) ? entry['hooks'] : []
        for (const hook of inner) {
          if (!isRecord(hook)) continue
          hooks.push({ event, matcher, command: hookCommand(hook) })
        }
      }
    }
  }
  return { path, hooks }
}

function hookCommand(hook: Record<string, unknown>): string {
  const command = hook['command']
  if (typeof command === 'string') return truncate(oneLine(command), MAX_HOOK_COMMAND)
  const type = hook['type']
  return typeof type === 'string' ? `(${type} hook)` : '(hook)'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** The skills under `<dir>/.claude/skills`, one folder with a SKILL.md each, sorted. The files themselves are not read. */
export function collectSkills(dir: string): readonly NamedFile[] {
  const skillsDir = join(dir, '.claude', 'skills')
  return listDir(skillsDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(skillsDir, entry.name, 'SKILL.md') }))
    .filter((skill) => isRegularFile(skill.path))
    .sort(byName)
}

/** The subagents under `<dir>/.claude/agents`, one Markdown file each, sorted. The files themselves are not read. */
export function collectAgents(dir: string): readonly NamedFile[] {
  const agentsDir = join(dir, '.claude', 'agents')
  return listDir(agentsDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => ({ name: entry.name.slice(0, -3), path: join(agentsDir, entry.name) }))
    .sort(byName)
}

function listDir(dir: string): readonly Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function byName(a: NamedFile, b: NamedFile): number {
  return a.name.localeCompare(b.name)
}

/**
 * The server names in `<cwd>/.mcp.json`, and nothing else of it: the `env`
 * block of an entry is where a token lives. Null when the file is absent;
 * an unreadable file lists no names.
 */
export function collectMcpFile(
  cwd: string,
): { readonly path: string; readonly names: readonly string[] } | null {
  const path = join(cwd, '.mcp.json')
  if (!isRegularFile(path)) return null
  const parsed = readJsonObject(path)
  const servers = parsed?.['mcpServers']
  return { path, names: isRecord(servers) ? Object.keys(servers).sort() : [] }
}

/** The whole environment of `cwd`, read off disk once. */
export function collectEnvironment(options: CollectOptions): EnvironmentReport {
  const { cwd, home, root, started } = options
  const settings: SettingsFile[] = []
  const permissions: PermissionRules[] = []
  const hooks: HooksFile[] = []
  for (const path of settingsPaths(cwd, home)) {
    if (!isRegularFile(path)) {
      settings.push({ path, exists: false, unreadable: false })
      continue
    }
    const parsed = readJsonObject(path)
    settings.push({ path, exists: true, unreadable: parsed === null })
    if (parsed === null) continue
    permissions.push(permissionsOf(path, parsed))
    hooks.push(hooksOf(path, parsed))
  }
  return {
    cwd,
    home,
    root,
    instructions: collectInstructions(cwd, home, root),
    settings,
    permissions,
    hooks,
    skills: [...collectSkills(cwd), ...collectSkills(home)],
    agents: [...collectAgents(cwd), ...collectAgents(home)],
    mcpFile: collectMcpFile(cwd),
    started,
  }
}

/** Every file the panel lists, in panel order and each once: the allowlist for `RET`. */
export function listedFiles(report: EnvironmentReport): readonly string[] {
  const paths = [
    ...report.instructions.map((file) => file.path),
    ...report.settings.filter((file) => file.exists).map((file) => file.path),
    ...report.skills.map((file) => file.path),
    ...(report.mcpFile === null ? [] : [report.mcpFile.path]),
    ...report.agents.map((file) => file.path),
  ]
  return [...new Set(paths)]
}

/**
 * The nearest CLAUDE.md to `cwd` (#86): the working directory's own, then
 * its parents' up to the root, then the user's. Null when none exists.
 */
export function nearestClaudeMd(report: EnvironmentReport): string | null {
  const dirs = [...instructionDirs(report.cwd, report.root)].reverse()
  for (const dir of dirs) {
    for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const path = join(dir, name)
      if (report.instructions.some((file) => file.path === path)) return path
    }
  }
  const user = join(report.home, '.claude', 'CLAUDE.md')
  return report.instructions.some((file) => file.path === user) ? user : null
}

/** A size as the panel prints it: bytes under a kilobyte, else one decimal of kilobytes. */
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/** A path as the panel prints it: under the working directory relative, under the home with `~`, else as is. */
export function shortPath(report: Pick<EnvironmentReport, 'cwd' | 'home'>, path: string): string {
  if (isUnder(report.cwd, path) && path !== report.cwd) return relative(report.cwd, path)
  if (path === report.home) return '~'
  if (path.startsWith(report.home + sep))
    return `~/${relative(report.home, path).split(sep).join('/')}`
  return path
}

/** The one line the panel and doctor print for a CLAUDE.md. */
function describeInstruction(report: EnvironmentReport, file: InstructionFile): string {
  return `${shortPath(report, file.path)}: ${plural(file.lines, 'line')}, ${formatBytes(file.bytes)}`
}

/** Why a CLAUDE.md is long, in the guide's terms. */
function overThreshold(file: InstructionFile): string {
  const reasons: string[] = []
  if (file.lines > CLAUDE_MD_MAX_LINES) reasons.push(`over ${CLAUDE_MD_MAX_LINES} lines`)
  if (file.bytes > CLAUDE_MD_MAX_BYTES) reasons.push(`over ${formatBytes(CLAUDE_MD_MAX_BYTES)}`)
  return reasons.join(' and ')
}

/** The warning line under a long CLAUDE.md. */
export function lengthWarning(file: InstructionFile): string {
  return `Warning: ${overThreshold(file)}. The guide's test for every line: ${CLAUDE_MD_TEST}`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? '(none)' : items.join(', ')
}

const NO_SESSION = '(no session yet)'

/** The panel as text, one section per kind of thing, the files by their short paths. */
export function renderEnvironment(report: EnvironmentReport): string {
  const lines: string[] = [`Environment of ${report.cwd}`]
  lines.push(report.root === null ? 'Git root: none' : `Git root: ${report.root}`)

  lines.push('', `CLAUDE.md files (${report.instructions.length})`)
  if (report.instructions.length === 0) lines.push('  (none)')
  for (const file of report.instructions) {
    lines.push(`  ${describeInstruction(report, file)}`)
    if (file.long) lines.push(`    ${lengthWarning(file)}`)
  }

  lines.push('', 'Permission rules (shown as text; the panel grants and edits nothing)')
  for (const file of report.settings) {
    const short = shortPath(report, file.path)
    if (!file.exists) {
      lines.push(`  ${short}: no file`)
      continue
    }
    if (file.unreadable) {
      lines.push(`  ${short}: not valid JSON`)
      continue
    }
    const rules = report.permissions.find((entry) => entry.path === file.path)
    if (rules === undefined) continue
    lines.push(`  ${short}`)
    lines.push(`    allow: ${listOrNone(rules.allow)}`)
    lines.push(`    deny: ${listOrNone(rules.deny)}`)
    lines.push(`    ask: ${listOrNone(rules.ask)}`)
  }

  lines.push('', 'Hooks')
  for (const file of report.hooks) {
    const short = shortPath(report, file.path)
    if (file.hooks.length === 0) {
      lines.push(`  ${short}: no hooks`)
      continue
    }
    lines.push(`  ${short}`)
    for (const hook of file.hooks) {
      const matcher = hook.matcher === null ? '' : ` (${hook.matcher})`
      lines.push(`    ${hook.event}${matcher}: ${hook.command}`)
    }
  }
  if (report.hooks.length === 0) lines.push('  (no settings file)')

  const started = report.started
  const named = (files: readonly NamedFile[]): string =>
    listOrNone(files.map((file) => `${file.name} (${shortPath(report, file.path)})`))
  const fromSession = (items: readonly string[] | undefined): string =>
    started === null ? NO_SESSION : listOrNone(items ?? [])

  lines.push('', 'Skills')
  lines.push(`  On disk: ${named(report.skills)}`)
  lines.push(`  From the session: ${fromSession(started?.skills)}`)

  lines.push('', 'MCP servers')
  lines.push(
    `  From the session: ${
      started === null
        ? NO_SESSION
        : listOrNone(
            (started.mcpServers ?? []).map((server) => `${server.name} (${server.status})`),
          )
    }`,
  )
  lines.push(
    report.mcpFile === null
      ? '  .mcp.json: no file'
      : `  ${shortPath(report, report.mcpFile.path)}: ${listOrNone(report.mcpFile.names)}`,
  )

  lines.push('', 'Subagents')
  lines.push(`  On disk: ${named(report.agents)}`)
  lines.push(`  From the session: ${fromSession(started?.agents)}`)

  lines.push('', 'Session')
  if (started === null) {
    lines.push("  No session yet: the SDK's lists arrive with the first prompt.")
  } else {
    lines.push(`  Model: ${started.model}`)
    lines.push(`  Claude Code: ${started.claudeCodeVersion ?? '(not reported)'}`)
    lines.push(
      `  Plugins: ${listOrNone(
        (started.plugins ?? []).map((plugin) =>
          plugin.version === undefined ? plugin.name : `${plugin.name} ${plugin.version}`,
        ),
      )}`,
    )
    lines.push(`  Slash commands: ${listOrNone(started.slashCommands ?? [])}`)
  }

  lines.push('', `${ENVIRONMENT_KEYS_HINT}.`)
  return lines.join('\n')
}

/** What `doctor` answers: the CLAUDE.md files over the threshold, or that all are within it. */
export function renderDoctor(report: EnvironmentReport): string {
  const long = report.instructions.filter((file) => file.long)
  const total = report.instructions.length
  if (total === 0) return `Doctor: no CLAUDE.md applies to ${report.cwd}.`
  if (long.length === 0) {
    return `Doctor: all ${plural(total, 'CLAUDE.md file')} within ${CLAUDE_MD_MAX_LINES} lines and ${formatBytes(CLAUDE_MD_MAX_BYTES)}.`
  }
  const lines = [
    `Doctor: ${long.length} of ${plural(total, 'CLAUDE.md file')} over the threshold (${CLAUDE_MD_MAX_LINES} lines or ${formatBytes(CLAUDE_MD_MAX_BYTES)}):`,
  ]
  for (const file of long) {
    lines.push(`  ${describeInstruction(report, file)} (${overThreshold(file)})`)
  }
  lines.push('', `The guide's test for every line: ${CLAUDE_MD_TEST}`)
  return lines.join('\n')
}

export interface EnvironmentBuffersOptions {
  readonly cwd: string
  readonly home: string
  /** The init frame of the running session, or null (#86). */
  readonly started: () => AgentStartedEvent | null
  /** Asks the user; true is a yes. */
  readonly confirm: (question: string) => Promise<boolean>
  /** Hands a path to the system. Resolves with an empty string, or the system's error, as `shell.openPath` does. */
  readonly open: (path: string) => Promise<string>
  /** The git root finder; the default walks up from the working directory. */
  readonly findRoot?: ((cwd: string) => string | null) | undefined
}

export type EnvironmentShownListener = (content: EnvironmentContent) => void
export type EnvironmentNoticeListener = (event: AgentNoticeEvent) => void

export class EnvironmentBuffers {
  private readonly buffers: BufferRegistry
  private readonly options: EnvironmentBuffersOptions
  private readonly shownListeners = new Set<EnvironmentShownListener>()
  private readonly noticeListeners = new Set<EnvironmentNoticeListener>()
  private bufferId: string | null = null
  /** The last report, whose files are the ones `RET` may open. */
  private report: EnvironmentReport | null = null

  constructor(buffers: BufferRegistry, options: EnvironmentBuffersOptions) {
    this.buffers = buffers
    this.options = options
    buffers.subscribe((list) => {
      if (this.bufferId !== null && !list.buffers.some((buffer) => buffer.id === this.bufferId)) {
        this.bufferId = null
      }
    })
  }

  /** The bridge subscribes and pushes the text to the window. */
  onShown(listener: EnvironmentShownListener): () => void {
    this.shownListeners.add(listener)
    return () => {
      this.shownListeners.delete(listener)
    }
  }

  /** The session bridge subscribes: a notice is shown and recorded like any event. */
  on(listener: EnvironmentNoticeListener): () => void {
    this.noticeListeners.add(listener)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  /** The environment buffer, when one is open. */
  get buffer(): BufferInfo | null {
    return this.bufferId === null ? null : (this.buffers.get(this.bufferId) ?? null)
  }

  /** Reads the environment off disk and the session now. */
  collect(): EnvironmentReport {
    const { cwd, home } = this.options
    const root = (this.options.findRoot ?? findGitRoot)(cwd)
    this.report = collectEnvironment({ cwd, home, root, started: this.options.started() })
    return this.report
  }

  /** Shows the environment in its buffer and gives it the point. */
  show(): BufferInfo {
    const text = renderEnvironment(this.collect())
    const buffer =
      this.buffer ??
      this.buffers.create({
        kind: 'environment',
        title: ENVIRONMENT_TITLE,
        elementId: ENVIRONMENT_ELEMENT_ID,
      })
    this.bufferId = buffer.id
    // The window gets the text before the point moves to it.
    for (const listener of [...this.shownListeners]) listener({ bufferId: buffer.id, text })
    this.buffers.switchTo(buffer.id)
    return buffer
  }

  /** The files the panel lists, for the palette: the last report's, collected now when there is none. */
  files(): readonly string[] {
    return listedFiles(this.report ?? this.collect())
  }

  /** The short form of a listed path, for the palette's label. */
  label(path: string): string {
    const report = this.report ?? this.collect()
    return shortPath(report, path)
  }

  /** What `doctor` answers. */
  doctor(): string {
    return renderDoctor(this.collect())
  }

  /**
   * `RET`: hands a listed file to the system, after a yes. Resolves true
   * only when the system was given the path. A path the panel did not list
   * is refused with a notice, and no question is asked: the list is the
   * allowlist.
   */
  async open(path: string): Promise<boolean> {
    const listed = this.files()
    const shown = displayPath(path)
    if (!listed.includes(path)) {
      this.notify(`Not opened: ${shown} is not a file the environment panel lists`)
      return false
    }
    if (!isRegularFile(path)) {
      this.notify(`Not opened: ${shown} is not a file on disk`)
      return false
    }
    let yes = false
    try {
      yes = await this.options.confirm(`Open ${shown} with the default application?`)
    } catch (error) {
      console.error('environment: the confirmation failed:', error)
    }
    if (!yes) {
      this.notify(`Not opened: ${shown}; nothing was launched (SECURITY.org, promise 2)`)
      return false
    }
    let failure: string
    try {
      failure = await this.options.open(path)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure.length > 0) {
      this.notify(`The system could not open ${shown}: ${displayPath(failure)}`)
      return false
    }
    this.notify(`Opened ${shown} with the default application`)
    return true
  }

  /**
   * `edit-claude-md`: the nearest CLAUDE.md through the same door, with the
   * guide's reminder as a notice first. No file: a notice says where one
   * would go, since the cockpit has no write surface to create it (#86).
   */
  async editClaudeMd(): Promise<boolean> {
    const report = this.collect()
    const path = nearestClaudeMd(report)
    if (path === null) {
      this.notify(
        `No CLAUDE.md applies to ${report.cwd}: create one there, or in ~/.claude, and keep it short. ${CLAUDE_MD_REMINDER}`,
      )
      return false
    }
    this.notify(`${basename(path)} at ${displayPath(path)}. ${CLAUDE_MD_REMINDER}`)
    return this.open(path)
  }

  private notify(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text }
    for (const listener of [...this.noticeListeners]) listener(event)
  }
}
