import type { AgentEvent } from '../shared/agent'
import { describeContext } from '../shared/context'

/**
 * The session's part of the mode line (#80): the context meter and the
 * cockpit's nudge. The main process decides both; this module reflects the
 * events. The meter shows the fill of the window as a fraction and a bar,
 * steps its color at the point the guide says to clear or compact, and goes
 * blank when the session stops. The nudge stays until the next prompt.
 */
export function installModeline(): void {
  const meter = document.getElementById('context-meter')
  const hint = document.getElementById('modeline-hint')
  if (meter === null || hint === null) throw new Error('index.html has no mode line')
  window.nemesis.onAgentEvent((event) => render(event, meter, hint))
}

export function render(event: AgentEvent, meter: HTMLElement, hint: HTMLElement): void {
  switch (event.type) {
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
