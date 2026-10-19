import { app, shell, WebContentsView, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { ClipboardReader } from './agent/images'
import { PermissionBridge } from './agent/permission-bridge'
import { PagePolicy } from './agent/page-policy'
import { CommandError } from './commands/registry'
import type { PromptQueue } from './agent/prompt-queue'
import { installSessionBridge, type EventSource } from './agent/session-bridge'
import type { AgentEvent } from './agent/events'
import { SessionManager } from './agent/session-manager'
import { installBufferBridge, installPageBridge } from './buffer-bridge'
import { createCockpitBuffers, type BufferRegistry } from './buffers'
import { confirm, CONFIRM_SOURCES, OPEN_FILE_SOURCE, VERIFY_SOURCE } from './commands/confirm'
import type { KeyDispatcher } from './commands/dispatcher'
import { installKeyBridge } from './commands/key-bridge'
import {
  createCockpitDispatcher,
  resolveCockpitDeps,
  type CockpitWindows,
} from './commands/keyscheme'
import { installPaletteBridge } from './commands/palette-bridge'
import { Prompter } from './commands/prompter'
import type { Command, CommandRegistry } from './commands/registry'
import type { EvalOutcome } from './config/eval'
import type { Journal } from './config/journal'
import type { ConfigLoader } from './config/loader'
import { DiffBuffers } from './diffs'
import { EnvironmentBuffers } from './environment'
import { UrlFetcher } from './fetch-url'
import { WorkingFiles } from './files'
import type { HelpBuffers, HelpListener } from './help'
import { fetchIssueWithGh, IssueAttachment } from './issues'
import { BufferTexts, diffText } from './mcp/buffer-texts'
import { IN_APP_SERVER } from './mcp/catalog'
import { CockpitMcp } from './mcp/server'
import { installNotifications } from './notify/install'
import { PlanBuffers } from './plans'
import { installSwipe, PageBuffers, type PagePolicies } from './page-buffer'
import type { PageScriptDoor } from './page-door'
import type { PageAnswers } from '../shared/page-door'
import type { PageBlocker } from './pages/blocker'
import { PageHints } from './pages/hints'
import { FormGuide } from './pages/form-guide'
import { FormGuideSession } from './agent/form-guide'
import { FORM_GUIDE_SHOWN_CHANNEL } from '../shared/form-guide'
import { ConsoleLog } from './pages/console'
import { SemanticView, semanticText } from './pages/semantic'
import { PAGES_FOLDER, ReaderBuffers, readerAttachment, type ReaderDocument } from './pages/reader'
import { Repl } from './repl'
import { ReviewBuffers } from './reviews'
import { Screenshots, SCREENSHOTS_FOLDER, type WindowCapturer } from './screenshots'
import type { SessionIndex } from './sessions'
import { SpecBuffers } from './specs'
import { TranscriptSearch } from './transcript-search'
import { SessionRecorder } from './transcripts'
import { EMPTY_STORE } from './url-sources'
import { BOOKMARKS_EXPORT, type Bookmarks } from './bookmarks'
import { recordHistory, type History } from './history'
import { Verifier, verifyQuestion } from './verify'
import { Worktrees } from './worktrees'

/**
 * One window's cockpit (#70): its buffers, its agent session and everything
 * that acts on the two, the prompter, the help buffers, the key dispatcher,
 * the session bridge and the recorder, the verifier, the diffs, the plans
 * and the environment panel. Two projects at once are two windows, each
 * with its own session; a prompt or a permission request of one never
 * reaches the other, because every bridge answers the window that called
 * and pushes to that window alone.
 *
 * What is the app's and not the window's comes in through `CockpitShared`:
 * the config file and its settings, the sessions folder as an index, the
 * eval journal, the clipboard and the screen, and the notices of the app's
 * own policies.
 */
export interface Cockpit {
  /** The id of the window's WebContents: what an IPC call's sender is matched on. */
  readonly id: number
  /** How the palette names the window, `Window 1` and up. */
  readonly name: string
  readonly window: BrowserWindow
  readonly buffers: BufferRegistry
  readonly prompter: Prompter
  readonly help: HelpBuffers
  readonly registry: CommandRegistry
  readonly agent: SessionManager
  /** This window's MCP server: the catalog an outside client or the in-app session sees (#28). */
  readonly mcp: CockpitMcp
  /** Where a prompt goes like one typed: the reviewer's first message comes in here (#87). */
  readonly prompts: PromptQueue
  /** The folder the window's session runs in (#87). */
  readonly cwd: string
  /** The worktrees this window made, and the notices of their removal (#87). */
  readonly worktrees: Worktrees
  /** The window's page buffers, one WebContentsView each (#119). */
  readonly pages: PageBuffers<WebContentsView>
  /** The semantic view of those pages, through the page-script door (#122). */
  readonly semantic: SemanticView
  /** Hint mode on those pages (#123). */
  readonly hints: PageHints
  /** Reader mode's buffers over those pages, through the page-script door (#128). */
  readonly readers: ReaderBuffers
  /** The form guide's watches over those pages (#94). */
  readonly formGuide: FormGuide
}

export interface CockpitShared {
  /** The config file (#71): the settings read at use time, and the source of its notices. */
  readonly config: ConfigLoader
  /** The sessions folder, read back for resume-session (#67). */
  readonly sessions: SessionIndex
  /** Null under `--no-config`. */
  readonly journal: Journal | null
  /** Eval in the config scope (#72). */
  readonly evaluate: (form: string) => Promise<EvalOutcome>
  /** The home the environment panel reads (#86). */
  readonly home: string
  readonly clipboard: ClipboardReader
  /** Puts text on the clipboard, as copy-hint-url does (#123); a stand-in under test. */
  readonly writeClipboardText: (text: string) => void
  /** The screen, as screenshot-window lists and captures its windows (#81). */
  readonly capturer: WindowCapturer
  /** The app's own notices, a refused permission or download, routed to this window. */
  readonly notices: EventSource
  /** The other windows, for `new-window` and the palette. */
  readonly windows: CockpitWindows
  /** The commands the cockpit registers beside its own (`reload-config`), given its help buffers. */
  readonly commands: (help: HelpBuffers) => readonly Command[]
  /** The baseline every page buffer runs under before its first load (#119). */
  readonly pagePolicies: PagePolicies<WebContentsView>
  /** The profile's history and bookmarks (#125), null when the database did not open. */
  readonly stores: { readonly history: History; readonly bookmarks: Bookmarks } | null
  /** The app's blocker (#126): every page buffer is attached to it in blocker mode. */
  readonly blocker?: PageBlocker
  /** The page-script door of ADR 0009 (#130), the app's one, which the semantic view asks (#122). */
  readonly pageDoor: PageScriptDoor
}

/** One stream of notices out of several sources. */
export function mergeNotices(...sources: readonly EventSource[]): EventSource {
  return {
    on: (listener) => {
      const offs = sources.map((source) => source.on(listener))
      return () => {
        for (const off of offs) off()
      }
    },
  }
}

/**
 * The folder a window's session runs in: the one the app was started in, or
 * a worktree's for a window new-window-in-worktree opened (#87).
 */
export function createCockpit(
  window: BrowserWindow,
  name: string,
  shared: CockpitShared,
  cwd: string = process.cwd(),
): Cockpit {
  const { config, journal } = shared
  const contents = window.webContents
  const settings = config.settings
  // The bridges' cleanups run from one `destroyed` listener, so the window's
  // listener count stays flat however many bridges it has (#136).
  const disposers: Array<() => void> = []
  const onDestroyed = (dispose: () => void): void => {
    disposers.push(dispose)
  }
  contents.once('destroyed', () => {
    for (const dispose of disposers.splice(0)) dispose()
  })
  // The buffer list is the spine: the keymap and the palette act on it, so it
  // exists before the page that shows it (#60).
  const buffers = createCockpitBuffers()
  installBufferBridge(buffers, contents)
  const prompter = new Prompter()
  // One agent session per window, in the window's folder (#87); the
  // SDK loads the CLI's own settings, so the permission rules are the CLI's
  // and so is the model unless the settings name one (#61, #64). It starts on
  // the first prompt, not at launch. A tool the rules ask about waits on a key
  // through the permission bridge (#63). Every event is written to the session
  // folder as it arrives (#64).
  // The agent and web boundary (#55, SECURITY.org T4): while a page buffer
  // is open, a side-effect tool needs a yes every call, and while a page is
  // the current buffer it is denied. The page buffers are built below; the
  // policy reads them when a tool is called.
  const boundary = new PagePolicy({
    folder: cwd,
    pages: {
      pageOpen: () => pages.list().length > 0,
      currentOrigin: () => {
        const current = buffers.current
        if (current?.kind !== 'page') return null
        try {
          return current.url === undefined ? 'a page not yet loaded' : new URL(current.url).origin
        } catch {
          return current.url ?? 'a page not yet loaded'
        }
      },
    },
  })
  const permissions = new PermissionBridge(buffers, {
    mustAsk: (request) => boundary.mustAsk(request),
  })
  const recorder = new SessionRecorder({ sessionsDir: settings.sessionsDir })
  // What search-transcripts scans (#69).
  const transcripts = new TranscriptSearch({ sessionsDir: settings.sessionsDir })
  // The guide's plan mode (#82): the one tool that leaves it, ExitPlanMode,
  // is taken here in front of the bridge and becomes a plan buffer; every
  // other request reaches the bridge untouched. An approval tells the manager
  // to leave plan mode, which is why the two reference each other.
  const plans: PlanBuffers = new PlanBuffers(buffers, permissions, {
    leavePlanMode: (): Promise<void> => agent.leavePlanMode(),
  })
  // The manager holds that session and swaps it on new-task or a rewind (#84).
  // The model is read when a session starts, so a reload's model is the
  // next session's (#71).
  const agent: SessionManager = new SessionManager({
    cwd,
    get model() {
      return config.settings.model
    },
    permissionHandler: plans,
    hooks: boundary.hooks(),
    requests: permissions,
    // The cockpit's own MCP server, in process (#28): the agent inside sees
    // the catalog an outside client does, minus the rows that would loop.
    mcpServers: () => ({
      [IN_APP_SERVER]: { type: 'sdk', name: IN_APP_SERVER, instance: mcp.serve('in-app') },
    }),
    // The stop gate (#113): the verify key's check at a gated turn's end,
    // the red evidence back through the prompt queue. Both exist below and
    // are read when a turn ends.
    stopGate: {
      verify: () => verifier.verify(),
      submit: (text) => prompts.submit(text),
      retries: () => config.settings.stopGateRetries,
    },
  })
  // Walking away (#90): a finished turn, a request or an error is a macOS
  // notification, and a Telegram push when its two variables are set, with
  // the session's name, the elapsed time and the tool-call count only. The
  // toggles are the settings' `notify` key (#114).
  installNotifications({
    window,
    agent,
    permissions,
    buffers,
    toggles: () => config.settings.notify,
    env: process.env,
  })
  // The Edit and Write calls of the session, listed and opened as diff
  // buffers (#68). The collector reads the live events and a resumed
  // session's history before the bridge pushes them, so list-diffs is never
  // behind the window; `C-c C-o` asks in the prompt buffer, then hands the
  // file to the system through `shell.openPath`, a door the environment
  // panel below shares.
  const diffs = new DiffBuffers(buffers, {
    confirm: (question) => confirm(prompter, OPEN_FILE_SOURCE, question),
    open: (path) => shell.openPath(path),
  })
  agent.on((event) => diffs.observe(event))
  agent.onHistory((history) => {
    for (const event of history) diffs.observe(event)
  })
  // The spec an interview ends with (#85): the agent's Write of SPEC.md,
  // once it went through, opens as a spec buffer with the fresh-session key.
  // Live events only: a resumed history reopens no spec.
  const specs = new SpecBuffers(buffers)
  agent.on((event) => specs.observe(event))
  // Writer and reviewer (#87): review-diff builds the reviewer's prompt from
  // the diffs above, the attached issue and the last plan the session
  // proposed, read here off the live events and a resumed history alike;
  // the reviewer's findings come back as a review buffer. The worktrees
  // new-window-in-worktree makes say what they did in this window.
  const reviews = new ReviewBuffers(buffers)
  agent.on((event) => reviews.observe(event))
  agent.onHistory((history) => {
    for (const event of history) reviews.observe(event)
  })
  const worktrees = new Worktrees()
  // The environment of the working directory as one buffer (#86): the
  // CLAUDE.md files, rules, hooks, skills, servers and subagents off disk
  // and off the session's init frame. A listed file opens through the same
  // door as a diff's: the question in the prompt buffer, then shell.openPath.
  const environment = new EnvironmentBuffers(buffers, {
    cwd,
    home: shared.home,
    started: () => agent.started,
    confirm: (question) => confirm(prompter, OPEN_FILE_SOURCE, question),
    open: (path) => shell.openPath(path),
    config: () => config.status,
  })
  // The verify key (#81): the check of the attached issue, else the settings'
  // verify entry, else npm run gate, run as a child of the cockpit with the
  // user's permissions in the folder it was started in, never through the
  // agent's tool path. The issue comes through the user's own gh login, and
  // its command, remote text, is confirmed in the prompt buffer before its
  // first run (#98).
  const issues = new IssueAttachment({ cwd, fetch: fetchIssueWithGh })
  const verifier = new Verifier({
    cwd,
    // Read on every check, so a reload's verify is the next check's (#71).
    get settingsCommand() {
      return config.settings.verify
    },
    issueBody: () => issues.current?.body ?? null,
    confirm: (command) => confirm(prompter, VERIFY_SOURCE, verifyQuestion(command)),
  })
  // A window of the screen into the prompt as an image (#81), the file
  // written under the sessions folder, the one place session data goes.
  const screenshots = new Screenshots({
    dir: join(settings.sessionsDir, SCREENSHOTS_FOLDER),
    capturer: shared.capturer,
  })
  // The guide's rich prompts (#83): the files `@` lists come from git in the
  // folder the app was started in; a URL the user asks for is fetched once,
  // within the limits of fetch-url.ts, and wrapped as untrusted content.
  const files = new WorkingFiles({ cwd })
  const fetcher = new UrlFetcher()
  // Eval in the config scope (#72): the app's evaluator and journal, this
  // window's `*repl*` buffer.
  const repl = new Repl(buffers, { journal, evaluate: shared.evaluate })
  // Each page's console, the last messages in memory, for the MCP page tier (#138).
  const consoleLog = new ConsoleLog(buffers)
  // The page buffers (#119): a WebContentsView each, built hardened with
  // only the page-script door's preload (#130), attached over the renderer's page section while its
  // buffer is current. They go with the window.
  const pages = new PageBuffers<WebContentsView>({
    buffers,
    createView: (webPreferences) => new WebContentsView({ webPreferences }),
    host: {
      addChildView: (view) => {
        if (!window.isDestroyed()) window.contentView.addChildView(view)
      },
      removeChildView: (view) => {
        if (!window.isDestroyed()) window.contentView.removeChildView(view)
      },
      focusCockpit: () => {
        if (!window.isDestroyed()) contents.focus()
      },
    },
    policies: shared.pagePolicies,
    // A key typed in a page goes through this window's dispatcher first
    // (#120): bound in the page's modes, it is the cockpit's; else the page's.
    keys: (press, modes) => dispatcher.take(press, modes).consumed,
    ...(shared.blocker === undefined ? {} : { blocker: shared.blocker }),
    console: (pageId, level, message) => consoleLog.record(pageId, level, message),
  })
  installPageBridge(pages, contents)
  // The semantic view (#122): each page's snapshot through the door, its
  // refs retired on every committed navigation of the page.
  const semantic = new SemanticView({
    ask: (pageId) => {
      const view = pages.viewOf(pageId)
      if (view === undefined) return Promise.reject(new Error('The page is gone'))
      return shared.pageDoor.request(view.webContents, 'snapshot')
    },
    committedUrl: (pageId) =>
      pages.viewOf(pageId) === undefined ? undefined : buffers.get(pageId)?.url,
    events: (listener) => pages.onPageEvent(listener),
  })
  // Hint mode (#123): labels over the snapshot's targets, drawn by the door's
  // overlay; which label names which ref, and the action on it, stay here.
  const hintListeners = new Set<(event: AgentEvent) => void>()
  const askPage = <N extends 'hints' | 'hints-show'>(
    pageId: string,
    name: N,
    args?: readonly number[],
  ): Promise<PageAnswers[N]> => {
    const view = pages.viewOf(pageId)
    if (view === undefined) return Promise.reject(new Error('The page is gone'))
    return shared.pageDoor.request(view.webContents, name, args)
  }
  const hints = new PageHints({
    semantic,
    read: (pageId) => askPage(pageId, 'hints'),
    show: (pageId, args) => askPage(pageId, 'hints-show', args),
    settings: () => config.settings.hints,
    mode: (pageId, on) => pages.setHintMode(pageId, on),
    open: (pageId, url) => pages.load(pageId, url),
    click: (pageId, x, y) => pages.clickAt(pageId, x, y),
    copy: shared.writeClipboardText,
    notify: (text) => {
      for (const listener of hintListeners) listener({ type: 'notice', text })
    },
    events: (listener) => pages.onPageEvent(listener),
  })
  const hintNotices: EventSource = {
    on: (listener) => {
      hintListeners.add(listener)
      return () => {
        hintListeners.delete(listener)
      }
    },
  }
  const currentPageId = (): string => {
    const current = buffers.current
    if (current === null || pages.viewOf(current.id) === undefined)
      throw new CommandError('The current buffer is not a page')
    return current.id
  }
  // Reader mode (#128): a page's main text through the door, shown in a
  // reader buffer, exported under the sessions folder, the one place session
  // data goes, and attached to the prompt only inside wrapUntrusted's block.
  const readers = new ReaderBuffers({
    buffers,
    ask: (pageId) => {
      const view = pages.viewOf(pageId)
      if (view === undefined) return Promise.reject(new Error('The page is gone'))
      return shared.pageDoor.request(view.webContents, 'reader')
    },
    committedUrl: (pageId) =>
      pages.viewOf(pageId) === undefined ? undefined : buffers.get(pageId)?.url,
    dir: join(settings.sessionsDir, PAGES_FOLDER),
  })
  // The document export and attach work from: the reader buffer's own, or the current page's read now.
  const readerDocument = async (): Promise<ReaderDocument> => {
    const current = buffers.current
    const shown = current === null ? undefined : readers.documentOf(current.id)
    return shown ?? readers.read(currentPageId())
  }
  // The form guide (#94): a watched page's form read through the door, the
  // guide's own tool-less session per watch, its reply in the pane beside
  // the page, and the accept key typing a shown suggestion into the focused
  // field. Nothing of it is written to disk.
  const guideListeners = new Set<(event: AgentEvent) => void>()
  const formGuide = new FormGuide({
    read: (pageId, known) => {
      const view = pages.viewOf(pageId)
      if (view === undefined) return Promise.reject(new Error('The page is gone'))
      return shared.pageDoor.request(view.webContents, 'form', [known])
    },
    semantic,
    committedUrl: (pageId) =>
      pages.viewOf(pageId) === undefined ? undefined : buffers.get(pageId)?.url,
    guide: () => new FormGuideSession({ cwd, model: () => config.settings.model ?? undefined }),
    mode: (pageId, on) => pages.setFormGuideMode(pageId, on),
    type: (pageId, text) => pages.typeIntoFocused(pageId, text),
    push: (content) => {
      if (!contents.isDestroyed()) contents.send(FORM_GUIDE_SHOWN_CHANNEL, content)
    },
    notify: (text) => {
      for (const listener of guideListeners) listener({ type: 'notice', text })
    },
    events: (listener) => pages.onPageEvent(listener),
  })
  const guideNotices: EventSource = {
    on: (listener) => {
      guideListeners.add(listener)
      return () => {
        guideListeners.delete(listener)
      }
    },
  }
  // A two-finger swipe goes back or forward in a page buffer (#31).
  installSwipe(window, pages)
  // Every committed top-frame navigation of a persistent page is a visit in
  // the profile's history (#125); an ephemeral page is never recorded.
  const stopHistory =
    shared.stores === null ? (): void => {} : recordHistory(pages, shared.stores.history)
  window.on('closed', () => {
    stopHistory()
    void formGuide.stopAll()
    pages.destroyAll()
  })
  const notices = mergeNotices(
    shared.notices,
    diffs,
    plans,
    specs,
    issues,
    verifier,
    screenshots,
    fetcher,
    environment,
    repl,
    reviews,
    worktrees,
    pages,
    hintNotices,
    guideNotices,
    boundary,
  )
  // The MCP server over this window's command table (#28, ADR 0007 and
  // 0008): a thin relay to the registry, the buffers, the prompter, the
  // session manager and the transcript search. The registry and the queue
  // exist below; the server reads them at call time. A client that connected
  // while this window was focused drives this cockpit (#70). What the window
  // is pushed of every other buffer kind is kept for its reads (#117).
  const texts = new BufferTexts(buffers)
  const shown = (content: { readonly text: string }): string => content.text
  texts.follow(diffs, (content) => diffText(content.diff))
  texts.follow(plans, shown)
  texts.follow(specs, shown)
  texts.follow(reviews, shown)
  texts.follow(environment, shown)
  texts.follow(repl, shown)
  // A reader buffer is page text: an MCP read of it gets the labeled block (T4).
  texts.follow(readers, (content) => readerAttachment(content.document))
  texts.followRequests(permissions)
  const mcp: CockpitMcp = new CockpitMcp({
    get registry() {
      return dispatcher.registry
    },
    buffers,
    prompter,
    agent,
    get prompts() {
      return prompts
    },
    sessionsDir: settings.sessionsDir,
    sessionFolder: () => recorder.folder,
    notices,
    cwd,
    version: app.getVersion(),
    texts,
    // The page tier's reading tools (#138), through the same door and views
    // the cockpit's own page commands read.
    pages: {
      list: () => pages.list(),
      committedUrl: (pageId) =>
        pages.viewOf(pageId) === undefined ? undefined : buffers.get(pageId)?.url,
      snapshot: (pageId) => semantic.snapshot(pageId),
      resolve: (ref) => semantic.resolve(ref),
      reader: (pageId) => readers.read(pageId),
      text: (pageId, element, from, chars) => {
        const view = pages.viewOf(pageId)
        if (view === undefined) return Promise.reject(new Error('The page is gone'))
        return shared.pageDoor.request(view.webContents, 'text', [element, from, chars])
      },
      form: async (pageId) => {
        const view = pages.viewOf(pageId)
        if (view === undefined) throw new Error('The page is gone')
        const document = semantic.currentDocument(pageId)
        // 0 is a change count the page never had, so the answer is always whole.
        const answer = await shared.pageDoor.request(view.webContents, 'form', [0])
        if (semantic.currentDocument(pageId) !== document) {
          throw new Error('The page navigated while its form was read')
        }
        return { answer, document }
      },
      console: consoleLog,
      events: (listener) => pages.onPageEvent(listener),
      buffers,
    },
    // A yes-per-call question wants its window on screen.
    showWindow: () => {
      if (!window.isDestroyed()) {
        window.show()
        window.focus()
      }
    },
  })
  const prompts = installSessionBridge({
    contents,
    onDestroyed,
    agent,
    permissions,
    recorder,
    notices: mergeNotices(notices, mcp),
  })
  // The palette reads a choice for a command, and help answers in a buffer (#65);
  // the same prompter reads the yes or no of a download or an external link (#51).
  const deps = resolveCockpitDeps({
    buffers,
    permissions,
    prompter,
    agent,
    prompts,
    sessions: shared.sessions,
    transcripts,
    diffs,
    plans,
    specs,
    verifier,
    issues,
    screenshots,
    files,
    clipboard: shared.clipboard,
    fetcher,
    environment,
    repl,
    windows: shared.windows,
    cwd,
    reviews,
    worktrees,
    pages,
    // The current page's text for the agent (#55): its committed URL read
    // again through the page's own partition, cookies omitted, within the
    // limits of fetch-url.ts. The page-script door (ADR 0009) will hand the
    // rendered text instead; the prompt it lands in is the same.
    pageText: () => {
      const current = buffers.current
      const view = current === null || current === undefined ? undefined : pages.viewOf(current.id)
      if (view === undefined)
        return Promise.reject(new CommandError('The current buffer is not a page'))
      const { url } = pages.currentPage()
      const reader = new UrlFetcher({
        fetch: (target, init) => view.webContents.session.fetch(target, init),
      })
      return reader.fetchText(url)
    },
    // The current page's semantic view as the human reads it (#122).
    semanticText: async () => {
      const current = buffers.current
      if (current === null || pages.viewOf(current.id) === undefined)
        throw new CommandError('The current buffer is not a page')
      return semanticText(await semantic.snapshot(current.id))
    },
    hints: {
      start: async (action) => hints.start(currentPageId(), action),
      type: async (key) => hints.type(currentPageId(), key),
      quit: async () => hints.quit(currentPageId()),
    },
    reader: {
      show: async () => {
        await readers.show(currentPageId())
      },
      export: async () => readers.export(await readerDocument()),
      attachment: async () => readerAttachment(await readerDocument()),
    },
    formGuide: {
      toggle: async () => formGuide.toggle(currentPageId()),
      accept: async () => formGuide.accept(currentPageId()),
    },
    // What open-url reads over (#124): the profile's bookmarks and history
    // (#125), and the engines of the settings, read on every read so a
    // reload-config's are the next read's.
    urls: {
      bookmarks: shared.stores?.bookmarks ?? EMPTY_STORE,
      history: shared.stores?.history ?? EMPTY_STORE,
      engines: () => config.settings.searchEngines,
    },
    stores:
      shared.stores === null
        ? null
        : { ...shared.stores, exportPath: join(settings.sessionsDir, BOOKMARKS_EXPORT) },
  })
  for (const source of CONFIRM_SOURCES) prompter.addSource(source)
  installPaletteBridge({
    contents,
    onDestroyed,
    prompter,
    help: deps.help,
    transcripts,
    diffs,
    plans,
    specs,
    reviews,
    environment,
    repl,
    journal,
    readers,
  })
  texts.follow({ onShown: (listener: HelpListener) => deps.help.on(listener) }, shown)
  // Keys mean nothing until the registry and the keymaps are up (#59).
  const dispatcher: KeyDispatcher = createCockpitDispatcher(deps)
  installKeyBridge(dispatcher, contents)
  dispatcher.registry.registerAll(shared.commands(deps.help))
  return {
    id: contents.id,
    name,
    window,
    buffers,
    prompter,
    help: deps.help,
    registry: dispatcher.registry,
    agent,
    mcp,
    prompts,
    cwd,
    worktrees,
    pages,
    semantic,
    hints,
    readers,
    formGuide,
  }
}
