import {
  FORM_FLAGS,
  MAX_NODE_TEXT,
  type FormField,
  type FormFlag,
  type FormKind,
} from './page-door'

/**
 * The form guide's reading of one field (#94): its kind, its flags, its
 * value, and the masking rules that decide which values never leave the
 * page. The page preload (src/preload/page.ts) runs `formField` over each
 * live control in the isolated world and answers `form` through the door of
 * ADR 0009; the unit tests run it over the fixture form's controls.
 *
 * The masking list lives here and nowhere else: `isSecretField` is the one
 * test, and the semantic view's snapshot (#122) masks by it too. A secret
 * field crosses the door as its kind, its label and whether it is filled;
 * its value is the empty string before the answer is built, so main, the
 * agent and the session folder never see it. Masking errs wide: a field a
 * page labels like a secret is masked even when it holds none.
 */

/** The parts of a form control the reading uses: an input, a select or a text area. */
export interface FormControl {
  /** Upper case, as an HTML document gives it: INPUT, SELECT, TEXTAREA. */
  readonly tagName: string
  readonly type?: string
  readonly value?: unknown
  readonly checked?: unknown
  readonly required?: unknown
  readonly disabled?: unknown
  readonly readOnly?: unknown
  readonly validationMessage?: unknown
  readonly selectedIndex?: unknown
  readonly options?: ArrayLike<{ readonly text?: unknown; readonly value?: unknown }>
  readonly files?: { readonly length: number } | null
  getAttribute(name: string): string | null
  /** `:user-invalid`, so a required field nobody touched yet is not shown as wrong. */
  matches?(selector: string): boolean
}

/** The `autocomplete` tokens that name a secret (HTML's autofill field names). */
export const SECRET_AUTOCOMPLETE: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]

/**
 * What a secret field's name, id, label, placeholder or autocomplete says,
 * in English and French, after camelCase and punctuation are split into
 * words: passwords and PINs, card numbers and their security codes, the
 * social insurance number (SIN, NAS) and its US cousin, bank account,
 * transit and routing numbers, IBANs, one-time codes and tokens.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bpass ?(?:word|wd|code|phrase)?\b/,
  /\bmot de passe\b/,
  /\b(?:pin|nip)\b/,
  /\b(?:credit|debit) ?card\b/,
  /\bcard ?(?:number|num|no)\b/,
  /\bcarte (?:de )?(?:credit|debit)\b/,
  /\bnumero de (?:la )?carte\b/,
  /\bcc ?(?:num|number|csc)\b/,
  /\b(?:cvv|cvc|cvn|csc|cid)2?\b/,
  /\bsecurity code\b/,
  /\bcode de securite\b/,
  /\b(?:sin|nas|ssn)\b/,
  /\bsocial ?(?:insurance|security)\b/,
  /\bassurance sociale\b/,
  /\b(?:account|acct) ?(?:number|num|no)\b/,
  /\bnumero de compte\b/,
  /\b(?:iban|routing|transit|aba)\b/,
  /\binstitution ?(?:number|num|no)\b/,
  /\bone ?time\b/,
  /\b(?:otp|totp)\b/,
  /\b(?:secret|token)\b/,
]

/** The words of an attribute, as the patterns read them: split, lower case, unaccented. */
function words(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Whether a field holds a secret, whose value never leaves the isolated
 * world: a password input, an autocomplete token for a secret, or a name,
 * id, label, placeholder or ARIA label that one of SECRET_PATTERNS matches.
 */
export function isSecretField(control: FormControl, label = ''): boolean {
  if (control.tagName === 'INPUT' && (control.type ?? '').toLowerCase() === 'password') return true
  const autocomplete = (control.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/)
  if (autocomplete.some((token) => SECRET_AUTOCOMPLETE.includes(token))) return true
  const said = [
    control.getAttribute('name'),
    control.getAttribute('id'),
    control.getAttribute('placeholder'),
    control.getAttribute('aria-label'),
    label,
  ]
    .map((text) => words(text ?? ''))
    .join(' | ')
  return SECRET_PATTERNS.some((pattern) => pattern.test(said))
}

/** The input types that are not fields a human fills: buttons, and the hidden ones. */
const NOT_FIELDS: ReadonlySet<string> = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

const INPUT_KINDS: Readonly<Record<string, FormKind>> = {
  text: 'text',
  search: 'text',
  email: 'email',
  tel: 'tel',
  url: 'url',
  number: 'number',
  range: 'number',
  date: 'date',
  'datetime-local': 'datetime',
  month: 'month',
  week: 'month',
  time: 'time',
  password: 'password',
  checkbox: 'checkbox',
  radio: 'radio',
  file: 'file',
}

/** The kind of a control, or null for one that is not a field (a button, a hidden input). */
export function fieldKind(control: FormControl): FormKind | null {
  switch (control.tagName) {
    case 'SELECT':
      return 'select'
    case 'TEXTAREA':
      return 'textarea'
    case 'INPUT': {
      const type = (control.type ?? 'text').toLowerCase()
      if (NOT_FIELDS.has(type)) return null
      return INPUT_KINDS[type] ?? 'other'
    }
    default:
      return null
  }
}

/** The kinds the accept key may type into: a line of text the human could type. */
export const TYPABLE_KINDS: ReadonlySet<FormKind> = new Set([
  'text',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'datetime',
  'month',
  'time',
  'textarea',
  'other',
])

/** One line, bounded: what every string of a form answer is cut to. */
export function formLine(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_TEXT) : ''
}

/** A select's options, ` | ` between them, bounded. */
function choicesOf(control: FormControl): string {
  const options = control.options
  if (options === undefined) return ''
  const texts: string[] = []
  for (let index = 0; index < options.length; index += 1) {
    const text = formLine(options[index]?.text)
    if (text.length > 0) texts.push(text)
  }
  return formLine(texts.join(' | '))
}

function selectedText(control: FormControl): string {
  const index = typeof control.selectedIndex === 'number' ? control.selectedIndex : -1
  return index < 0 ? '' : formLine(control.options?.[index]?.text)
}

function bits(on: Readonly<Record<FormFlag, boolean>>): number {
  let value = 0
  FORM_FLAGS.forEach((flag, index) => {
    if (on[flag]) value |= 1 << index
  })
  return value
}

/** The flags of a field, by name. */
export function flagsOf(value: number): readonly FormFlag[] {
  return FORM_FLAGS.filter((_flag, index) => (value & (1 << index)) !== 0)
}

/**
 * One field as the `form` answer carries it, or null when the control is not
 * a field. `label` is the accessible name the preload computed. A secret's
 * value is dropped here, before anything is built around it.
 */
export function formField(control: FormControl, id: number, label: string): FormField | null {
  const kind = fieldKind(control)
  if (kind === null) return null
  const masked = isSecretField(control, label)
  const raw = typeof control.value === 'string' ? control.value : ''
  const checked = control.checked === true
  let filled: boolean
  let value = ''
  switch (kind) {
    case 'checkbox':
    case 'radio':
      filled = checked
      break
    case 'file':
      filled = (control.files?.length ?? 0) > 0 || raw.length > 0
      break
    case 'select': {
      const chosen = selectedText(control)
      filled = raw.length > 0
      if (!masked) value = filled ? chosen : ''
      break
    }
    default:
      filled = raw.trim().length > 0
      if (!masked) value = formLine(raw)
  }
  const invalid =
    control.getAttribute('aria-invalid') === 'true' ||
    (typeof control.matches === 'function' && control.matches(':user-invalid'))
  return {
    id,
    kind,
    label: formLine(label),
    name: formLine(control.getAttribute('name')),
    placeholder: formLine(control.getAttribute('placeholder')),
    choices: kind === 'select' && !masked ? choicesOf(control) : '',
    message: invalid ? formLine(control.validationMessage) : '',
    value,
    flags: bits({
      required: control.required === true || control.getAttribute('aria-required') === 'true',
      filled,
      masked,
      disabled: control.disabled === true,
      readonly: control.readOnly === true,
      invalid,
      checked,
    }),
  }
}
