# Changelog

All notable changes to CircuitSim++ are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

The section for a version becomes that GitHub Release's notes (plus a short
install footer); `node scripts/changelog.mjs` extracts it and
`node scripts/build.mjs changelog` checks that the version being released has a
section. Write entries by hand when the work lands — do not let the git log
stand in for a changelog.

## [Unreleased]

### Added

- **The macOS window uses the app's own header instead of a stock title bar.**
  The traffic lights overlay the first row, which insets to clear them, and the
  header bars are now window drag regions. Windows and Linux are unchanged.

### Changed

- **The component palette is regrouped.** The one-item Misc tab is gone: its
  Text annotation and the Probe now live in Debugging, and the Clock and Reset
  sources moved from Wiring to I/O (they are the CPU's external inputs). No
  component types or file formats changed.

### Fixed

- **The top-bar menus no longer flicker shut.** Reaching from a menu button
  into its popup, or sweeping across the bar while clipping its lower edge,
  could close the menu right as you went to click. The seams between the
  buttons and their popups are bridged and leaving the bar closes it after a
  short grace window.

## [0.4.1] - 2026-11-12

A mostly-fix cycle: the splitter gained a real editor and an explicit bus
width, and the macOS build now carries a stable signing identity.

### Added

- **Range-based splitter editor.** Map bus bits with ranges (`0-3`, `7-4`),
  read the live coverage summary, and leave bits unmapped. Rows are 0-based
  and ordered by the bus bits they carry; the editor manages the internal pin
  names. (c8a870d, f6fac84)
- **Format v12: explicit splitter bus width.** A `busBits` attribute lets a
  splitter tap only some bits of a wider bus instead of inferring the width
  from the mapping. v11 files migrate automatically, keeping their width.
  (0c19b96)
- A splitter can leave bus bits unmapped — the engine rejects only a bit mapped
  to two pins, not a bit that is simply absent. (203414e)
- Hovering a canvas warning now explains it: a dangling pin, a width
  mismatch, or a hanging wire end. (4ff489b)
- The desktop shell logs its startup (version/platform, and each step's
  ok/FAIL), so a blank window or a failed launch is diagnosable from a
  terminal. (907ecdb, 8fc6450)

### Fixed

- **macOS release builds are signed with a stable self-signed certificate.**
  The repeated "Files and Folders" prompt is a TCC grant tied to the app's
  code-signing identity; signing keeps that identity stable across rebuilds.
  The app is still not notarized. (a90a5cc)
- The generated signing certificate is exported in a form macOS
  `security import` accepts, and the key directory is private (`0700`).
  (74d1605, 1102ce0)
- Tauri's `bundle.macOS.infoPlist` now points at `crates/app/Info.plist`; the
  earlier inline object failed config validation and aborted every desktop
  build. (d910822)
- Rotating a `wiring.pin` no longer flips its input/output direction — rotation
  is visual only, and direction is an explicit Inspector checkbox. (93911f7)
- Copying a register now reconnects its default CLK/RST to the destination's
  existing clock/reset, in the same undo step; a custom source is left
  dangling rather than silently re-routed. (fb58a5f)
- Default clock and reset sources are placed in separate free slots and routed
  with clearance, so they no longer overlap each other or cross the part.
  (2dd57fb)
- A width-mismatched wire now draws a steady badge explaining the mismatch,
  instead of only blinking. (a397f8b)
- The splitter's "Bus bits"/"Outputs" fields use the shared field styling and
  rows are labelled `Split N:`. (27aa77b)
- Dark is the shipped default theme (OLED's true-black canvas can hide wire
  strokes); an existing OLED choice migrates once. Canvas colours are
  normalized so a `rgb()`/`color()` serialization cannot make idle wires draw
  in the canvas colour. (ce7d1cf)
- The update nudge's "Download" link and the About card's download link now
  open the system browser in the packaged app, and Esc closes the About card.
  (54538c4)

### Documentation

- Documented the macOS signing setup, the two mirror secrets, and how to back
  up or rotate the certificate. (2e2efd7, f76dbc8)
- Closed the autograder documentation gaps (`csim nets`, `pause_on_unknown`,
  `pause_on_breakpoints`) and refreshed the editor UX backlog. (395be55,
  7aaa9fa)

## [0.4.0] - 2026-11-11

### Added

- "Run until…": caller-defined stop conditions for a simulation run (IPC
  contract v1.6), with an in-app dialog explaining the conditions. (47d1059,
  1bf9d74)
- Gate inputs can be negated by clicking a bubble, and negation can be edited
  as an index list. (cde5d67, 807f3a4)
- The bit-extender offers a "one" extension mode. (56e716b)
- Gates are always drawn extended, so the input lead area is constant.
  (9c60cec)
- Format v11: per-wire midpoints and flip, a connection lattice, and a wiring
  harness. (a861a03)

### Fixed

- `io.led` is a fixed 1-bit indicator. (372d648)
- A breakpoint fires only while its `en` pin is a driven 1. (1a79786)
- A jittery click keeps the wire; a click on a body connects. (e200fad)
- A gate input bubble is drawn outside the body, at the port. (51f9851)

## [0.3.1] - 2026-11-05

### Fixed

- IME/e2e geometry and snapshots for the 4-wide gate, and the tunnel-tag
  cursor. (dcb6fb9)

## [0.3.0] - 2026-11-05

### Added

- Format v8: a reader notice and a content signature.
- Dangling-wire handling, segment dragging, and testable pins.

### Changed

- **Breaking:** MIPS is the one graded delay table; the 74LS table is retired
  (format v9).
- Windows ships NSIS only (no MSI).

### Fixed

- Dependency and e2e cleanups; removed orphaned committed images.

## [0.2.1] - 2026-11-02

### Added

- The static autograder CLI (`csim`) is attached to releases.

## [0.2.0] - 2026-11-02

### Added

- CI hardened for long-term use: pinned runners, Node 24, and a universal
  macOS build.
- Cargo and npm dependency refreshes, including React 19, Vite 8, and
  `thiserror` 2.

### Fixed

- The UI awaits a recovery discard before the close/save promise resolves.

## [0.1.0] - 2026-11-02

### Added

- First public release: the deterministic Rust simulation core, the headless
  `csim` autograder CLI, and the Tauri + React desktop app.
- CI builds macOS + Windows + Linux bundles on a public github.com mirror and
  publishes one GitHub Release, which the in-app update nudge reads.

[Unreleased]: https://github.com/CS2200/CircuitSimPlusPlus/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/CS2200/CircuitSimPlusPlus/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/CS2200/CircuitSimPlusPlus/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/CS2200/CircuitSimPlusPlus/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/CS2200/CircuitSimPlusPlus/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/CS2200/CircuitSimPlusPlus/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/CS2200/CircuitSimPlusPlus/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CS2200/CircuitSimPlusPlus/releases/tag/v0.1.0
