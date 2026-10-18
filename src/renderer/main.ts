import { APP_NAME } from '../shared/api'
import { installBufferList } from './buffers'
import { installKeyCapture } from './keys'
import { installPromptBuffer } from './prompt-buffer'

document.title = APP_NAME
const version = document.getElementById('app-version')
if (version) version.textContent = `v${window.nemesis.version}`

const keys = installKeyCapture()
void installBufferList()

// The prompt buffer acts on the commands the keys dispatched (#61). The shape
// of the keymaps arrives alongside; until it does, every chord is reported.
void installPromptBuffer().then((prompt) => {
  keys.onCommand = (outcome, bufferType) => prompt.onCommand(outcome, bufferType)
})
void window.nemesis.bindings().then(
  (bindings) => {
    keys.bindings = bindings
  },
  (error: unknown) => console.error('Could not read the key bindings:', error),
)
