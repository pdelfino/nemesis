import { markdown } from '@codemirror/lang-markdown'
import {
  codeFolding,
  defaultHighlightStyle,
  foldEffect,
  foldService,
  syntaxHighlighting,
} from '@codemirror/language'
import { search } from '@codemirror/search'
import {
  Annotation,
  EditorState,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { AgentEvent, AgentQuestion } from '../shared/agent'

/**
 * The transcript as a document (#62): the pure half of the transcript buffer.
 * Every agent event becomes one append at the end of a read-only CodeMirror
 * document; who said what, and where a tool block starts and ends, are
 * decorations and fold ranges over that text, never markup inside it. So
 * search, copy, kill-ring-save and the point behave as they do in any text
 * buffer, and copying a region yields the words on the screen and nothing
 * else. Markdown is highlighted, not rendered.
 *
 * Nothing here touches a window: the unit tests build an EditorState from
 * transcriptExtensions() and run transactionFor() over it. The view, the
 * keys and the search panel are in transcript-buffer.ts.
 */

export type BlockKind =
  'user' | 'assistant' | 'thinking' | 'tool-use' | 'tool-result' | 'request' | 'note'

/** One block: a header line, then zero or more body lines. Positions are in the document. */
export interface TranscriptBlock {
  readonly kind: BlockKind
  /** Start of the header line. */
  readonly from: number
  /** End of the header line. The body, when there is one, starts on the next line. */
  readonly headerTo: number
  /** End of the last body line; equals `headerTo` when the block has no body. */
  readonly to: number
}

export interface TranscriptState {
  readonly blocks: readonly TranscriptBlock[]
  readonly decorations: DecorationSet
  /** Tool names by tool-use id, so a result says which tool answered. */
  readonly toolNames: ReadonlyMap<string, string>
  /** The last block is an assistant block still taking text. */
  readonly open: boolean
}

/** A tool body longer than this starts folded. Thinking always does. */
const FOLD_LINES = 6

const HEADERS: Readonly<
  Record<Exclude<BlockKind, 'tool-use' | 'tool-result' | 'request' | 'note'>, string>
> = {
  user: 'You',
  assistant: 'Claude',
  thinking: 'Thinking',
}

/** Marks the transactions that may change the document: the appends, nothing else. */
export const transcriptWrite = Annotation.define<boolean>()

/** A block was appended. Positions are in the document after the change. */
const blockAdded = StateEffect.define<TranscriptBlock>({
  map: (block, mapping) => mapBlock(block, mapping),
})
/** The open assistant block took more text and now ends at `to`. */
const blockExtended = StateEffect.define<number>({ map: (to, mapping) => mapping.mapPos(to) })
/** A tool was called; its result will be paired by id. */
const toolNamed = StateEffect.define<{ readonly id: string; readonly name: string }>()
/** The turn ended, so the next assistant text starts a block of its own. */
const blockClosed = StateEffect.define<null>()

function mapBlock(block: TranscriptBlock, mapping: ChangeDesc): TranscriptBlock {
  return {
    kind: block.kind,
    from: mapping.mapPos(block.from, 1),
    headerTo: mapping.mapPos(block.headerTo, -1),
    to: mapping.mapPos(block.to, -1),
  }
}

export const transcriptField = StateField.define<TranscriptState>({
  create: () => ({ blocks: [], decorations: Decoration.none, toolNames: new Map(), open: false }),
  update(value, tr) {
    let { blocks, decorations, toolNames, open } = value
    if (tr.docChanged) {
      blocks = blocks.map((block) => mapBlock(block, tr.changes))
      decorations = decorations.map(tr.changes)
    }
    for (const effect of tr.effects) {
      if (effect.is(blockAdded)) {
        const block = effect.value
        blocks = [...blocks, block]
        decorations = decorations.update({
          add: lineDecorations(tr.state, block, block.from),
          sort: true,
        })
        open = block.kind === 'assistant'
      } else if (effect.is(blockExtended)) {
        const last = blocks[blocks.length - 1]
        if (last === undefined) continue
        const grown = { ...last, to: effect.value }
        blocks = [...blocks.slice(0, -1), grown]
        // Only the new lines need decorating; the old ones kept theirs.
        decorations = decorations.update({
          add: lineDecorations(tr.state, grown, last.to + 1),
          sort: true,
        })
      } else if (effect.is(toolNamed)) {
        toolNames = new Map(toolNames).set(effect.value.id, effect.value.name)
      } else if (effect.is(blockClosed)) {
        open = false
      }
    }
    return { blocks, decorations, toolNames, open }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** Line decorations for the lines of `block` that start at or after `fromPos`. */
function lineDecorations(state: EditorState, block: TranscriptBlock, fromPos: number) {
  const ranges = []
  const last = state.doc.lineAt(block.to).number
  for (let number = state.doc.lineAt(fromPos).number; number <= last; number += 1) {
    const line = state.doc.line(number)
    const role = line.from === block.from ? 'tr-header' : 'tr-body'
    ranges.push(
      Decoration.line({ class: role, attributes: { 'data-role': block.kind } }).range(line.from),
    )
  }
  return ranges
}

/**
 * The transaction that appends an event, or null when the event adds nothing
 * to the page. Pure: the unit tests run it over a bare EditorState.
 */
export function transactionFor(state: EditorState, event: AgentEvent): TransactionSpec | null {
  const transcript = state.field(transcriptField)
  switch (event.type) {
    case 'user-text':
      return appendBlock(state, 'user', HEADERS.user, event.text)
    case 'assistant-text':
      return transcript.open
        ? extendBlock(state, event.text)
        : appendBlock(state, 'assistant', HEADERS.assistant, event.text)
    case 'assistant-thinking':
      return appendBlock(state, 'thinking', HEADERS.thinking, event.text, { fold: true })
    case 'tool-use':
      return appendBlock(state, 'tool-use', `Tool: ${event.name}`, formatInput(event.input), {
        fold: 'long',
        effects: [toolNamed.of({ id: event.toolUseId, name: event.name })],
      })
    case 'tool-result': {
      const name = transcript.toolNames.get(event.toolUseId) ?? 'tool'
      const header = `Result: ${name}${event.isError ? ' (error)' : ''}`
      const body = event.text.length === 0 ? '(no output)' : event.text
      return appendBlock(state, 'tool-result', header, body, { fold: 'long' })
    }
    case 'started':
      return appendBlock(
        state,
        'note',
        `Session started: ${event.model}, ${event.permissionMode} mode, in ${event.cwd}`,
        '',
      )
    case 'turn-end':
      return event.isError
        ? appendBlock(state, 'note', `Turn failed: ${event.result}`, '')
        : { effects: blockClosed.of(null) }
    case 'error':
      return appendBlock(state, 'note', `Error: ${event.message}`, '')
    case 'stopped':
      return appendBlock(state, 'note', `Session stopped (${event.reason})`, '')
    case 'permission-request':
      return event.questions === undefined
        ? appendBlock(
            state,
            'request',
            event.title ?? `Permission: ${event.toolName}`,
            `${formatInput(event.input)}\ny allow once, n deny, a allow ${event.toolName} for this session`,
          )
        : appendBlock(
            state,
            'request',
            `Question: ${event.questions.map((question) => question.header).join(', ')}`,
            formatQuestions(event.questions),
          )
    case 'question-answered':
      return appendBlock(state, 'note', `Answered ${event.header}: ${event.answer}`, '')
    case 'permission-answered':
      return event.outcome === 'answered'
        ? null
        : appendBlock(state, 'note', describeOutcome(event.toolName, event.outcome), '')
  }
}

function describeOutcome(
  toolName: string,
  outcome: 'allow' | 'allow-session' | 'deny' | 'aborted',
): string {
  switch (outcome) {
    case 'allow':
      return `Allowed ${toolName} once`
    case 'allow-session':
      return `Allowed ${toolName} for this session`
    case 'deny':
      return `Denied ${toolName}`
    case 'aborted':
      return `Request for ${toolName} withdrawn`
  }
}

/** Each question, its options numbered from 1: what a digit answers. */
function formatQuestions(questions: readonly AgentQuestion[]): string {
  const lines: string[] = []
  for (const question of questions) {
    lines.push(question.question)
    for (const [index, option] of question.options.entries()) {
      const detail = option.description.length === 0 ? '' : `: ${option.description}`
      lines.push(`${index + 1}. ${option.label}${detail}`)
    }
  }
  lines.push('Press a digit to choose, or type a reply in the prompt buffer and send it.')
  return lines.join('\n')
}

interface AppendOptions {
  /** `true` folds the body at once; `'long'` folds it past FOLD_LINES lines. */
  readonly fold?: boolean | 'long'
  readonly effects?: readonly StateEffect<unknown>[]
}

function appendBlock(
  state: EditorState,
  kind: BlockKind,
  header: string,
  body: string,
  options: AppendOptions = {},
): TransactionSpec {
  const separator = state.doc.length === 0 ? '' : '\n\n'
  const text = body.length === 0 ? header : `${header}\n${body}`
  const from = state.doc.length + separator.length
  const block: TranscriptBlock = {
    kind,
    from,
    headerTo: from + header.length,
    to: from + text.length,
  }
  const effects: StateEffect<unknown>[] = [blockAdded.of(block), ...(options.effects ?? [])]
  const lines = body.length === 0 ? 0 : body.split('\n').length
  if (lines > 0 && (options.fold === true || (options.fold === 'long' && lines > FOLD_LINES))) {
    effects.push(foldEffect.of({ from: block.headerTo, to: block.to }))
  }
  return follow(state, { changes: { from: state.doc.length, insert: separator + text }, effects })
}

function extendBlock(state: EditorState, text: string): TransactionSpec {
  const insert = `\n${text}`
  return follow(state, {
    changes: { from: state.doc.length, insert },
    effects: [blockExtended.of(state.doc.length + insert.length)],
  })
}

/**
 * Stamps a write and decides whether the viewport follows it: only when the
 * point sits at the end of the document, as in a comint buffer. A point left
 * on an earlier turn stays there, and so does the viewport.
 */
function follow(state: EditorState, spec: TransactionSpec): TransactionSpec {
  const main = state.selection.main
  const stamped = { ...spec, annotations: transcriptWrite.of(true) }
  if (!main.empty || main.head !== state.doc.length) return stamped
  const end = state.changes(spec.changes).newLength
  return { ...stamped, selection: { anchor: end }, scrollIntoView: true }
}

/** Tool arguments as data on the page, one JSON document, never run or interpreted. */
function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return '(arguments could not be shown)'
  }
}

/** A header line folds its block; the fold gutter, TAB and search all ask here. */
const blockFolding = foldService.of((state, lineStart) => {
  const block = state
    .field(transcriptField)
    .blocks.find((candidate) => candidate.from === lineStart)
  if (block === undefined || block.to <= block.headerTo) return null
  return { from: block.headerTo, to: block.to }
})

/**
 * The document's extensions, without anything that needs a window: the unit
 * tests build an EditorState from these alone.
 */
export function transcriptExtensions(): Extension {
  return [
    transcriptField,
    blockFolding,
    codeFolding(),
    EditorState.readOnly.of(true),
    // Read-only means read-only: whatever a command or the keyboard tries,
    // only a stamped append changes the text.
    EditorState.transactionFilter.of((tr) =>
      tr.docChanged && tr.annotation(transcriptWrite) !== true ? [] : tr,
    ),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search(),
  ]
}
