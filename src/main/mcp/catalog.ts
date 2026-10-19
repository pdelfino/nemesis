import { z } from 'zod'
import { MAX_PROMPT_LENGTH } from '../../shared/agent'
import { MAX_MATCHES } from '../transcript-search'
import { SESSION_NAME_LENGTH } from '../transcripts'

/**
 * The MCP catalog (ADR 0008, #28): every tool the cockpit serves, as data.
 * The server in server.ts relays each row to the registry, the buffers, the
 * prompter, the session manager or the transcript search; it adds no tool of
 * its own, so this file is the whole surface a client can reach.
 *
 * Four fields per row, as the ADR fixes them: the name, the arguments
 * schema, the return schema and the confirmation class. Two more say where a
 * row is served: the tier, which is its prefix and its milestone, and
 * `inApp`, false for the one tool the cockpit's own session must not see.
 *
 * The cockpit tier only. The `browser_` tier lands with M4's page buffer
 * (#73), and no row evaluates code, for any client (ADR 0008, "tools that
 * never exist").
 */

/** Moves when a client could notice; the appendix of ADR 0008 lists every bump. */
export const CATALOG_VERSION = 1

export type Tier = 'cockpit' | 'browser'

/**
 * `free` answers at once, `yes` asks the user once per call, and `command`
 * takes the class of the command a `cockpit_run_command` names (ADR 0008).
 * `never` is a class a command declares; no row of this table has it, since
 * a tool that is never allowed is a tool that does not exist.
 */
export type Confirmation = 'free' | 'yes' | 'command'

export interface CatalogTool {
  readonly name: string
  readonly tier: Tier
  readonly description: string
  readonly confirmation: Confirmation
  /** False for a tool the session inside the cockpit is not offered. */
  readonly inApp: boolean
  readonly args: z.ZodObject
  readonly returns: z.ZodObject
}

/** The prefix a row's name must start with, per tier. */
export const TIER_PREFIX: Readonly<Record<Tier, string>> = {
  cockpit: 'cockpit_',
  browser: 'browser_',
}

/** A read is cut at whichever comes first (ADR 0008). */
export const READ_LINES_CAP = 2000
export const READ_BYTES_CAP = 200 * 1024

/**
 * Commands that replace the session they run in. Under `cockpit_run_command`
 * the in-app session is refused them, since the run would end the very turn
 * that called it (ADR 0008, the `in-app` column).
 */
export const IN_APP_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  'new-task',
  'resume-session',
  'rewind',
  'start-fresh-session-from-spec',
])

const mcpClass = z.enum(['free', 'yes', 'never'])

export const CATALOG: readonly CatalogTool[] = [
  {
    name: 'cockpit_list_commands',
    tier: 'cockpit',
    description:
      "List the cockpit's commands, read live from the command table, with the confirmation class cockpit_run_command applies to each.",
    confirmation: 'free',
    inApp: true,
    args: z.object({ filter: z.string().max(200).optional() }),
    returns: z.object({
      commands: z.array(z.object({ name: z.string(), doc: z.string(), class: mcpClass })),
    }),
  },
  {
    name: 'cockpit_run_command',
    tier: 'cockpit',
    description:
      "Run a command by name, as M-x would. `answers` feed the command's reads in order (a candidate's id or label, or free text); a read with none left fails the call with its prompt. Costs the command's own class.",
    confirmation: 'command',
    inApp: true,
    args: z.object({
      name: z.string().min(1).max(100),
      answers: z.array(z.string().max(MAX_PROMPT_LENGTH)).max(20).optional(),
    }),
    returns: z.object({ name: z.string(), notices: z.array(z.string()) }),
  },
  {
    name: 'cockpit_list_buffers',
    tier: 'cockpit',
    description: 'List the open buffers, in creation order, with the current one marked.',
    confirmation: 'free',
    inApp: true,
    args: z.object({}),
    returns: z.object({
      buffers: z.array(
        z.object({ id: z.string(), kind: z.string(), title: z.string(), current: z.boolean() }),
      ),
    }),
  },
  {
    name: 'cockpit_read_buffer',
    tier: 'cockpit',
    description: `Read a buffer's text by id, as the window shows it: the transcript's Org rendering, the prompt's draft, a diff as - and + lines, a pending request's question, the text of a help, plan, spec, review, environment or *repl* buffer. At most ${READ_LINES_CAP} lines or ${READ_BYTES_CAP / 1024} KB per call; \`truncated\` says there is more from \`from\` + \`lines\`.`,
    confirmation: 'free',
    inApp: true,
    args: z.object({
      id: z.string().min(1).max(32),
      from: z.number().int().min(1).optional(),
      lines: z.number().int().min(1).max(READ_LINES_CAP).optional(),
    }),
    returns: z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      from: z.number(),
      lines: z.number(),
      truncated: z.boolean(),
    }),
  },
  {
    name: 'cockpit_send_prompt',
    tier: 'cockpit',
    description:
      "Send a prompt to the cockpit's agent session, after the user's yes. Returns the queue's receipt, not the answer; read the transcript buffer for that.",
    confirmation: 'yes',
    // A session that sends itself a prompt is a loop (ADR 0008).
    inApp: false,
    args: z.object({ text: z.string().min(1).max(MAX_PROMPT_LENGTH) }),
    returns: z.object({
      id: z.string(),
      status: z.enum(['sent', 'queued', 'answered']),
      position: z.number(),
    }),
  },
  {
    name: 'cockpit_search_transcripts',
    tier: 'cockpit',
    description:
      'Search every recorded session transcript for a substring, case-insensitive, newest session first.',
    confirmation: 'free',
    inApp: true,
    args: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(MAX_MATCHES).optional(),
    }),
    returns: z.object({
      matches: z.array(
        z.object({
          sessionId: z.string(),
          title: z.string(),
          date: z.string(),
          line: z.number(),
          excerpt: z.string(),
        }),
      ),
    }),
  },
  {
    name: 'cockpit_session_info',
    tier: 'cockpit',
    description:
      "The cockpit's current agent session: its id, name, first prompt, whether a turn runs, the permission mode, the prompts queued, and the catalog version.",
    confirmation: 'free',
    inApp: true,
    args: z.object({}),
    returns: z.object({
      sessionId: z.string().nullable(),
      name: z.string().nullable(),
      title: z.string().nullable(),
      busy: z.boolean(),
      permissionMode: z.string(),
      cwd: z.string(),
      startedAt: z.string().nullable(),
      queued: z.number(),
      catalog: z.number(),
    }),
  },
  {
    name: 'cockpit_name_session',
    tier: 'cockpit',
    description:
      "Name the cockpit's session, for the sessions list, the window title and the mode line; a later name replaces it.",
    confirmation: 'yes',
    inApp: true,
    args: z.object({
      name: z
        .string()
        .min(1)
        .max(SESSION_NAME_LENGTH * 4),
    }),
    returns: z.object({ sessionId: z.string().nullable(), name: z.string() }),
  },
]

/**
 * The one resource of the cockpit tier (ADR 0008): the current session's
 * event log, the `AgentEvent` objects `events.jsonl` holds, one JSON object
 * per line, read-only and subscribable. Free, like the transcript: the
 * events are the agent's own record, and a tool result that came from a page
 * keeps the wrapper it was recorded with.
 */
export const EVENTS_RESOURCE = {
  uri: 'nemesis://session/events',
  mimeType: 'application/x-ndjson',
  description:
    "The cockpit's current agent session as its event log: every AgentEvent recorded, one JSON object per line, oldest first. Empty before the session's first event. Subscribe for an update after every event.",
} as const

export function catalogTool(name: string): CatalogTool | undefined {
  return CATALOG.find((tool) => tool.name === name)
}
