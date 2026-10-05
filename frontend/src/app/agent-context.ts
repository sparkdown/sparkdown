import { api } from '../api';
import { debounce } from '../utils';
import type { AppContext } from './context';

/** FNV-1a hash of a buffer, as a short hex string. Used only to detect
 *  "did this tab's text change since the last publish?" — not for security. */
function hashContent(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Fold length in too, so equal-hash-different-length collisions are rarer.
  return `${(h >>> 0).toString(16)}:${text.length}`;
}

/** What the bridge needs from the App. */
export interface AgentContextDeps {
  /** Open a file as a tab (mcp://open). */
  openFile(path: string): Promise<void>;
}

/**
 * Agent context bridge: publish editor state (active tab, cursor, dirty
 * buffers) to the in-app MCP server and to the per-workspace context dir
 * agents read, and answer MCP round trips that edit or open buffers.
 */
export class AgentContextBridge {
  // Debounced hard — this writes files, and per-keystroke frequency is
  // unnecessary for agents.
  private debouncedPublish = debounce(() => void this.publish(), 800);
  // Path → hash of the tab content last shipped to the MCP snapshot, so an
  // unchanged buffer isn't re-serialized over IPC on every cursor move.
  private publishedContentHashes = new Map<string, string>();
  // Bridge gate + cleanup bookkeeping: publish only after the terminal was
  // shown once this session; remember every root we wrote so quit (or
  // disabling the bridge) can remove the shadowed unsaved text from disk.
  private terminalEverOpened = false;
  // Keyed by origin + root: the backend routes context writes/clears by the
  // *current* session, so each root must be cleared while its own machine is
  // the active one (see beginOriginSwitch).
  private publishedContextRoots = new Map<string, { origin: string | null; root: string }>();
  // Between prepare and commit of an origin switch the backend routing is
  // in flux; a publish then could write shadows to a machine we already
  // cleaned (or record them under the wrong origin), so publishing pauses.
  private switchingOrigin = false;
  // The file-bridge write of the publish in flight, so a switch can wait for
  // it before it clears (else the write could land after the clear).
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: AgentContextDeps,
  ) {}

  /** Schedule a publish (debounced). */
  publishSoon(): void {
    this.debouncedPublish();
  }

  /** First terminal reveal arms the bridge (see publish) and publishes right
   *  away so an agent started now sees current state. */
  arm(): void {
    if (this.terminalEverOpened) return;
    this.terminalEverOpened = true;
    this.publishSoon();
  }

  registerMcpListeners(): void {
    // MCP round trips from an agent (mcp.rs): edit an open buffer, or open a
    // file. Each carries an id we must answer with mcp_reply.
    this.ctx.listenTauri<{ id: number; path: string; content: string }>('mcp://edit', (e) => {
      const { id, path, content } = e.payload;
      const reply = (ok: boolean, message = '') => void api.mcpReply({ id, ok, message }).catch(() => {});
      // Active machine only: the agent edits files of the live session, not a
      // kept tab from another machine that happens to share the path.
      const tab = this.ctx.tabs.findByPath(path, this.ctx.tabs.getOrigin());
      if (!tab) return reply(false, `${path} is not open in SparkDown.`);
      if (tab === this.ctx.tabs.activeTab()) {
        // Through the editor: one undoable change; docChanged marks dirty.
        this.ctx.editor.replaceAll(content);
      } else {
        // Not on screen: update the model and drop the cached editor state so
        // switching to it loads the new text instead of the stale snapshot.
        this.ctx.tabs.setContentExternally(tab.id, content);
        this.ctx.editor.forgetState(tab.id);
      }
      this.publishSoon();
      reply(true);
    });

    this.ctx.listenTauri<{ id: number; path: string; line: number | null }>('mcp://open', (e) => {
      const { id, path, line } = e.payload;
      void this.deps.openFile(path)
        .then(() => {
          if (line && this.ctx.tabs.activeTab()?.path === path) this.ctx.editor.gotoLine(line);
          return api.mcpReply({ id, ok: true, message: '' });
        })
        .catch((err) => api.mcpReply({ id, ok: false, message: String(err) }))
        .catch(() => {});
    });
  }

  /**
   * Publish what the user is viewing to the agent-context dir (context.json +
   * shadow copies of unsaved buffers), so an agent running in the terminal —
   * any agent — can read it from $SPARKDOWN_CONTEXT. Never-saved buffers get
   * a synthetic name and become readable via their shadow path.
   */
  async publish(): Promise<void> {
    if (this.switchingOrigin) return;
    const root = this.ctx.fileTree.getRoot() ?? this.ctx.baseDir;
    if (!root) return;
    // Privacy gate: publish only when the user allows the bridge AND has
    // actually opened the terminal this session (the only place an agent
    // can read it from). The in-memory MCP snapshot always learns the
    // enabled flag so its tools can answer "sharing is off" instead of
    // serving stale data.
    const enabled = this.ctx.config.agent_context_enabled && this.terminalEverOpened;
    const tabs = this.ctx.tabs.getAllTabs();
    const active = this.ctx.tabs.activeTab();
    const liveContent = (t: { content: string }) =>
      t === active ? this.ctx.editor.getContent() : t.content;

    // Ship each tab's full text only when it changed since the last publish:
    // a cursor move re-publishes cursor/selection but not every buffer's text.
    // Omitted content is sent as null; mcp.rs carries the previous text forward
    // by path (see mcp_publish). Untitled buffers (no path) can't be matched,
    // so they always ship their content.
    const nextHashes = new Map<string, string>();
    const tabInfos = enabled
      ? tabs.map((t) => {
          const content = liveContent(t);
          if (t.path) {
            const hash = hashContent(content);
            nextHashes.set(t.path, hash);
            const unchanged = this.publishedContentHashes.get(t.path) === hash;
            return { path: t.path, title: t.title, dirty: t.modified, content: unchanged ? null : content };
          }
          return { path: t.path, title: t.title, dirty: t.modified, content };
        })
      : [];

    void api
      .mcpPublish({
        workspace_root: root,
        active_path: active?.path ?? null,
        active_title: active?.title ?? null,
        cursor_line: active ? this.ctx.editor.getCursorLine() : null,
        selection: active ? this.ctx.editor.getSelectionText() : null,
        // Buffer text stays in memory only (never on disk) — the MCP
        // read_buffer tool serves it on demand.
        tabs: tabInfos,
        enabled,
        updated_at: new Date().toISOString(),
      })
      // Only trust the omit-on-unchanged cache once the backend has actually
      // received this snapshot; a failed IPC leaves the backend without the
      // content we'd otherwise skip re-sending. Empty when sharing is off.
      .then(() => { this.publishedContentHashes = enabled ? nextHashes : new Map(); }, () => {});

    // Below: the file bridge (fallback for agents without MCP).
    if (!enabled) return;
    const origin = this.ctx.tabs.getOrigin();
    this.publishedContextRoots.set(`${origin ?? ''}\0${root}`, { origin, root });
    let untitledSeq = 0;
    const shadowName = (t: { path: string | null; title: string }) =>
      t.path
        ? `${t.title}` // dirty saved file: shadow carries the live content
        : `${t.title.replace(/\s+/g, '-') || 'Untitled'}-${++untitledSeq}.md`;

    // Shadow every dirty or never-saved buffer (bounded server-side).
    const buffers = tabs
      .filter((t) => t.modified || !t.path)
      .map((t) => ({
        name: shadowName(t),
        content:
          t === active ? this.ctx.editor.getContent() : t.content,
      }));

    // Recompute names deterministically for the context listing.
    untitledSeq = 0;
    const describe = (t: { path: string | null; title: string; modified: boolean }) => ({
      path: t.path,
      title: t.title,
      dirty: t.modified,
      shadow: t.modified || !t.path ? `buffers/${shadowName(t)}` : null,
    });

    const context = {
      description:
        'What the user is viewing in SparkDown. `active` is the focused ' +
        'editor tab. When `shadow` is set, read that file (relative to this ' +
        'directory) for the buffer\'s live, unsaved content; edit the real ' +
        '`path` when one exists.',
      workspace_root: root,
      active: active ? { ...describe(active), cursor_line: null } : null,
      tabs: tabs.map(describe),
      updated_at: new Date().toISOString(),
    };

    const write = api
      .agentContextUpdate(root, JSON.stringify(context, null, 2), buffers)
      // Context publishing is best-effort; never disturb the editor for it.
      .then(() => undefined, () => undefined);
    this.inFlight = write;
    await write;
    if (this.inFlight === write) this.inFlight = null;
  }

  /**
   * Remove the context dirs written on the active machine. The shadows mirror
   * unsaved text, so they must not outlive the app. Roots from another
   * machine were cleared when the user left it (beginOriginSwitch); the
   * backend would route their clear to the wrong machine, so they are only
   * forgotten here. Best-effort.
   */
  async clear(): Promise<void> {
    await this.inFlight;
    const origin = this.ctx.tabs.getOrigin();
    const entries = [...this.publishedContextRoots.values()];
    this.publishedContextRoots.clear();
    await Promise.all(
      entries
        .filter((e) => e.origin === origin)
        .map((e) => api.agentContextClear(e.root).catch(() => undefined)),
    );
  }

  /**
   * Origin switch step 1 (App.prepareOriginSwitch), while the backend still
   * routes to the machine we are leaving: pause publishing and remove the
   * context dirs written there. Local shadows would otherwise survive a
   * connect-then-quit, and the quit-time clear would go to the remote host.
   */
  async beginOriginSwitch(): Promise<void> {
    this.switchingOrigin = true;
    await this.clear();
  }

  /** Origin switch done (committed or cancelled): publish again. */
  endOriginSwitch(): void {
    if (!this.switchingOrigin) return;
    this.switchingOrigin = false;
    this.publishSoon();
  }
}
