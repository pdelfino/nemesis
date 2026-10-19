import { defineConfig } from 'electron-vite'

// Defaults: src/main/index.ts, src/preload/index.ts, src/renderer/index.html.
// Output lands in out/{main,preload,renderer}. Kept explicit-free on purpose:
// every deviation from the template is a line someone has to understand.
export default defineConfig({
  main: {},
  // Two preloads, each its own bundle: the cockpit's bridge and the page-script
  // door of page buffers (ADR 0009). A sandboxed preload can require nothing
  // but electron, so the two must share no chunk.
  preload: {
    build: {
      rollupOptions: {
        input: { index: 'src/preload/index.ts', page: 'src/preload/page.ts' },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        // @replit/codemirror-emacs registers its commands and key table through
        // calls it annotates as pure, so a tree-shaking build drops them and
        // the Emacs keys are silently inert in the shipped bundle (#62 found
        // M-w doing nothing). Ignoring the annotations keeps those calls.
        treeshake: { annotations: false },
      },
    },
  },
})
