import type { AgentEvent } from '../shared/agent'
import { APP_NAME } from '../shared/api'
import { describeContext } from '../shared/context'

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
