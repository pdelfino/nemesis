import { APP_NAME } from '../shared/api'
import { installKeyCapture } from './keys'

document.title = APP_NAME
const version = document.getElementById('app-version')
if (version) version.textContent = `v${window.nemesis.version}`

installKeyCapture()
