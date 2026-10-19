import type { PageEvent } from '../../shared/buffers'
import type { FormGuideContent } from '../../shared/form-guide'
import { flagsOf, TYPABLE_KINDS } from '../../shared/form-snapshot'
import type { FormAlert, FormAnswer, FormField, FormFlag } from '../../shared/page-door'
import {
  formGuidePrompt,
  guidanceOf,
  parseSuggestion,
  type FormGuideFacts,
  type FormSuggestion,
} from '../agent/form-guide'
import { describeOrigin } from '../ipc'
import { formatRef } from './semantic'

/**
 * Watch me fill this form (#94): a watch mode on a page buffer. While it is
 * on, main asks the page's door for `form` every POLL_MS; the preload's
 * observer says whether anything moved, so an idle page costs a number. Once
 * the form has been still for QUIET_MS after a change (a focus, a value, a
 * message, a field appearing), the form goes to the guide's own session
 * (src/main/agent/form-guide.ts) as the cockpit's header and the page's
 * text in `wrapUntrusted`'s block, and the reply shows in the guide pane
 * beside the page.
 *
 * - The human fills every field. `form-guide-accept` types the guide's
 *   suggestion, and only after the pane showed it, only into the field it
 *   names, only while that field has the focus, only into a field that takes
 *   typed text and is not masked. It replaces the field's text and presses
 *   no key: no Enter, so no submit. There is no command that fills more
 *   than that one field, and none that clicks or submits.
 * - Secret values never get here: the preload masks them before the answer
 *   leaves the page (src/shared/form-snapshot.ts).
 * - Refs are the semantic view's (#122), under the page's current document,
 *   so a committed navigation retires the suggestion with the old refs. A
 *   watch stays on across a navigation, since a long form spans pages.
 * - Nothing is written to disk: the readings and the replies live in this
 *   object and the pane for as long as the watch does.
 *
 * Nothing here touches Electron: the door, the page buffers, the guide's
 * session and the window come in through `FormGuideOptions`.
 */

/** How often a watched page is asked whether its form moved. */
export const POLL_MS = 500

/** How long the form must be still after a change before the guide reads it. */
export const QUIET_MS = 1200

/** The guide's session as the watch uses it: a prompt in, the reply's text out. */
export interface FormGuideAsker {
  ask(prompt: string): Promise<string>
  stop(): Promise<void>
}

export interface FormGuideOptions {
  /** The door's `form` answer for a page buffer, asked with the change count main last saw. */
  readonly read: (pageId: string, known: number) => Promise<FormAnswer>
  /** The semantic view: the page's current document number, and what a ref names. */
  readonly semantic: {
    currentDocument(pageId: string): number
    resolve(ref: string): { readonly pageId: string; readonly element: number } | null
  }
  /** A page buffer's committed URL; undefined when the page is gone or has committed none. */
  readonly committedUrl: (pageId: string) => string | undefined
  /** A fresh guide session for one watch. */
  readonly guide: () => FormGuideAsker
  /** Puts `form-guide` in a page's modes, or takes it off. */
  readonly mode: (pageId: string, on: boolean) => void
  /** Replaces the text of the page's focused field, through the page's own input path. */
  readonly type: (pageId: string, text: string) => Promise<void>
  /** The pane's content, pushed to the window. */
  readonly push: (content: FormGuideContent) => void
  readonly notify: (text: string) => void
  /** Every page's event stream: a committed navigation retires the old document's refs. */
  readonly events: (listener: (event: PageEvent) => void) => unknown
  readonly pollMs?: number
  readonly quietMs?: number
  readonly now?: () => number
  /** Runs `tick` every `ms`; the cancel. `setInterval` unless a test drives the ticks. */
  readonly every?: (ms: number, tick: () => void) => () => void
}

/** One field as main holds it: the door's field and its ref. */
export interface FormFieldRef extends FormField {
  readonly ref: string
}

/** One full reading of a page's form. */
export interface FormReading {
  /** The committed URL main held when it read. */
  readonly url: string
  readonly origin: string
  readonly document: number
  /** The focused field's ref, or null. */
  readonly focused: string | null
  readonly fields: readonly FormFieldRef[]
  readonly alerts: readonly FormAlert[]
}

/** A suggestion as the pane shows it: the guide's, for one field of one reading. */
export interface ShownSuggestion extends FormSuggestion {
  /** Page content: the field's label when the suggestion was made. */
  readonly label: string
}

/** What a page's watch shows, for the pane and the spec. */
export interface FormGuideState {
  readonly reading: FormReading | null
  readonly guidance: string
  readonly suggestion: ShownSuggestion | null
  readonly status: string
}

interface Watch {
  readonly guide: FormGuideAsker
  readonly cancel: () => void
  /** The change count of the last answer. */
  known: number
  /** The latest reading, and its signature. */
  reading: FormReading | null
  seen: string | null
  /** When the signature last changed. */
  seenAt: number
  /** The signature last sent to the guide. */
  sent: string | null
  /** A read is out to the door, or a reply is awaited from the guide. */
  polling: boolean
  asking: boolean
  guidance: string
  suggestion: ShownSuggestion | null
  status: string
}

function has(field: FormField, flag: FormFlag): boolean {
  return flagsOf(field.flags).includes(flag)
}

/** The fields under their refs, and the focused one's ref. */
export function formReading(url: string, document: number, answer: FormAnswer): FormReading {
  const fields = answer.fields.map((field) => ({ ...field, ref: formatRef(document, field.id) }))
  const focused = fields.find((field) => field.id === answer.focused)?.ref ?? null
  return { url, origin: describeOrigin(url), document, focused, fields, alerts: answer.alerts }
}

/** What changes when the form does: the fields, the focus and the alerts, not the change count. */
function signature(reading: FormReading): string {
  return JSON.stringify([reading.focused, reading.fields, reading.alerts])
}

/** One field as a line: the ref, the kind, the page's strings quoted as data, the state. */
export function fieldLine(field: FormFieldRef, focused: boolean): string {
  const parts = [`[${field.ref}]`, field.kind]
  if (field.label.length > 0) parts.push(JSON.stringify(field.label))
  if (field.name.length > 0) parts.push(`name ${JSON.stringify(field.name)}`)
  if (field.placeholder.length > 0) parts.push(`placeholder ${JSON.stringify(field.placeholder)}`)
  if (field.choices.length > 0) parts.push(`choices ${JSON.stringify(field.choices)}`)
  if (field.value.length > 0) parts.push(`value ${JSON.stringify(field.value)}`)
  const state: string[] = []
  if (focused) state.push('focused')
  for (const flag of flagsOf(field.flags)) if (flag !== 'filled') state.push(flag)
  state.push(has(field, 'filled') ? 'filled' : 'empty')
  parts.push(`(${state.join(', ')})`)
  if (field.message.length > 0) parts.push(`message ${JSON.stringify(field.message)}`)
  return parts.join(' ')
}

/** The form as text, one field a line, then the alerts: the body of the guide's untrusted block. */
export function formText(reading: FormReading): string {
  const lines = reading.fields.map((field) => fieldLine(field, field.ref === reading.focused))
  if (lines.length === 0) lines.push('No form fields on this page.')
  if (reading.alerts.length > 0) {
    lines.push('', 'Alerts on the page:')
    for (const alert of reading.alerts) lines.push(JSON.stringify(alert.text))
  }
  return lines.join('\n')
}

/** The header's facts, counted by main from the reading. */
export function formFacts(reading: FormReading): FormGuideFacts {
  const required = reading.fields.filter((field) => has(field, 'required'))
  return {
    origin: reading.origin,
    focused: reading.focused,
    fields: reading.fields.length,
    required: required.length,
    requiredFilled: required.filter((field) => has(field, 'filled')).length,
    invalid: reading.fields.filter((field) => has(field, 'invalid')).length,
  }
}

/** The prompt one reading sends: the cockpit's header, then the form as untrusted data. */
export function readingPrompt(reading: FormReading): string {
  return formGuidePrompt(formFacts(reading), formText(reading))
}

/** The pane's text: the cockpit's lines, the guide's reply, the suggestion and its key. */
export function paneText(state: FormGuideState): string {
  const { reading } = state
  const lines: string[] = []
  if (reading === null) {
    lines.push('Form guide: watching this page.')
  } else {
    const facts = formFacts(reading)
    lines.push(
      `Form guide: watching ${reading.origin}. Text in quotes is the page's own, shown as data.`,
      `Required fields filled: ${facts.requiredFilled} of ${facts.required}.`,
    )
    const focused = reading.fields.find((field) => field.ref === reading.focused)
    lines.push(
      focused === undefined
        ? 'No field has the focus.'
        : `Focused: [${focused.ref}] ${JSON.stringify(focused.label)}`,
    )
  }
  lines.push('', state.status)
  if (state.guidance.length > 0) lines.push('', state.guidance)
  if (state.suggestion !== null) {
    lines.push(
      '',
      `Suggested for [${state.suggestion.ref}] ${JSON.stringify(state.suggestion.label)}: ${JSON.stringify(state.suggestion.value)}`,
      'C-c C-y types it into that field while it has the focus. Nothing else is typed, and nothing is submitted.',
    )
  }
  return lines.join('\n')
}

const WAITING = 'Waiting for the form to change. Fill it as usual; guidance follows.'
const ASKING = 'Reading the form...'
const CHANGED = 'The form changed; guidance follows once it is still.'

export class FormGuide {
  private readonly watches = new Map<string, Watch>()
  private readonly now: () => number

  constructor(private readonly options: FormGuideOptions) {
    this.now = options.now ?? (() => Date.now())
    // A new document has new refs: the old reading and suggestion go, the watch stays.
    options.events((event) => {
      if (event.type !== 'committed') return
      const watch = this.watches.get(event.pageId)
      if (watch === undefined) return
      watch.known = 0
      watch.reading = null
      watch.seen = null
      watch.sent = null
      watch.guidance = ''
      watch.suggestion = null
      watch.status = WAITING
      this.show(event.pageId)
    })
  }

  watching(pageId: string): boolean {
    return this.watches.has(pageId)
  }

  /** What a page's watch shows; null when the page is not watched. */
  state(pageId: string): FormGuideState | null {
    const watch = this.watches.get(pageId)
    if (watch === undefined) return null
    return {
      reading: watch.reading,
      guidance: watch.guidance,
      suggestion: watch.suggestion,
      status: watch.status,
    }
  }

  /** `form-guide-mode`: watching on, or off when it was on. */
  async toggle(pageId: string): Promise<void> {
    if (this.watches.has(pageId)) {
      await this.stop(pageId)
      return
    }
    this.start(pageId)
  }

  start(pageId: string): void {
    if (this.watches.has(pageId)) return
    if (this.options.committedUrl(pageId) === undefined) {
      this.options.notify('The page has not loaded a URL yet')
      return
    }
    const every =
      this.options.every ??
      ((ms: number, tick: () => void) => {
        const timer = setInterval(tick, ms)
        return () => clearInterval(timer)
      })
    const watch: Watch = {
      guide: this.options.guide(),
      cancel: every(this.options.pollMs ?? POLL_MS, () => {
        void this.tick(pageId)
      }),
      known: 0,
      reading: null,
      seen: null,
      seenAt: 0,
      sent: null,
      polling: false,
      asking: false,
      guidance: '',
      suggestion: null,
      status: WAITING,
    }
    this.watches.set(pageId, watch)
    this.options.mode(pageId, true)
    this.show(pageId)
    void this.tick(pageId)
  }

  async stop(pageId: string): Promise<void> {
    const watch = this.watches.get(pageId)
    if (watch === undefined) return
    this.watches.delete(pageId)
    watch.cancel()
    this.options.mode(pageId, false)
    this.options.push({ pageId, watching: false, text: '' })
    await watch.guide.stop().catch(() => undefined)
  }

  /** Stops every watch: the window is closing. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.watches.keys()].map((pageId) => this.stop(pageId)))
  }

  /**
   * One poll: a full reading when the form moved, and the guide asked once
   * the form has been still for QUIET_MS since its last change.
   */
  async tick(pageId: string): Promise<void> {
    const watch = this.watches.get(pageId)
    if (watch === undefined || watch.polling) return
    watch.polling = true
    try {
      const url = this.options.committedUrl(pageId)
      if (url === undefined) {
        // The page buffer is gone: its watch and its guide session go with it.
        await this.stop(pageId)
        return
      }
      const document = this.options.semantic.currentDocument(pageId)
      let answer: FormAnswer
      try {
        answer = await this.options.read(pageId, watch.known)
      } catch {
        // A page that is busy, navigating or misbehaving is read again on the next tick.
        return
      }
      if (this.watches.get(pageId) !== watch) return
      if (this.options.semantic.currentDocument(pageId) !== document) return
      if (this.options.committedUrl(pageId) !== url) return
      if (answer.same === 0) {
        watch.known = answer.version
        const reading = formReading(url, document, answer)
        const seen = signature(reading)
        if (seen !== watch.seen) {
          watch.seen = seen
          watch.seenAt = this.now()
          watch.reading = reading
          if (!watch.asking && watch.sent !== null && watch.status !== CHANGED) {
            watch.status = CHANGED
            this.show(pageId)
          }
        }
      }
    } finally {
      watch.polling = false
    }
    const quiet = this.options.quietMs ?? QUIET_MS
    if (
      watch.reading !== null &&
      watch.seen !== watch.sent &&
      !watch.asking &&
      this.now() - watch.seenAt >= quiet
    ) {
      await this.ask(pageId, watch, watch.reading)
    }
  }

  /** The reading out to the guide; its reply, and a suggestion for the focused field, into the pane. */
  private async ask(pageId: string, watch: Watch, reading: FormReading): Promise<void> {
    watch.asking = true
    watch.sent = watch.seen
    watch.status = ASKING
    this.show(pageId)
    let reply: string
    try {
      reply = await watch.guide.ask(readingPrompt(reading))
    } catch (error) {
      if (this.watches.get(pageId) !== watch) return
      watch.asking = false
      watch.status = `The guide could not answer: ${error instanceof Error ? error.message : String(error)}`
      this.show(pageId)
      return
    }
    if (this.watches.get(pageId) !== watch) return
    watch.asking = false
    // A reply about a document the page has left is dropped whole.
    if (watch.reading?.document !== reading.document) return
    watch.guidance = guidanceOf(reply)
    watch.suggestion = this.suggestionFor(reading, parseSuggestion(reply))
    watch.status = watch.seen === watch.sent ? 'Guidance for the form as it is now.' : CHANGED
    this.show(pageId)
  }

  /** A suggestion the pane may offer: for the reading's focused field, one the accept key may type into. */
  private suggestionFor(
    reading: FormReading,
    suggestion: FormSuggestion | null,
  ): ShownSuggestion | null {
    if (suggestion === null || suggestion.ref !== reading.focused) return null
    const field = reading.fields.find((one) => one.ref === suggestion.ref)
    if (field === undefined || !this.typable(field)) return null
    return { ...suggestion, label: field.label }
  }

  private typable(field: FormField): boolean {
    return (
      TYPABLE_KINDS.has(field.kind) &&
      !has(field, 'masked') &&
      !has(field, 'disabled') &&
      !has(field, 'readonly')
    )
  }

  /**
   * `form-guide-accept`: the shown suggestion typed into its field, after a
   * fresh read confirms the field is the page's focused one in the same
   * document, and still one that takes typed text. Any doubt types nothing.
   */
  async accept(pageId: string): Promise<void> {
    const watch = this.watches.get(pageId)
    if (watch === undefined) {
      this.options.notify('The form guide is not watching this page')
      return
    }
    const suggestion = watch.suggestion
    if (suggestion === null) {
      this.options.notify('The guide has shown no suggestion to type')
      return
    }
    const resolved = this.options.semantic.resolve(suggestion.ref)
    const url = this.options.committedUrl(pageId)
    if (resolved?.pageId !== pageId || url === undefined) {
      watch.suggestion = null
      this.show(pageId)
      this.options.notify('The page navigated; that suggestion is gone')
      return
    }
    const document = this.options.semantic.currentDocument(pageId)
    // Change count 0 is never the preload's, so the answer is a full read.
    const answer = await this.options.read(pageId, 0)
    if (this.options.semantic.currentDocument(pageId) !== document) {
      this.options.notify('The page navigated; that suggestion is gone')
      return
    }
    const field = answer.fields.find((one) => one.id === resolved.element)
    if (answer.focused !== resolved.element || field === undefined) {
      this.options.notify(
        `The suggestion is for [${suggestion.ref}]; put the focus on that field first`,
      )
      return
    }
    if (!this.typable(field)) {
      this.options.notify(`[${suggestion.ref}] does not take typed text; nothing was typed`)
      return
    }
    // One shot: the suggestion is spent before the text goes, so a second key types nothing.
    watch.suggestion = null
    await this.options.type(pageId, suggestion.value)
    this.show(pageId)
    this.options.notify(`Typed the guide's suggestion into [${suggestion.ref}]`)
  }

  private show(pageId: string): void {
    const state = this.state(pageId)
    if (state === null) return
    this.options.push({ pageId, watching: true, text: paneText(state) })
  }
}
