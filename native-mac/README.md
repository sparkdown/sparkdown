# SparkDown native macOS spike — DO NOT MERGE

Research prototype only (branch `spike/native-mac`). Swift + AppKit, libghostty
(GhosttyKit, built from Ghostty source with Zig) for the terminal, cmark-gfm
for markdown. Nothing here is used by the Tauri app.

- Build: `scripts/build-ghosttykit.sh && scripts/bundle.sh` (macOS arm64, Xcode, Zig).
- CI: `.github/workflows/native-mac-spike.yml` builds, uploads the .app/.dmg, and
  runs `bench/bench.sh` against the Tauri v0.4.1 dmg on a GitHub macOS VM.
- Benchmark on a real Mac: see `bench/RUNBOOK.md`.
