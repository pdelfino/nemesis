# Nemesis

> A Racket-native web browser for macOS.

**Status:** vapor. Pre-embryonic. There is no code yet — only this README and a clear stare across the projects directory at the older sibling.

## What

A web browser. Written in [Racket](https://racket-lang.org/). Targeting macOS first, last, and only.

## Why "Nemesis"

[Nyxt](https://nyxt.atlas.engineer/) is a keyboard-driven, Lisp-extensible web browser. It is excellent. It is also written in Common Lisp, rendered with WebKit/GTK, and pretty much treats macOS as a strange Linux distribution that happens to ship with a fancy trackpad.

In Greek mythology, **Nemesis is the daughter of Nyx.**

So this is not a fork. It is family. A daughter project that grew up with a Mac, and intends to be a native macOS citizen — using WKWebView, AppKit, Cocoa gestures, the share sheet, the services menu, full-screen Spaces, dark mode that doesn't have to be opted into by editing a config file, and a menu bar that doesn't look like it escaped from a 2007 Linux distro screenshot.

Same lineage. Different platform of worship.

## The lovingly-watched older sibling

Mom is sitting right next door:

```
~/projects/
├── nyxt/        ← mom (Common Lisp, WebKit/GTK, Linux-first, born 2017)
└── nemesis/     ← me (Racket, WKWebView, macOS-only, vaporware as of today)
```

Read `../nyxt/` for prior art. Read it for what works, what doesn't translate, and which design decisions to lovingly steal. **Do not** read it as a porting target — Nemesis is not a Racket transpilation of Nyxt; it's a separate browser that happens to share a worldview and half its DNA.

When in doubt about a UX question, ask: "what does mom do here, and is that the right answer on a Mac?" Sometimes yes. Sometimes very much no.

## Why Racket (not Common Lisp)

- `#lang` and language-oriented programming. Beautiful Racket–style DSLs for browser config and extensions.
- `raco distribute` actually produces a real `.app` bundle.
- DrRacket and `racket-mode` for live development.
- Smaller community = less competition, more space for one person to matter.
- Honestly: Common Lisp's tooling is great if you're already in it. For someone starting today on macOS, Racket is friendlier.

## Why macOS-only

- WKWebView is already on every Mac. Free engine, no Chromium to ship, no GTK to fight.
- Mac users pay for software (cf. Arc, Things, Bear, Soulver). Niche but solvent.
- Picking one platform means actually nailing it instead of half-nailing three.
- macOS has the best built-in window management, Spaces, gestures, and clipboard story of any desktop OS. A browser that fully cooperates with all of them does not yet exist.

## Roadmap

1. **Spike (1–2 days):** open a `WKWebView` from Racket via FFI, navigate to a URL, accept one keyboard command. If the FFI is a nightmare, abandon the project and write a blog post about why. If it's tractable, continue.
2. **MVP:** single-window browser, address bar, back/forward, find-in-page, all keyboard-driven, all Cocoa-shaped.
3. **Extensibility:** a `#lang nemesis/config` for declarative configuration, and a way to define new commands, modes, and keymaps without touching Racket source.
4. **Native delights:** trackpad gestures, share sheet, services menu, system-wide dark mode, full-screen Spaces, restore on relaunch, system-keychain credential autofill.
5. Decide whether anyone else cares.

## License

BSD-3-Clause. Matches Nyxt's license, in case anyone ever ports anything in either direction across the family aisle.
