import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, test, type Page } from '../e2e/_test'
import { launchApp, type LaunchedApp } from '../e2e/_launch'

/**
 * The opt-in real-SDK harness (#146). `make real` runs tests/real/ against
 * the real Agent SDK through the `claude` CLI login, never through an API
 * key, with a cheap model. It is outside the gate and CI: they have no login,
 * and every run spends a few Haiku turns of the maintainer's usage.
 *
 * The app is launched as every end-to-end spec launches it (NODE_ENV=test,
 * a throwaway profile, the notification spy, the page door), with one
 * difference: NEMESIS_REAL_SDK=1 makes the main process load the real SDK
 * instead of the mock (src/main/agent/session.ts, resolveDriver).
 *
 * The session's cwd is a throwaway folder with a project settings file whose
 * `ask` rules put the tools under test in front of the cockpit. The CLI reads
 * the user's own settings too, and an `allow` rule there (Bash, Write) would
 * answer before the permission bridge is asked; an `ask` rule wins over an
 * `allow`, so the request reaches the cockpit whatever the user allows.
 *
 * The specs assert the cockpit's side, never the model's wording: the
 * request appears with the right keys, a key answers it, the transcript and
 * the event stream record it.
 */

export const MODEL = 'claude-haiku-5-5'

/** One turn of a real model can take a while; the harness waits this long for it. */
export const TURN_TIMEOUT = 120_000

/** Skips the whole file unless the run asked for the real SDK. */
export function realOnly(): void {
  test.skip(
    process.env['NEMESIS_REAL_SDK'] !== '1',
    'The real-SDK harness runs only under make real (NEMESIS_REAL_SDK=1).',
  )
  test.setTimeout(5 * 60_000)
}

/** The tools the throwaway folder's settings send to the cockpit, whatever the user's settings allow. */
const ASKED_TOOLS = ['Bash', 'Write', 'Edit', 'mcp__nemesis__browser_snapshot']

export interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly steered?: boolean
  readonly isError?: boolean
  readonly outcome?: string
  readonly requestId?: string
  readonly toolUseId?: string
  readonly toolName?: string
  readonly name?: string
  readonly sessionId?: string
  readonly model?: string
  readonly cwd?: string
  readonly answer?: string
  readonly numTurns?: number
  readonly input?: Record<string, unknown>
  readonly questions?: readonly { readonly question: string }[]
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: {
    readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void
  }
}

export interface RealApp extends LaunchedApp {
  readonly page: Page
  /** The session's cwd: the throwaway folder. */
  readonly work: string
}

/** A throwaway folder for the session's cwd, with the `ask` rules in its project settings. */
export function workFolder(): string {
  // The real path: macOS's tmpdir is under a symlink, and the CLI reports the resolved cwd.
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'nemesis-real-work-')))
  mkdirSync(join(work, '.claude'))
  writeFileSync(
    join(work, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { ask: ASKED_TOOLS } }, null, 2)}\n`,
  )
  return work
}

/**
 * Launches the built app on the real SDK: Haiku through the settings, the
 * session in `work`, a throwaway profile unless `profile` names an earlier
 * launch's. Notifications are off and the blocker downloads nothing.
 */
export async function launchReal(
  work: string = workFolder(),
  profile: string | null = null,
): Promise<RealApp> {
  const launched = await launchApp(
    'nemesis-real-',
    [],
    {
      model: MODEL,
      notify: { finished: false, needsYou: false, error: false, sound: false },
      blockerUpdates: 'off',
      restore: false,
    },
    { NEMESIS_REAL_SDK: '1' },
    work,
    profile,
  )
  const page = await launched.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.__agentEvents = []
    w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
  })
  return { ...launched, page, work }
}

/**
 * The folder where the real CLI keeps the transcripts of sessions run in
 * `work`: under the user's own Claude configuration, named after the path
 * with every character that is not a letter or a digit turned into `-`.
 * Null for anything but a `nemesis-real-` folder in the system temp folder,
 * so a real project's transcripts are never named here (#153).
 */
export function cliProjectFolder(work: string): string | null {
  if (!basename(work).startsWith('nemesis-real-')) return null
  if (dirname(work) !== realpathSync(tmpdir())) return null
  const config = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  return join(config, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'))
}

/**
 * Deletes what a launch left behind: the profile and, when given, the work
 * folder, with the transcripts the CLI wrote for it (#153).
 */
export function cleanUp(...folders: readonly string[]): void {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true })
    const transcripts = cliProjectFolder(folder)
    if (transcripts !== null) rmSync(transcripts, { recursive: true, force: true })
  }
}

/** Every event of the session so far, through the public bridge. */
export function events(page: Page): Promise<AgentEvent[]> {
  return page.evaluate(() => (globalThis as unknown as TestWindow).__agentEvents ?? [])
}

export async function ofType(page: Page, type: string): Promise<AgentEvent[]> {
  return (await events(page)).filter((event) => event.type === type)
}

/** The transcript's lines, as the DOM shows them. */
export function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
export async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

/**
 * What the spec presses for one pending request: `y`, `n`, a digit. Called
 * again for the same request only after one of its questions was answered.
 */
export type Decide = (request: AgentEvent) => string

/**
 * Sends `text` and answers every request the turn raises with `decide`,
 * until the turn ends. The model may call a tool more than once, or a tool
 * the spec did not ask for, so every request is answered and returned, in
 * order, for the spec to assert on.
 */
export async function turn(page: Page, text: string, decide: Decide): Promise<AgentEvent[]> {
  const before = (await ofType(page, 'turn-end')).length
  await send(page, text)
  return settle(page, before, decide)
}

/** Answers requests until a turn past the `before`-th has ended; the requests seen, in order. */
export async function settle(page: Page, before: number, decide: Decide): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  const presses = new Map<string, number>()
  const deadline = Date.now() + TURN_TIMEOUT
  while (Date.now() < deadline) {
    const all = await events(page)
    if (all.filter((event) => event.type === 'turn-end').length > before) return seen
    const closed = new Set(
      all.filter((event) => event.type === 'permission-answered').map((event) => event.requestId),
    )
    const pending = all.find(
      (event) => event.type === 'permission-request' && !closed.has(event.requestId),
    )
    if (pending?.requestId !== undefined) {
      const id = pending.requestId
      const answered = all.filter(
        (event) => event.type === 'question-answered' && event.requestId === id,
      ).length
      const pressed = presses.get(id) ?? 0
      if (pressed === 0) seen.push(pending)
      if (pressed <= answered) {
        await expect(page.locator('#request')).toBeFocused()
        await page.keyboard.press(decide(pending))
        presses.set(id, pressed + 1)
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error(`The turn did not end within ${TURN_TIMEOUT / 1000} s`)
}

/** The tool result paired with a request, by its tool call's id. */
export async function resultOf(page: Page, request: AgentEvent): Promise<AgentEvent | undefined> {
  return (await ofType(page, 'tool-result')).find((event) => event.toolUseId === request.toolUseId)
}
