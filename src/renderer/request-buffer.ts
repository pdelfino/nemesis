import { requestKeys, type AgentEvent, type AgentQuestion } from '../shared/agent'

/**
 * The request section (#63): what the permission bridge is waiting on, shown
 * between the transcript and the prompt while a request is pending. The
 * transcript keeps the record as blocks; this section is the live control.
 * It is the `permission` buffer the main process creates for the request,
 * so while it is current it holds the point and an unmodified `y`, `n`, `a`
 * or digit is an answer through the registry, never text. `C-x b` leaves it
 * for the prompt buffer, to type a reply, and comes back.
 *
 * The main process owns the pending list; this module follows its events and
 * shows the oldest request, the one the keys answer.
 */

interface ShownRequest {
  readonly id: string
  readonly toolName: string
  readonly title: string | null
  readonly questions: readonly AgentQuestion[] | null
  readonly answers: string[]
}

export const REQUEST_ELEMENT_ID = 'request'

export function installRequestBuffer(): void {
  const section = required(REQUEST_ELEMENT_ID)
  const title = required('request-title')
  const options = required('request-options')
  const keys = required('request-keys')
  const pending: ShownRequest[] = []

  window.nemesis.onAgentEvent((event: AgentEvent) => {
    if (event.type === 'permission-request') {
      pending.push({
        id: event.requestId,
        toolName: event.toolName,
        title: event.title ?? null,
        questions: event.questions ?? null,
        answers: [],
      })
    } else if (event.type === 'question-answered') {
      pending.find((request) => request.id === event.requestId)?.answers.push(event.answer)
    } else if (event.type === 'permission-answered') {
      const index = pending.findIndex((request) => request.id === event.requestId)
      if (index !== -1) pending.splice(index, 1)
    } else {
      return
    }
    render(pending[0] ?? null)
  })

  // The current buffer carries the point (#60): focus follows it. The buffer
  // list unhides the section first, so it can take the focus.
  window.nemesis.onBuffersChanged((list) => {
    const current = list.buffers.find((buffer) => buffer.id === list.currentId)
    if (current?.elementId === REQUEST_ELEMENT_ID) section.focus()
  })

  function render(request: ShownRequest | null): void {
    options.replaceChildren()
    if (request === null) {
      title.textContent = ''
      keys.textContent = ''
      return
    }
    const question = request.questions?.[request.answers.length]
    if (question === undefined) {
      title.textContent = request.title ?? `${request.toolName} wants to run`
      keys.textContent = requestKeys(request.toolName)
      return
    }
    title.textContent = question.question
    options.replaceChildren(
      ...question.options.map((option) => {
        const item = document.createElement('li')
        item.textContent =
          option.description.length === 0 ? option.label : `${option.label}: ${option.description}`
        return item
      }),
    )
    keys.textContent = `1 to ${question.options.length} choose, n decline, or C-x b and type a reply`
  }
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (element === null) throw new Error(`index.html has no #${id}`)
  return element
}
