import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { BufferInfo } from '../../shared/buffers'
import type { PromptReceipt } from '../../shared/agent'
import type { AgentEvent, AgentNoticeEvent, AgentPermissionMode } from '../agent/events'
import type { BufferRegistry } from '../buffers'
import { confirmWhile, MCP_SOURCE } from '../commands/confirm'
import type { Prompter } from '../commands/prompter'
import type { CommandRegistry, McpClass } from '../commands/registry'
import { searchTranscripts } from '../transcript-search'
import { EVENT_LOG_FILE, sessionName, TRANSCRIPT_FILE } from '../transcripts'
import {
  CATALOG,
  CATALOG_VERSION,
  catalogTool,
  EVENTS_RESOURCE,
  IN_APP_HIDDEN_COMMANDS,
  PAGE_FEEDS,
  PAGE_RESOURCES,
  READ_BYTES_CAP,
  READ_LINES_CAP,
} from './catalog'
import { PageFeeds } from './page-feeds'
import { ACTING_TOOLS, PageTier, type PageTierDeps } from './page-tier'

/**
 * The cockpit's MCP server (#28, ADR 0007): the tools of catalog.ts, each a
 * thin relay to what the window already drives. One catalog, one set of
 * rules, two doors: the socket of socket.ts, for a client outside the app,
 * and the in-process server the cockpit's own session gets through
 * `mcpServers`.
 *
 * The MCP SDK binds one transport to one `McpServer`, so every connection,
 * and every session the manager starts, gets a fresh instance built from the
 * same catalog over the same state; "one server" is this object.
 *
 * The confirmation class is read at the door the call came through. On the
 * socket, `yes` is a question in the prompt buffer with the client's name in
 * it, asked one at a time in arrival order. In-app, the question already
 * happened: the SDK's `canUseTool` sent the call through the permission
 * bridge, so a tool the bridge allowed is not asked again here. A command
 * whose class is `never` is refused on both doors. A socket client that
 * goes away before the user answered its question has the question
 * withdrawn, with a notice naming it (#117).
 *
 * The page tier's tools (#138, #139) relay to page-tier.ts. Their result
 * is the structure, a line of it as text, and the page's own strings as one
 * more text item, the `wrapUntrusted` block. The same block is the
 * structure's `untrusted` field and no other field holds a page string
 * (#151): the real Claude Code CLI hands the model the structure alone, so
 * a client that reads only the structure still reads the page labeled, and
 * only under that name. A navigation tool's socket
 * question is page-tier.ts's: the tool, the origin of the page and the URL
 * the client named, quoted, never a string the page wrote; a refusal comes
 * back before anything is asked.
 *
 * The acting tools (#140) ask the same way at either door: the client, the
 * tool, the page's origin and the agent's `element` words quoted; inside the
 * cockpit the permission bridge shows that line, from `inAppQuestion`. A
 * stale ref, and a masked field for `browser_type`, are refused before the
 * question. A screenshot's PNG is one `image` content item after the text.
 *
 * One resource beside the tools, `nemesis://session/events` (ADR 0008): the
 * current session's `events.jsonl` as recorded, so a tool result that came
 * from a page keeps the wrapper it was recorded with. A subscriber hears
 * `notifications/resources/updated` after every event the log took.
 *
 * And three per page buffer (#29): its mutations, console and network as
 * feeds, from page-feeds.ts, listed while the buffer lives; the list moves,
 * with `notifications/resources/list_changed`, as page buffers open and go.
 *
 * Plain data and no Electron types, so the unit tests drive it over the MCP
 * SDK's in-memory transport.
 */

export type McpDoorKind = 'socket' | 'in-app'

/** The name the in-app session's calls carry, in a question and in `CommandContext`. */
export const IN_APP_CLIENT = 'the cockpit session'

/** A client name or a quoted argument is cut to this in the question. */
const QUESTION_PART = 200

export interface CockpitMcpDeps {
  readonly registry: CommandRegistry
  readonly buffers: BufferRegistry
  readonly prompter: Prompter
  readonly agent: {
    readonly sessionId: string | null
    readonly busy: boolean
    readonly permissionMode: AgentPermissionMode
    nameSession(name: string): void
    on(listener: (event: AgentEvent) => void): () => void
  }
  readonly prompts: {
    readonly draft: string
    submit(text: string): Promise<PromptReceipt>
    state(): { readonly queued: readonly unknown[] }
  }
  /** The sessions folder the search reads; null when none is wired. */
  readonly sessionsDir: string | null
  /** The folder the recorder writes the current session to, once it has one. */
  readonly sessionFolder: () => string | null
  /** The cockpit's notices, which a `cockpit_run_command` result reports. */
  readonly notices: { on(listener: (event: AgentEvent) => void): () => void }
  readonly cwd: string
  /** The app's version; the server announces `<version>+catalog.<n>`. */
  readonly version: string
  /** Opens a window when none is, so a question has somewhere to be asked (ADR 0007). */
  readonly showWindow?: (() => void) | undefined
  /** The text of the buffer kinds the window is pushed (#117); see buffer-texts.ts. */
  readonly texts?: { text(buffer: BufferInfo): string | undefined } | undefined
  /** The page buffers the page tier reads (#138); absent, every `browser_` call is an error. */
  readonly pages?: PageTierDeps | undefined
}

interface Call {
  readonly door: McpDoorKind
  readonly client: string
  readonly signal?: AbortSignal | undefined
}

/**
 * What a relay returns: the structure the return schema describes, and its
 * text; a page tool adds the page's own strings as one wrapped block, which
 * goes out both as a text item and as the structure's `untrusted` field.
 */
interface Answer {
  readonly structured: Record<string, unknown>
  readonly text: string
  readonly block?: string
  readonly image?: string
}

export class McpToolError extends Error {
  override readonly name = 'McpToolError'
}

export type NoticeListener = (event: AgentNoticeEvent) => void

export class CockpitMcp {
  private readonly deps: CockpitMcpDeps
  private readonly pages: PageTier | null
  private readonly feeds: PageFeeds<McpServer> | null
  private readonly servers = new Set<McpServer>()
  /** The servers whose client subscribed to the events resource. */
  private readonly subscribed = new Set<McpServer>()
  private readonly listeners = new Set<NoticeListener>()
  /** The questions of socket clients, one at a time, in arrival order. */
  private asking: Promise<unknown> = Promise.resolve()
  /** `cockpit_run_command` runs one at a time: the prompter scripts one run. */
  private running: Promise<unknown> = Promise.resolve()
  private session: {
    id: string | null
    name: string | null
    title: string | null
    startedAt: string | null
    cwd: string | null
  } = { id: null, name: null, title: null, startedAt: null, cwd: null }

  constructor(deps: CockpitMcpDeps) {
    this.deps = deps
    this.pages = deps.pages === undefined ? null : new PageTier(deps.pages)
    const sources = deps.pages?.feeds
    this.feeds =
      deps.pages === undefined || sources === undefined
        ? null
        : new PageFeeds<McpServer>(
            { ...deps.pages, feeds: sources },
            (server, uri) => {
              if (server.isConnected()) {
                server.server.sendResourceUpdated({ uri }).catch(() => undefined)
              }
            },
            () => {
              for (const server of this.servers) {
                if (server.isConnected()) server.sendResourceListChanged()
              }
            },
          )
    deps.agent.on((event) => {
      this.track(event)
      this.eventsChanged()
    })
  }

  /** A fresh server for one connection, with the rows its door offers. */
  serve(door: McpDoorKind): McpServer {
    const server = new McpServer({
      name: 'nemesis',
      version: `${this.deps.version}+catalog.${CATALOG_VERSION}`,
    })
    for (const tool of CATALOG) {
      if (door === 'in-app' && !tool.inApp) continue
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.args,
          outputSchema: tool.returns,
          annotations: { readOnlyHint: tool.confirmation === 'free' },
        },
        async (args: Record<string, unknown>, extra) => {
          const client =
            door === 'in-app' ? IN_APP_CLIENT : (server.server.getClientVersion()?.name ?? 'client')
          return this.call(tool.name, args, { door, client, signal: extra.signal })
        },
      )
    }
    this.serveEvents(server)
    this.servers.add(server)
    server.server.onclose = () => {
      this.servers.delete(server)
      this.subscribed.delete(server)
      this.feeds?.drop(server)
    }
    return server
  }

  /** Serves one connection of the socket door until either side closes it. */
  async connect(transport: Transport): Promise<McpServer> {
    const server = this.serve('socket')
    await server.connect(transport)
    return server
  }

  /** The events resource on `server`, the page feeds (#29), read-only, and their subscriptions. */
  private serveEvents(server: McpServer): void {
    server.registerResource(
      'session-events',
      EVENTS_RESOURCE.uri,
      { description: EVENTS_RESOURCE.description, mimeType: EVENTS_RESOURCE.mimeType },
      async (uri) => ({
        contents: [
          { uri: uri.href, mimeType: EVENTS_RESOURCE.mimeType, text: await this.events() },
        ],
      }),
    )
    const feeds = this.feeds
    if (feeds !== null) {
      for (const feed of PAGE_FEEDS) {
        const { uriTemplate, mimeType, description } = PAGE_RESOURCES[feed]
        server.registerResource(
          `page-${feed}`,
          new ResourceTemplate(uriTemplate, {
            list: () => ({
              resources: feeds.list().filter((one) => one.uri.endsWith(`/${feed}`)),
            }),
          }),
          { description, mimeType },
          async (uri) => {
            try {
              return { contents: (await feeds.read(uri.href)).contents }
            } catch (error) {
              throw new McpToolError(error instanceof Error ? error.message : String(error))
            }
          },
        )
      }
    }
    server.server.registerCapabilities({ resources: { subscribe: true } })
    server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
      const { uri } = request.params
      if (uri === EVENTS_RESOURCE.uri) {
        this.subscribed.add(server)
      } else if (feeds !== null && feeds.has(uri)) {
        feeds.subscribe(uri, server)
      } else {
        throw new McpToolError(`No resource ${uri}`)
      }
      return {}
    })
    server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      if (request.params.uri === EVENTS_RESOURCE.uri) this.subscribed.delete(server)
      else feeds?.unsubscribe(request.params.uri, server)
      return {}
    })
  }

  /** The log as the recorder wrote it; empty before the session's first event. */
  private async events(): Promise<string> {
    const folder = this.deps.sessionFolder()
    if (folder === null) return ''
    try {
      return await readFile(join(folder, EVENT_LOG_FILE), 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * Tells the subscribers the log moved. The recorder writes an event when
   * it is emitted, and may hear it after this server does, so the
   * notification goes on the next turn of the loop, once the line is on disk.
   */
  private eventsChanged(): void {
    if (this.subscribed.size === 0) return
    setImmediate(() => {
      for (const server of this.subscribed) {
        if (server.isConnected()) {
          server.server.sendResourceUpdated({ uri: EVENTS_RESOURCE.uri }).catch(() => undefined)
        }
      }
    })
  }

  /** After a `reload-config` commit: every connected client lists again (ADR 0007). */
  toolsChanged(): void {
    for (const server of this.servers) {
      if (server.isConnected()) server.sendToolListChanged()
    }
  }

  /** The notices a socket client's calls leave in the transcript. */
  on(listener: NoticeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * One tool call, through the door it came in by. A refusal, an unknown
   * name or a failed relay is an `isError` result, never a protocol fault.
   */
  async call(name: string, args: Record<string, unknown>, call: Call): Promise<CallToolResult> {
    const tool = catalogTool(name)
    if (tool === undefined || (call.door === 'in-app' && !tool.inApp)) {
      return failure(`No tool named ${name}`)
    }
    if (call.door === 'socket') this.notice(`${clip(call.client)} called ${name}`)
    try {
      let given = args
      if (tool.confirmation === 'yes' && call.door === 'socket') {
        const asked = await this.question(name, args)
        await this.ask(call, asked.question)
        given = asked.args
      }
      const answer = await this.relay(name, given, call)
      return {
        content: [
          { type: 'text', text: answer.text },
          ...(answer.block === undefined ? [] : [{ type: 'text' as const, text: answer.block }]),
          ...(answer.image === undefined
            ? []
            : [{ type: 'image' as const, data: answer.image, mimeType: 'image/png' }]),
        ],
        structuredContent:
          answer.block === undefined
            ? answer.structured
            : { ...answer.structured, untrusted: answer.block },
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error))
    }
  }

  private async relay(name: string, args: Record<string, unknown>, call: Call): Promise<Answer> {
    if (name.startsWith('browser_')) {
      if (this.pages === null) throw new McpToolError('This cockpit has no page buffers')
      return this.pages.call(name, args, call.signal)
    }
    switch (name) {
      case 'cockpit_list_commands':
        return this.listCommands(optionalString(args['filter']), call)
      case 'cockpit_run_command':
        return this.runCommand(String(args['name']), stringArray(args['answers']), call)
      case 'cockpit_list_buffers':
        return this.listBuffers()
      case 'cockpit_read_buffer':
        return this.readBuffer(
          String(args['id']),
          optionalNumber(args['from']) ?? 1,
          optionalNumber(args['lines']) ?? READ_LINES_CAP,
        )
      case 'cockpit_send_prompt':
        return this.sendPrompt(String(args['text']))
      case 'cockpit_search_transcripts':
        return this.search(String(args['query']), optionalNumber(args['limit']))
      case 'cockpit_session_info':
        return this.sessionInfo()
      case 'cockpit_name_session':
        return this.nameSession(String(args['name']))
      default:
        throw new McpToolError(`No relay for ${name}`)
    }
  }

  private listCommands(filter: string | undefined, call: Call): Answer {
    const needle = filter?.toLowerCase() ?? ''
    const commands = this.deps.registry
      .list()
      .filter((command) => command.name.includes(needle))
      .filter((command) => call.door === 'socket' || !IN_APP_HIDDEN_COMMANDS.has(command.name))
      .map((command) => ({ name: command.name, doc: command.doc, class: classOf(command.mcp) }))
    return {
      structured: { commands },
      text: commands
        .map((command) => `${command.name} (${command.class}): ${command.doc}`)
        .join('\n'),
    }
  }

  private async runCommand(name: string, answers: readonly string[], call: Call): Promise<Answer> {
    const command = this.deps.registry.get(name)
    if (command === undefined) throw new McpToolError(`No command named "${name}"`)
    const cost = classOf(command.mcp)
    if (cost === 'never') {
      throw new McpToolError(`"${name}" is never run over MCP: it answers a question the user owns`)
    }
    if (call.door === 'in-app' && IN_APP_HIDDEN_COMMANDS.has(name)) {
      throw new McpToolError(`"${name}" would replace the session that called it`)
    }
    if (cost === 'yes' && call.door === 'socket') {
      // The question is the user's only view of what will run: an answer it
      // would cut (eval-expression's form, #182) is refused, so no yes covers
      // text past the cut.
      if (answers.some((answer) => !fitsQuestion(answer))) {
        throw new McpToolError(
          `An answer to "${name}" is longer than the question can show (${QUESTION_PART} characters); nothing was asked or run`,
        )
      }
      const given = answers.length === 0 ? '' : ` with ${answers.map(quote).join(', ')}`
      await this.ask(call, `cockpit_run_command: run ${name}${given}?`)
    }
    const run = this.running.then(async () => {
      const notices: string[] = []
      const listen = (event: AgentEvent): void => {
        if (event.type === 'notice') notices.push(event.text)
      }
      const offs = [this.deps.notices.on(listen), this.deps.agent.on(listen)]
      try {
        await this.deps.prompter.scripted(answers, () =>
          this.deps.registry.run(name, { source: 'mcp', client: call.client }),
        )
      } finally {
        for (const off of offs) off()
      }
      return notices
    })
    this.running = run.catch(() => undefined)
    const notices = await run
    return {
      structured: { name, notices },
      text: notices.length === 0 ? `Ran ${name}.` : [`Ran ${name}.`, ...notices].join('\n'),
    }
  }

  private listBuffers(): Answer {
    const current = this.deps.buffers.current?.id ?? null
    const buffers = this.deps.buffers.list().map((buffer) => ({
      id: buffer.id,
      kind: buffer.kind,
      title: titleOf(buffer),
      current: buffer.id === current,
    }))
    return {
      structured: { buffers },
      text: buffers
        .map((b) => `${b.id} ${b.kind} ${b.title}${b.current ? ' (current)' : ''}`)
        .join('\n'),
    }
  }

  private async readBuffer(id: string, from: number, lines: number): Promise<Answer> {
    const buffer = this.deps.buffers.get(id)
    if (buffer === undefined) throw new McpToolError(`No buffer with id "${id}"`)
    const whole = await this.bufferText(buffer)
    const all = whole.length === 0 ? [] : whole.split('\n')
    const taken: string[] = []
    let bytes = 0
    for (const line of all.slice(from - 1, from - 1 + Math.min(lines, READ_LINES_CAP))) {
      bytes += Buffer.byteLength(line, 'utf8') + 1
      if (bytes > READ_BYTES_CAP) break
      taken.push(line)
    }
    return {
      structured: {
        id,
        kind: buffer.kind,
        title: titleOf(buffer),
        from,
        lines: taken.length,
        truncated: from - 1 + taken.length < all.length,
      },
      text: taken.join('\n'),
    }
  }

  /** What the window shows, by kind. */
  private async bufferText(buffer: BufferInfo): Promise<string> {
    if (buffer.kind === 'prompt') return this.deps.prompts.draft
    if (buffer.kind === 'transcript') {
      const folder = this.deps.sessionFolder()
      if (folder === null) return ''
      try {
        return await readFile(join(folder, TRANSCRIPT_FILE), 'utf8')
      } catch {
        return ''
      }
    }
    // A buffer opens before its content is pushed; until then it shows nothing.
    return this.deps.texts?.text(buffer) ?? ''
  }

  private async sendPrompt(text: string): Promise<Answer> {
    const receipt = await this.deps.prompts.submit(text)
    return {
      structured: { ...receipt },
      text:
        receipt.status === 'queued'
          ? `Queued at position ${receipt.position}.`
          : `Sent as ${receipt.id}.`,
    }
  }

  private async search(query: string, limit: number | undefined): Promise<Answer> {
    const found =
      this.deps.sessionsDir === null ? [] : await searchTranscripts(this.deps.sessionsDir, query)
    const matches = found
      .slice(0, limit ?? found.length)
      .map(({ sessionId, title, date, line, excerpt }) => ({
        sessionId,
        title,
        date,
        line,
        excerpt,
      }))
    return {
      structured: { matches },
      text:
        matches.length === 0
          ? 'No match.'
          : matches.map((m) => `${m.sessionId}:${m.line} ${m.date} ${m.excerpt}`).join('\n'),
    }
  }

  private sessionInfo(): Answer {
    const { agent, prompts } = this.deps
    const structured = {
      sessionId: agent.sessionId,
      name: this.session.name,
      title: this.session.title,
      busy: agent.busy,
      permissionMode: agent.permissionMode,
      cwd: this.session.cwd ?? this.deps.cwd,
      startedAt: this.session.startedAt,
      queued: prompts.state().queued.length,
      catalog: CATALOG_VERSION,
    }
    return { structured, text: JSON.stringify(structured) }
  }

  private nameSession(text: string): Answer {
    const name = sessionName(text)
    if (name === null) throw new McpToolError('A name needs a printable character')
    this.deps.agent.nameSession(name)
    return { structured: { sessionId: this.deps.agent.sessionId, name }, text: `Named ${name}.` }
  }

  /**
   * The door's yes (ADR 0007): the prompt buffer, the no first, the client's
   * name in the question. Questions wait their turn; one whose client has
   * gone by its turn is not asked, and one whose client goes while it is
   * open is withdrawn from the prompt buffer with a notice (#117).
   */
  private async ask(call: Call, question: string): Promise<void> {
    const signal = call.signal ?? new AbortController().signal
    const turn = this.asking.then(() => {
      if (signal.aborted) return 'withdrawn' as const
      this.deps.showWindow?.()
      return confirmWhile(
        this.deps.prompter,
        MCP_SOURCE,
        `${clip(call.client)} asks ${question}`,
        signal,
      ).then((outcome) => {
        if (outcome === 'withdrawn') {
          this.notice(`${clip(call.client)} disconnected; its question was withdrawn`)
        }
        return outcome
      })
    })
    this.asking = turn.catch(() => undefined)
    const outcome = await turn
    if (outcome === 'withdrawn') throw new McpToolError('The client disconnected before the answer')
    if (!outcome) throw new McpToolError('The user refused the call')
  }

  /**
   * The question a yes-per-call tool asks on the socket, after the client's
   * name, and the arguments the yes is for: a page tool's names its page.
   */
  /**
   * The line the permission bridge shows when the cockpit's own session calls
   * an acting page tool (#140), and the arguments pinned to the page it
   * names; null for any other tool, which the bridge asks as before. A
   * refusal (a stale ref, a masked field for `browser_type`) rejects, and the
   * bridge denies the call with it before anyone is asked.
   */
  async inAppQuestion(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly title: string; readonly args: Record<string, unknown> } | null> {
    if (!ACTING_TOOLS.has(name)) return null
    const asked = await this.question(name, args)
    return { title: `${IN_APP_CLIENT} asks ${asked.question}`, args: asked.args }
  }

  private async question(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly question: string; readonly args: Record<string, unknown> }> {
    if (!name.startsWith('browser_'))
      return { question: `${name}: ${this.detail(name, args)}?`, args }
    if (this.pages === null) throw new McpToolError('This cockpit has no page buffers')
    return this.pages.question(name, args, quote)
  }

  /** What a yes-per-call question shows of the arguments. */
  private detail(name: string, args: Record<string, unknown>): string {
    if (name === 'cockpit_send_prompt') return `send the prompt ${quote(String(args['text']))}`
    if (name === 'cockpit_name_session') return `name the session ${quote(String(args['name']))}`
    return name
  }

  private notice(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text: `MCP: ${text}` }
    for (const listener of [...this.listeners]) listener(event)
  }

  private track(event: AgentEvent): void {
    if (event.type === 'started' && event.sessionId !== this.session.id) {
      this.session = {
        ...this.session,
        id: event.sessionId,
        title: null,
        startedAt: new Date().toISOString(),
        cwd: event.cwd,
      }
    } else if (event.type === 'named') {
      this.session = { ...this.session, name: event.name }
    } else if (event.type === 'user-text' && this.session.title === null) {
      this.session = { ...this.session, title: sessionName(event.text) }
    } else if (event.type === 'stopped') {
      this.session = { id: null, name: null, title: null, startedAt: null, cwd: null }
    }
  }
}

/**
 * A buffer's title as a client reads it. A page buffer's own title is the
 * page's text, which reaches no agent unwrapped (CLAUDE.md: page content is
 * data), so a page is named by its origin alone (#119).
 */
function titleOf(buffer: BufferInfo): string {
  if (buffer.kind !== 'page') return buffer.title
  if (buffer.url === undefined) return 'Page'
  try {
    return `Page on ${new URL(buffer.url).origin}`
  } catch {
    return 'Page'
  }
}

function classOf(declared: McpClass | undefined): McpClass {
  return declared ?? 'yes'
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Cut to a screen and on one line: a question is one line in the prompt buffer. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > QUESTION_PART ? `${line.slice(0, QUESTION_PART)}...` : line
}

function quote(text: string): string {
  return `"${clip(text)}"`
}

/** Whether the question shows `text` whole: `clip` leaves it uncut. */
function fitsQuestion(text: string): boolean {
  return text.replace(/\s+/g, ' ').trim().length <= QUESTION_PART
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}
