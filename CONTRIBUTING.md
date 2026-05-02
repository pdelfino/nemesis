# Contributing to Nemesis

Nemesis is macOS-only. Development requires a Mac with the Xcode Command Line
Tools installed so Cocoa and WebKit framework headers are reachable for Racket
FFI binding.

## Toolchain prerequisites

- **Racket**: pinned to v9.1 (see `.tool-versions` and the README).
- **Xcode Command Line Tools**: required for Cocoa/WebKit headers used by
  `nemesis/ffi/`. Install with `xcode-select --install` (this opens a GUI
  dialog — accept it). To verify:

  ```sh
  xcode-select -p                  # should print a path, e.g. /Library/Developer/CommandLineTools
  xcrun --show-sdk-path            # should print the active macOS SDK path
  ls /System/Library/Frameworks/WebKit.framework
  ls /System/Library/Frameworks/AppKit.framework
  ```

  All four must succeed before attempting any Phase 1 FFI work.

## Editor setup

Canonical: **Emacs + [racket-mode](https://github.com/greghendershott/racket-mode)**.
Pedro lives in Emacs, the project is written by someone who lives in Emacs, and
`racket-mode` gives you the live REPL, cross-reference, on-the-fly documentation,
and `raco fmt` integration that the rest of the workflow expects. A
`.dir-locals.el` is committed at the repo root so `fill-column`, indentation,
and a few racket-mode niceties are set automatically when you open a file here.

To set it up:

```elisp
;; In your Emacs config:
(use-package racket-mode
  :ensure t
  :hook ((racket-mode . racket-xp-mode)
         (racket-mode . paredit-mode)))
```

The first time you open a `.rkt` file in this repo, Emacs will ask whether to
trust the directory-local variables — answer `!` to mark them safe.

Supported alternatives (use whichever you prefer; the canonical choice is just
the one that gets first-class config):

- **DrRacket** — bundled with Racket; great for one-off macro exploration and
  for newcomers who want zero setup. Open files directly and use `F5` to run.
- **VS Code + [Magic Racket](https://marketplace.visualstudio.com/items?itemName=evzen-wybitul.magic-racket)**
  — path-of-least-resistance for contributors who don't already have an Emacs
  or DrRacket workflow. Install Magic Racket, point it at the same Racket v9.1
  on `PATH`, and you'll get syntax highlighting + a REPL.

Whatever editor you use, the project's source-of-truth checks are
`raco fmt --check` and `raco test -p nemesis`. Editor integrations are a
nicety, not a substitute.
