import { describeModel, type AgentEvent } from '../shared/agent'
import { APP_NAME } from '../shared/api'
import type { BufferList } from '../shared/buffers'
import { describeContext } from '../shared/context'
import type { KeyBindings } from '../shared/keys'

/**
 * The session's part of the mode line (#80): the context meter and the
 * cockpit's nudge, and the permission mode (#82). The main process decides
 * all three; this module reflects the events. The meter shows the fill of
 * the window as a fraction and a bar, steps its color at the point the
 * guide says to clear or compact, and goes blank when the session stops.
 * The nudge stays until the next prompt. The mode shows at all times: the
 * page starts it at the default and every change, and every session start,
 * rewrites it.
 *
 * The session's name (#104) is the fourth: shown in the mode line and as
 * the window title, `<name> · Nemesis`, while the named session is up.
 * The stop gate (#113) is the fifth: `gate` while it is on, with the retry
 * count against the cap once a red check has gone back to the session.
 * The model (#190) is the sixth, next to the meter: the one the session
 * started on, then the one `set-model` switched to, with the effort level
 * once `set-effort` set one; blank when the session stops.
 */
export function installModeline(): void {
  const meter = document.getElementById('context-meter')
  const hint = document.getElementById('modeline-hint')
  const mode = document.getElementById('permission-mode')
  const name = document.getElementById('session-name')
  if (meter === null || hint === null || mode === null || name === null) {
    throw new Error('index.html has no mode line')
  }
  const naming = new SessionNaming()
  window.nemesis.onAgentEvent((event) => render(event, { meter, hint, mode, name }, naming))
  const gate = document.getElementById('stop-gate')
  if (gate === null) throw new Error('index.html has no #stop-gate')
  window.nemesis.onAgentEvent((event) => {
    if (event.type !== 'stop-gate') return
    gate.textContent = describeStopGate(event)
    gate.title = event.on
      ? `Stop gate: every turn ends with the check; a red one goes back as the next prompt, ${event.cap} times at most. M-x toggle-stop-gate turns it off.`
      : ''
  })
  const model = document.getElementById('session-model')
  if (model === null) throw new Error('index.html has no #session-model')
  let shown: SessionModel = NO_MODEL
  window.nemesis.onAgentEvent((event) => {
    const next = sessionModel(shown, event)
    if (next === shown) return
    shown = next
    model.textContent = describeModel(shown.model, shown.effort)
    model.title =
      shown.model === null && shown.effort === null
        ? ''
        : 'Model and effort of this session. M-x set-model and set-effort switch them.'
  })
  // The eval journal (#72): the definitions made at eval not yet promoted to
  // init.ts or discarded, blank at none.
  const journal = document.getElementById('journal-count')
  if (journal === null) throw new Error('index.html has no #journal-count')
  window.nemesis.onJournalChanged((state) => {
    journal.textContent = state.unpromoted === 0 ? '' : `journal: ${state.unpromoted}`
    journal.title =
      state.unpromoted === 0
        ? ''
        : `${state.unpromoted} eval ${state.unpromoted === 1 ? 'definition' : 'definitions'} not in init.ts. M-x journal-promote or journal-discard.`
  })
  // The current page buffer's modes and zoom (#120), off the buffer list.
  const page = document.getElementById('page-state')
  if (page === null) throw new Error('index.html has no #page-state')
  window.nemesis.onBuffersChanged((list) => {
    page.textContent = pageState(list)
  })
}

/**
 * What the mode line says of the current page buffer (#120): `passthrough`
 * while every key but C-z goes to the page, and the zoom when it is not
 * 100%. Blocker mode (#126): `blocker off` while it is off, else the count
 * of requests it cancelled on this page, once there is one. Blank for every
 * other buffer, and for a page in plain `document` with nothing blocked.
 */
export function pageState(list: BufferList): string {
  const current = list.buffers.find((buffer) => buffer.id === list.currentId)
  if (current?.kind !== 'page') return ''
  const parts: string[] = []
  if (current.modes?.includes('passthrough') === true) parts.push('passthrough')
  if (current.zoom !== undefined && current.zoom !== 100) parts.push(`${current.zoom}%`)
  if (current.blocker === false) parts.push('blocker off')
  else if (current.blocked !== undefined && current.blocked > 0) {
    parts.push(`${current.blocked} blocked`)
  }
  return parts.join(' ')
}

/**
 * The current buffer's modes as the mode line shows them (#166): the visible
 * ones, first wins. A page buffer's own modes are not registered modes yet
 * and show in its page state instead.
 */
export function modeNames(list: BufferList | null, bindings: KeyBindings | null): string {
  if (list === null || bindings === null) return ''
  const current = list.buffers.find((buffer) => buffer.id === list.currentId)
  return (current?.modes ?? []).filter((name) => bindings.byMode[name]?.visible === true).join(' ')
}

/** The model and effort the mode line shows (#190); null for not known or the default. */
export interface SessionModel {
  readonly model: string | null
  readonly effort: string | null
}

export const NO_MODEL: SessionModel = { model: null, effort: null }

/**
 * The mode line's model after one event (#190), the same object when it does
 * not change it. A `started` names the model and leaves the effort, since a
 * switch can come before the SDK's init frame; a `stopped` clears both.
 */
export function sessionModel(state: SessionModel, event: AgentEvent): SessionModel {
  switch (event.type) {
    case 'started':
      return { model: event.model, effort: state.effort }
    case 'model':
      return { model: event.model, effort: event.effort }
    case 'stopped':
      return NO_MODEL
    default:
      return state
  }
}

/** `gate`, `gate 2/3` once retries were sent, blank when off. */
export function describeStopGate(event: Extract<AgentEvent, { type: 'stop-gate' }>): string {
  if (!event.on) return ''
  return event.retries === 0 ? 'gate' : `gate ${event.retries}/${event.cap}`
}

export interface ModelineElements {
  readonly meter: HTMLElement
  readonly hint: HTMLElement
  readonly mode: HTMLElement
  readonly name: HTMLElement
}

/**
 * Whose name the window shows (#104). A name belongs to the session it was
 * given in, and the stream says which session is up: a `started` carries
 * the id, a `stopped` ends it. So a session shown again on resume, whose
 * history replays its `named` event before its own `stopped`, gets its name
 * back when it starts, and a fresh session after it shows none. A name
 * given between sessions waits for the next start, as the recorder makes it
 * that session's.
 */
export class SessionNaming {
  private readonly names = new Map<string, string>()
  private current: string | null = null
  private pending: string | null = null
  private shown: string | null = null

  /** The name to show, or null for none. */
  get name(): string | null {
    return this.shown
  }

  /** Reads one event; true when what to show changed. */
  observe(event: AgentEvent): boolean {
    const before = this.shown
    switch (event.type) {
      case 'named':
        if (this.current === null) this.pending = event.name
        else this.names.set(this.current, event.name)
        this.shown = event.name
        break
      case 'started':
        this.current = event.sessionId
        if (this.pending !== null) {
          this.names.set(event.sessionId, this.pending)
          this.pending = null
        }
        this.shown = this.names.get(event.sessionId) ?? null
        break
      case 'stopped':
        this.current = null
        this.shown = null
        break
      default:
        break
    }
    return this.shown !== before
  }
}

export function render(event: AgentEvent, elements: ModelineElements, naming: SessionNaming): void {
  const { meter, hint, mode, name } = elements
  if (naming.observe(event)) {
    name.textContent = naming.name ?? ''
    name.title = naming.name === null ? '' : `Session: ${naming.name}. C-c C-n renames it.`
    document.title = naming.name === null ? APP_NAME : `${naming.name} · ${APP_NAME}`
  }
  switch (event.type) {
    case 'permission-mode':
      mode.textContent = event.mode
      return
    case 'started':
      mode.textContent = event.permissionMode
      return
    case 'context-usage': {
      const shown = describeContext(event.usedTokens, event.windowTokens)
      meter.textContent = shown.text
      meter.dataset['level'] = shown.level
      meter.title = `Context: ${event.usedTokens} of ${event.windowTokens} tokens. C-c C-l clears, C-c C-k compacts.`
      return
    }
    case 'stopped':
      meter.textContent = ''
      meter.dataset['level'] = 'none'
      meter.title = ''
      hint.textContent = ''
      return
    case 'nudge':
      hint.textContent = event.text
      return
    case 'user-text':
      hint.textContent = ''
      return
    default:
      return
  }
}
