import { defineConfig } from 'electron-vite'

// Defaults: src/main/index.ts, src/preload/index.ts, src/renderer/index.html.
// Output lands in out/{main,preload,renderer}. Kept explicit-free on purpose:
// every deviation from the template is a line someone has to understand.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {},
})
