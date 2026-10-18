import { APP_NAME } from '../shared/api'
import { installBufferList } from './buffers'
import { installKeyCapture } from './keys'
import { installPromptBuffer } from './prompt-buffer'
import { installRequestBuffer } from './request-buffer'
import { installTranscriptBuffer } from './transcript-buffer'

document.title = APP_NAME
const version = document.getElementById('app-version')
if (version) version.textContent = `v${window.nemesis.version}`

const keys = installKeyCapture()
void installBufferList()

// The transcript listens from the first moment, so no event of the session is
// missed while the prompt buffer loads its state (#62).
const transcript = installTranscriptBuffer()
// So does the request section: a permission request may be the first event
// of the session after the user's own text (#63).
installRequestBuffer()

// The buffers act on the commands the keys dispatched (#61, #62). The shape
// of the keymaps arrives alongside; until it does, every chord is reported.
void installPromptBuffer().then((prompt) => {
  keys.onCommand = (outcome, bufferType) => {
    prompt.onCommand(outcome, bufferType)
    transcript.onCommand(outcome, bufferType)
  }
})
void window.nemesis.bindings().then(
  (bindings) => {
    keys.bindings = bindings
  },
  (error: unknown) => console.error('Could not read the key bindings:', error),
)
