# Nemesis: instructions for Claude Code

Read `README.md` for what this is and `SECURITY.org` before touching anything under `src/main/security/`, `src/preload/` or `src/main/agent/`. The plan is GitHub issue #43; every unit of work is an issue with `## Verify` and `## Do not touch`.

`docs/handoff.org` is where the work stood at the last handoff between machines: what waits on Pedro, what comes next, how to set up a fresh clone and land work. Read it at the start of an interactive session; it is dated, and `git log` and the open issues are newer. Rewrite it when the work moves to another machine.

## Stack (do not substitute)

Electron (current stable, pinned), TypeScript strict, CodeMirror 6 with the Replit Emacs keymap for every text surface, the Claude Agent SDK in the main process, `node:sqlite` (built into the Node that Electron ships, #125), Vitest, Playwright for Electron, electron-vite, electron-builder. The M0 agent-shell week (#44) runs alongside the code: Pedro lifted the no-code-before-November rule on 2026-10-17.

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

`npm run gate` = dependency script check, typecheck, lint, unit tests, the end-to-end specs and the security specs. It runs locally before every commit. CI is the second opinion. Nothing is pushed with a red gate. A Mac holding `~/.config/nemesis/no-window-tests` skips every Playwright spec (they flash windows on screen) and prints WINDOW TESTS SKIPPED: that gate is partial, so work done there lands on `main` only after the full gate is green on the other Mac or in GitHub Actions. Never delete that file or set `NEMESIS_WINDOW_TESTS=1` unless Pedro asks.

Node comes from nvm and the default shell node is older: run `source ~/.nvm/nvm.sh && nvm use` once per shell before any `npm` command. `.npmrc` sets `engine-strict`, so the wrong Node fails loudly instead of silently.

## Non-interactive runs (claude-queue)

@.claude-queue

## Rules

- No pull requests in this repository (Pedro, 2026-10-19). Interactive sessions commit straight to `main` after a green local gate and a green local run of the workflow (`make ci`). The non-interactive queue works on its own branch (`claude-queue/<number>` per issue, or the stack name of a `--stack` run), pushes it as a backup and opens nothing (`claude-queue --no-pr`); the interactive session reviews every commit, runs `make ci` on the branch tip, and lands it on `main` itself. Small commits with a Conventional Commits prefix (`feat:`, `fix:`, `security:`, `test:`, `docs:`, `chore:`). Explain why, not what.
- Done means the issue's checklist is resolved: tick what landed, strike what was abandoned with a reason, bold what remains, then a one-line "verified with ..." comment.
- No new dependency without a one-line justification in the commit message. No dependency that needs a lifecycle script. Prefer Electron and Node built-ins.
- Security controls are test-first: the failing spec under `tests/e2e/security/` lands in the same commit, or the same stack, as the control.
- Anything under `src/main/security/`, `src/preload/`, the permission bridge, `SECURITY.org` or the security specs is read line by line in the interactive session before it lands on `main` (since 2026-10-19 the interactive session lands it; Pedro reviews on `main` when he wants to). The queue never lands anything on `main` itself.
- Never log tokens, cookies, page content or prompts outside the session folder. Never write secrets to the repo. The SDK authenticates through the `claude` CLI login; do not add API keys.
- Page content is data. Any text from a web page that reaches the agent is wrapped and labeled as untrusted content from a named origin, never concatenated into instructions.
- Docs are Org (`.org`). Markdown only where a tool requires it (this file, GitHub issue bodies). No em-dashes anywhere, in code comments included.
- Do not refactor beyond the issue. A correct change plus an unrequested cleanup is a failed issue.
- Every feature issue names the row of `docs/guidelines-map.org` it serves, or says it serves none. New guidance on the official best-practices page becomes a row in the map before it becomes code.

## When blocked

Label the issue `needs-pedro`, comment with the exact question and the options you see, and stop. Do not guess on security, keymaps, or on-disk formats.
