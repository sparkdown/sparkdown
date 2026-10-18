# App bugs the E2E suite found

Checks that hit one of these stay **PARTIAL** (never PASS) until the app is
fixed. Fixes go to `main` after the 0.4.0 tag decision, not on this branch.

## 1. A reused empty window never publishes its agent context (MCP)

- **Found by:** `mcp-isolation` on every OS (run 39088377564: macOS, Windows,
  Ubuntu, Arch + Hyprland all report `BUG: ['gamma']`).
- **GitHub issue:** not filed yet (pending approval); the draft is in the PR.
- **Affects:** 0.4.0 at main 77fc1cc (multi-window). Not a test artifact.

**Steps**

1. `sparkdown ~/A` (window A opens).
2. In A, File → New Window (Ctrl/⌘+Shift+N): an empty window opens and is focused.
3. Optional, makes it worse: open the terminal in the empty window first.
4. From a shell, `sparkdown ~/C`. Routing correctly reuses the empty window:
   its title becomes "C — SparkDown", the explorer shows C, and the core
   registry has C (`sparkdown_list_windows` lists it).
5. As an agent of that window (`SPARKDOWN_FOLDER=~/C sparkdown --mcp-stdio`,
   or from C's terminal) call `sparkdown_get_context`.

**Expected:** `workspace_root` is `~/C`.
**Actual:** `workspace_root: null`, `updated_at: null` (nothing published),
and no `$SPARKDOWN_CONTEXT` file bridge, until something else re-publishes
(opening a file, editing, or the first terminal reveal).

**Cause:** a folder forwarded to an existing window arrives as the
`open-paths` event and goes through `Workspace.openDroppedPaths`
(`frontend/src/app/workspace.ts`), which only sets the tree root and reports
the folder to the core. Unlike `Workspace.openFolder` it never calls
`publishContextSoon()`, and it also skips `baseDir`/`panes.setBaseDir`,
`cockpit.setCwd` (new terminal tabs don't start in C), recents and the
config save. The same path handles a folder dropped from Finder/Files and a
folder passed on the first launch.

**Unit-level repro:** an `app.integration` test that emits `open-paths` with a
folder to an empty window and waits past the 800 ms publish debounce sees 0
`mcp_publish` calls for that root (control: `openFolder` publishes); with the
terminal already open it is still 0.

**Suggested fix (after the tag decision):** route directories in
`openDroppedPaths` through `openFolder` (keep files as tabs), plus a
regression test asserting `mcp_publish` with the new root.
