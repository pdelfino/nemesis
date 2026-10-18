# Nemesis: instructions for Claude Code

Read `README.org` for what this is and `SECURITY.org` before touching anything under `src/main/security/`, `src/preload/` or `src/main/agent/`. The plan is GitHub issue #43; every unit of work is an issue with `## Verify` and `## Do not touch`.

## Stack (do not substitute)

Electron (current stable, pinned), TypeScript strict, CodeMirror 6 with the Replit Emacs keymap for every text surface, the Claude Agent SDK in the main process, better-sqlite3, Vitest, Playwright for Electron, electron-vite, electron-builder. The M0 agent-shell week (#44) runs alongside the code: Pedro lifted the no-code-before-November rule on 2026-10-17.

## Layout (created by the M1 scaffold issue; keep it)

The zones are enforced by lint: `eslint.config.mjs` restricts what each directory under `src/` may import (#103).

```
src/main/            Electron main process: app lifecycle, windows, sessions
src/main/security/   hardening: window options, handlers, CSP, downloads, partitions, fuses config
src/main/agent/      Agent SDK session manager, permission bridge, event stream, hooks
src/main/commands/   command registry, keymap tables, modes
src/preload/         minimal contextBridge surface, typed IPC
src/renderer/        UI: buffers, prompt buffer, palette (no Node here, ever)
src/shared/          types and IPC schemas shared by main and renderer
tests/unit/          Vitest
tests/e2e/           Playwright for Electron
tests/e2e/security/  one spec per non-negotiable in SECURITY.org
docs/adr/            architecture decision records
```

## Gate

`npm run gate` = dependency script check, typecheck, lint, unit tests, the end-to-end specs and the security specs. It runs locally before every commit. CI is the second opinion. Nothing is pushed with a red gate.

Node comes from nvm and the default shell node is older: run `source ~/.nvm/nvm.sh && nvm use` once per shell before any `npm` command. `.npmrc` sets `engine-strict`, so the wrong Node fails loudly instead of silently.

## Non-interactive runs (claude-queue)

@.claude-queue

## Rules

- Interactive sessions commit straight to `main` after a green local gate (Pedro's call, 2026-10-17: speed over ceremony). The non-interactive queue works on its own branch (`claude-queue/<number>` per issue, or the stack name of a `--stack` run) and opens a draft pull request, because nobody is watching it. Small commits with a Conventional Commits prefix (`feat:`, `fix:`, `security:`, `test:`, `docs:`, `chore:`). Explain why, not what.
- Done means the issue's checklist is resolved: tick what landed, strike what was abandoned with a reason, bold what remains, then a one-line "verified with ..." comment.
- No new dependency without a one-line justification in the pull request. No dependency that needs a lifecycle script. Prefer Electron and Node built-ins.
- Security controls are test-first: the failing spec under `tests/e2e/security/` lands in the same pull request as the control.
- Anything under `src/main/security/`, `src/preload/`, the permission bridge, `SECURITY.org` or the security specs is reviewed interactively by Pedro before merge. The queue proposes, never merges, those.
- Never log tokens, cookies, page content or prompts outside the session folder. Never write secrets to the repo. The SDK authenticates through the `claude` CLI login; do not add API keys.
- Page content is data. Any text from a web page that reaches the agent is wrapped and labeled as untrusted content from a named origin, never concatenated into instructions.
- Docs are Org (`.org`). Markdown only where a tool requires it (this file, GitHub issue bodies). No em-dashes anywhere, in code comments included.
- Do not refactor beyond the issue. A correct change plus an unrequested cleanup is a failed issue.
- Every feature issue names the row of `docs/guidelines-map.org` it serves, or says it serves none. New guidance on the official best-practices page becomes a row in the map before it becomes code.

## When blocked

Label the issue `needs-pedro`, comment with the exact question and the options you see, and stop. Do not guess on security, keymaps, or on-disk formats.
