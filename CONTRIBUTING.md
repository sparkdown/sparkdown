# Contributing to SparkDown

Thanks for your interest in contributing! This document covers how to get set
up, the conventions the project follows, and what to expect from review.

## Getting started

1. Fork and clone the repository.
2. Install the prerequisites listed in the [README](README.md#build-from-source): Rust
   (stable), Node.js 22+ (`package.json` requires `^22.22.2 || ^24.15.0 || >=26`),
   and the Tauri platform prerequisites. On Windows, see
   [docs/windows.md](docs/windows.md): `scripts\package-windows.ps1` checks
   the prerequisites and builds the installer.
3. `cd frontend && npm install`
4. `npm run tauri dev` starts the app with frontend hot-reload.

## Before you open a PR

Run the same checks CI will run:

```bash
# Frontend (from frontend/)
npx tsc --noEmit
npm test
npm run build

# Backend (from src-tauri/)
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

All of these must pass — CI gates every pull request.

Then, in the PR itself:

- [ ] **CHANGELOG**: add a line under Unreleased (the top `## [x.y.z] — unreleased`
      section of [CHANGELOG.md](CHANGELOG.md)) for user-visible changes. Write it
      for users, one line, with the PR number in parentheses.

## Testing expectations

- **Rust commands** (`src-tauri/src/commands.rs`) have unit tests alongside
  the code. New commands or validation logic need tests, especially anything
  touching path handling or the filesystem.
- **Frontend logic** is tested with Vitest. Pure logic (utils, tab model,
  render pipeline) gets unit tests; flows that cross the app orchestration
  layer (save/quit guards, session restore) belong in
  `frontend/src/__tests__/app.integration.test.ts`, which runs the real app
  against a mocked Tauri backend — see `frontend/src/__tests__/helpers/`.
- A bug fix should come with a test that fails without the fix.

## Conventions

- **TypeScript**: strict mode is on; keep it clean under `tsc --noEmit`.
- **Rust**: `cargo fmt` formatting, no clippy warnings. Commands return
  `Result<_, AppError>` (see `commands.rs`) — don't introduce `String` errors.
- **Security**: file paths from the frontend must go through
  `validate_path` / `validate_write_path`. Never disable the CSP or iframe
  sandboxing in the preview without discussion first.
- **Types across the boundary**: the TypeScript types in `frontend/src/types/`
  (`AppConfig`, `ThemeMode`, `TerminalLayout`, …) are generated from the Rust
  structs via ts-rs (`cargo test` regenerates them). Edit the Rust side, not
  the generated files.
- **Shortcuts**: a new global shortcut goes in `KEYBINDINGS`
  (`frontend/src/shortcuts.ts`) and, if it has a menu item, the same
  accelerator in `src-tauri/src/menu.rs`; `shortcuts.test.ts` checks that they
  match. Palette entries register in `frontend/src/commands.ts` (see
  `app/builtin-commands.ts`).
- **Dependencies**: keep the footprint small — the ~4 MB installed app is a
  core feature of this project. Justify new runtime dependencies in the PR
  description, and prefer lazy loading for anything heavy (see how Mermaid
  is handled).

## Commit messages

A short imperative summary line, optionally followed by a body explaining the
why. One logical change per commit where practical.

## Code of conduct

Everyone taking part in this project is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

Open a GitHub issue using the matching template. For bugs, include your OS
(macOS version or Linux distro), app version, and reproduction steps — a sample
markdown file helps a lot when the bug is in rendering.

## Security issues

Please do not open public issues for security vulnerabilities. Report them
privately via GitHub's "Report a vulnerability" (Security tab) instead.
