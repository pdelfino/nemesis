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
