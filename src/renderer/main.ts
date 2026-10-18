import { APP_NAME } from '../shared/api'
import type { BufferType, KeyOutcome } from '../shared/keys'
import { installBufferList } from './buffers'
import { installDiffBuffer } from './diff-buffer'
import { installHelpBuffer } from './help-buffer'
import { installKeyCapture } from './keys'
import { installModeline } from './modeline'
import { installPalette } from './palette'
import { installPlanBuffer } from './plan-buffer'
import { installPromptBuffer } from './prompt-buffer'
import { installRequestBuffer } from './request-buffer'
import { installSpecBuffer } from './spec-buffer'
import { installTranscriptBuffer } from './transcript-buffer'

document.title = APP_NAME
const version = document.getElementById('app-version')
if (version) version.textContent = `v${window.nemesis.version}`

const keys = installKeyCapture()
void installBufferList()
// The context meter and the nudge follow the session from the first event (#80).
installModeline()

// The transcript listens from the first moment, so no event of the session is
// missed while the prompt buffer loads its state (#62).
const transcript = installTranscriptBuffer()
// So does the request section: a permission request may be the first event
// of the session after the user's own text (#63).
installRequestBuffer()
// And the help buffer: describe-command answers there (#65).
const help = installHelpBuffer()
// And the diff buffer: list-diffs opens an Edit or a Write there (#68).
const diff = installDiffBuffer()
// And the plan buffer: a plan the agent asks to leave plan mode with opens there (#82).
const plan = installPlanBuffer()
// And the spec buffer: the spec an interview ends with opens there (#85).
const spec = installSpecBuffer()
// The palette opens when the main process reads a choice (#65).
const palette = installPalette()

// The buffers act on the commands the keys dispatched (#61, #62), and on the
// commands the palette ran (#65). The shape of the keymaps arrives alongside;
// until it does, every chord is reported.
void installPromptBuffer().then((prompt) => {
  const act = (outcome: KeyOutcome, bufferType: BufferType | null): void => {
    // C-g closes an open palette before anything else sees it.
    if (palette.onCommand(outcome)) return
    prompt.onCommand(outcome, bufferType)
    transcript.onCommand(outcome, bufferType)
    help.onCommand(outcome, bufferType)
    diff.onCommand(outcome, bufferType)
    plan.onCommand(outcome, bufferType)
    spec.onCommand(outcome, bufferType)
  }
  keys.onCommand = act
  palette.onRan = act
  // `@` mentions a file at the start of a word and stays text inside one (#83).
  keys.keepAsText = (press) => prompt.keepsAsText(press)
})
void window.nemesis.bindings().then(
  (bindings) => {
    keys.bindings = bindings
  },
  (error: unknown) => console.error('Could not read the key bindings:', error),
)
