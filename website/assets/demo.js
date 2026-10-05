/* Animated product demos: mini SparkDown windows driven by a declarative
   timeline ({ at: ms, do: fn }). No dependencies.

   - A demo starts when 40 % of it is in view and pauses when it leaves.
   - prefers-reduced-motion: the final frame, no autoplay (Play still works).
   - Debug hook for frame checks: ?demo=hero&t=5400 (or demo=loop) seeks
     that demo to 5.4 s and holds it there. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const params = new URLSearchParams(location.search);
  let instant = false; // true while seeking: no transitions, no WAAPI

  // ---- Small helpers -------------------------------------------------------
  const svg = (d, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true">${d}</svg>`;
  const IC = {
    files: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    chg: svg('<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 8.2v7.6M18 11.2c0 4-6 2.8-11.2 5.3"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
    remote: svg('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
    term: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="m7 9 3 3-3 3M12 15h5"/>'),
    filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>'),
    up: svg('<path d="m7 14 5-5 5 5"/>'),
    chev: svg('<path d="m9 6 6 6-6 6"/>'),
    refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'),
    sright: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M12 4v16"/>'),
    sdown: svg('<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 12h18"/>'),
    branch: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-7 3-11 5.5"/>'),
    check: svg('<path d="m5 12 5 5 9-10"/>'),
    list: svg('<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>'),
    olist: svg('<path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M4 14h3l-3 4h3"/>'),
    code: svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>'),
    block: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m9 10-2 2 2 2M15 10l2 2-2 2"/>'),
    quote: svg('<path d="M5 7v10M10 9h9M10 15h6"/>'),
    link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    img: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>'),
    table: svg('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 10h18M3 15h18M10 4v16"/>'),
  };
  const pop = (el, frames, opts) => {
    if (!instant && el && el.animate) el.animate(frames, Object.assign({ duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' }, opts));
  };
  const tick = (el, text) => {
    if (!el || el.textContent === String(text)) return;
    el.textContent = text;
    pop(el, [{ transform: 'translateY(45%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240 });
  };

  // Shared window chrome --------------------------------------------------
  const titleBar = (tab) => `
    <div class="tb">
      <div class="lights"><i></i><i></i><i></i></div>
      <div class="tabs"><div class="tab"><span class="tabn">${tab}</span><span class="x">×</span></div></div>
      <div class="tb-end">
        <div class="vseg"><i class="pill"></i><span class="v1">Edit</span><span class="v2">Split</span><span class="v3">Preview</span><span class="v4">Diff</span></div>
        <span class="ib tbtn">${IC.term}</span>
      </div>
    </div>`;
  const activity = (badge) => `
    <nav class="act">
      <b class="a-files">${IC.files}</b>
      <b class="a-chg">${IC.chg}<span class="badge${badge ? '' : ' off'}">${badge || 0}</span></b>
      <b>${IC.search}</b><span class="sp"></span><b>${IC.remote}</b><b>${IC.gear}</b>
    </nav>`;
  const filesHead = `<div class="sh"><h4>atlas-docs</h4><span class="ib">${IC.filter}</span><span class="ib on">${IC.eye}</span><span class="ib">${IC.up}</span></div>`;
  // [indent level, name, kind: d (dir, open) | c (dir, closed) | f, path, badge, extra class]
  const tree = (rows) => '<div class="tree">' + rows.map(([lv, nm, k, p = '', gb = '', cls = '']) => {
    const dir = k !== 'f';
    const ch = dir ? `<span class="ch${k === 'd' ? ' x' : ''}">${IC.chev}</span>` : '<span class="ch"></span>';
    const g = gb ? `<span class="gb ${gb === '•m' ? 'm' : gb === '•u' ? 'u' : gb.toLowerCase()}">${gb[0] === '•' ? '•' : gb}</span>` : '<span class="gb"></span>';
    return `<div class="row${dir ? ' dir' : ''}${cls ? ' ' + cls : ''}" data-p="${p || nm}" style="padding-left:${8 + lv * 14}px">${ch}<span class="nm">${nm}</span>${g}</div>`;
  }).join('') + '</div>';
  const statusBar = (path, counts) => `
    <div class="sb"><span class="sbp">${path}</span><span>${IC.branch}main</span><span><i class="okd"></i>Agent tools on</span><span class="gr"></span>${counts}<span>Wrap: On</span></div>`;
  const pane = (cls, name, path, body, top = true) => `
    <div class="tp ${cls}"><div class="th"><span class="lv"></span><span class="tn">${name}</span><span class="tpath">${path}</span><i>${IC.sright}</i><i>${IC.sdown}</i><i>×</i></div><div class="tt${top ? ' top' : ''}">${body}</div></div>`;
  const editorToolbar = `<div class="etb"><span>B</span><span><em>I</em></span><span>H</span><span class="sep"></span><span>${IC.list}</span><span>${IC.olist}</span><span class="sep"></span><span>${IC.code}</span><span>${IC.block}</span><span>${IC.quote}</span><span>${IC.link}</span><span>${IC.img}</span><span>${IC.table}</span></div>`;
  const lines = (arr, active) => arr.map((h, i) => `<div class="ln${i + 1 === active ? ' al' : ''}"><span class="g">${i + 1}</span><span>${h}</span></div>`).join('');
  const hud = '<div class="hud"><span class="caps"></span><span class="lbl"></span></div>';
  const dl = (kind, text) => `<div class="dl2 ${kind}">${text}</div>`;
  const hunk = (head, rows) => `<div class="hk"><div class="hh"><span>${head}</span><span>Open in editor</span></div>${rows.join('')}</div>`;
  const diffHead = (name, meta) => `<div class="dh"><div class="path"><b>${name}</b><span>${meta}</span></div><div class="mini"><span>Reading</span><span>Full</span></div><span class="db">↑</span><span class="db">↓</span><span class="db pri">Mark reviewed</span></div>`;

  function showKeys(w, keys, label) {
    const h = w.querySelector('.hud');
    h.querySelector('.caps').innerHTML = keys.map((k) => `<span class="cap">${k}</span>`).join('');
    h.querySelector('.lbl').textContent = label;
    h.classList.add('on');
    h.querySelectorAll('.cap').forEach((c, i) =>
      pop(c, [{ transform: 'none' }, { transform: 'translateY(2px)', borderBottomWidth: '1px' }, { transform: 'none' }], { duration: 220, delay: 160 + i * 40 }));
  }
  const hideKeys = (w) => w.querySelector('.hud').classList.remove('on');
  function termLine(pre, html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    if (!instant) d.className = 'tl-in';
    pre.appendChild(d);
    while (pre.children.length > 40) pre.firstChild.remove();
    return d;
  }

  // ---- Timeline engine -------------------------------------------------------
  function Timeline(el, def) {
    const steps = [];
    const at = (ms, fn) => steps.push({ at: ms, do: fn });
    def.script(at);
    steps.sort((a, b) => a.at - b.at);
    const total = def.total;
    let t = 0, idx = 0, last = null, playing = false;
    const api = { total, done: false, playing: () => playing, onstate: () => {} };
    let w;
    const reset = () => { el.innerHTML = def.html(); w = el.firstElementChild; api.w = w; idx = 0; t = 0; def.reset && def.reset(w); };
    const applyUntil = (time) => { while (idx < steps.length && steps[idx].at <= time) steps[idx++].do(w); };
    const frame = (now) => {
      if (!playing) return;
      t += last === null ? 0 : Math.min(now - last, 100);
      last = now;
      applyUntil(t);
      if (t >= total) { playing = false; api.done = true; api.onstate(); return; }
      requestAnimationFrame(frame);
    };
    api.play = () => {
      if (playing) return;
      if (api.done || !w) { api.seek(0); api.done = false; }
      playing = true; last = null; api.onstate();
      requestAnimationFrame(frame);
    };
    api.pause = () => { if (!playing) return; playing = false; api.onstate(); };
    api.seek = (time) => {
      playing = false;
      instant = true;
      reset();
      w.classList.add('seek');
      applyUntil(time);
      t = time;
      void w.offsetWidth; // commit the frame without transitions
      w.classList.remove('seek');
      instant = false;
      api.done = time >= total;
      api.onstate();
    };
    api.time = () => t;
    return api;
  }

  // ---- A) Hero: view modes and the terminal grid -----------------------------
  const HERO_SRC = [
    '<span class="h"># Architecture</span>', '',
    'Atlas is a single binary with four parts.', '',
    '<span class="h">## Indexer</span>', '',
    'Walks the folder, parses front matter and',
    'builds a full-text index. Front matter <span class="ic">`tags:`</span>',
    'are indexed as exact-match facets.<span class="caret"></span>', '',
    '<span class="h">## Server</span>', '',
    'Serves rendered pages and the search API.', '',
    '<span class="ic">```</span><span class="kw">mermaid</span>',
    '<span class="kw">flowchart</span> <span class="at">LR</span>',
    '  <span class="at">Files</span>[<span class="st">Markdown files</span>] <span class="mt">--&gt;</span> <span class="at">Indexer</span>',
    '  <span class="at">Indexer</span> <span class="mt">--&gt;</span> <span class="at">Index</span>[(<span class="st">Index</span>)]',
    '  <span class="at">Index</span> <span class="mt">--&gt;</span> <span class="at">Server</span>',
    '<span class="ic">```</span>', '',
    '<span class="h">## Search</span>', '',
    'Queries hit the index first. See',
    '<span class="at">[search.md]</span><span class="mu">(search.md)</span> for ranking.',
  ];
  const FLOW = `<div class="flow">${svg(
    '<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" style="fill:#7d8494;stroke:none"/></marker></defs>' +
    '<rect x="1" y="16" width="118" height="34" rx="5"/><text x="60" y="37">Markdown files</text>' +
    '<path d="M121 33h29" marker-end="url(#ah)"/>' +
    '<rect x="153" y="16" width="78" height="34" rx="5"/><text x="192" y="37">Indexer</text>' +
    '<path d="M233 33h29" marker-end="url(#ah)"/>' +
    '<rect x="265" y="16" width="66" height="34" rx="17"/><text x="298" y="37">Index</text>' +
    '<path d="M333 33h21" marker-end="url(#ah)"/>' +
    '<rect x="357" y="16" width="72" height="34" rx="5"/><text x="393" y="37">Server</text>', '0 0 430 64')}</div>`;
  const prompt = '<span class="ok">~/atlas-docs</span> <span class="yl">(main)</span>';

  const hero = {
    total: 12600,
    html: () => `<div class="dw" data-view="edit" data-term="0" data-panes="1" data-side="files">
      ${titleBar('architecture.md')}
      <div class="bd">
        ${activity(4)}
        <aside class="side"><div class="pane p-files">${filesHead}${tree([
          [0, '.git', 'c'], [0, 'docs', 'd', '', '•m'],
          [1, 'architecture.md', 'f', '', 'M', 'cur'], [1, 'search.md', 'f', '', 'M'],
          [0, 'notes', 'c', '', '•u'], [0, 'src', 'c', '', '•m'],
          [0, 'package-lock.json', 'f', '', 'M'], [0, 'README.md', 'f']])}</div></aside>
        <main class="ctr">
          <div class="pn docpn ed">${editorToolbar}<div class="code">${lines(HERO_SRC, 9)}</div></div>
          <div class="pn docpn pv"><div class="pvi">
            <h1>Architecture</h1><p>Atlas is a single binary with four parts.</p>
            <h2>Indexer</h2><p>Walks the folder, parses front matter and builds a full-text index. Front matter <span class="ic">tags:</span> are indexed as exact-match facets.</p>
            <h2>Server</h2><p>Serves rendered pages and the search API.</p>${FLOW}
            <h2>Search</h2><p>Queries hit the index first. See <a>search.md</a> for ranking.</p></div></div>
          <div class="pn docpn df">${diffHead('architecture.md', 'docs · 3 hunks · +12 −3')}
            <div class="fold">1 formatting-only hunk folded — switch to Full to see it</div>
            ${hunk('## Indexer · line 5', [dl('', '## Indexer'), dl('', ''), dl('d', 'Walks the folder and builds a full-text index.'),
              dl('a', 'Walks the folder, parses front matter and'), dl('a', 'builds a full-text index. Front matter `tags:`'), dl('a', 'are indexed as exact-match facets.')])}
            ${hunk('## Server · line 11', [dl('', '## Server'), dl('', ''), dl('d', 'Serves pages.'), dl('a', 'Serves rendered pages and the search API.'), dl('a', ''),
              dl('a', '```mermaid'), dl('a', 'flowchart LR'), dl('a', '  Files[Markdown files] --&gt; Indexer'), dl('a', '  Indexer --&gt; Index[(Index)]'), dl('a', '  Index --&gt; Server'), dl('a', '```')])}
          </div>
          <div class="drawer">
            ${pane('t1 fo', 'zsh', '~/atlas-docs', `<div class="ln1">${prompt} ❯ <span class="cur-b"></span></div>`)}
            ${pane('t2', 'zsh', '~/atlas-docs', `<div class="ln1">${prompt} ❯ <span class="cur-b"></span></div>`)}
            ${pane('t3', 'zsh', '~/atlas-docs', `<div class="ln1">${prompt} ❯ <span class="cur-b"></span></div>`)}
          </div>
        </main>
      </div>
      ${statusBar('~/atlas-docs/docs/architecture.md', '<span>90 words</span><span>573 chars</span><span>25 lines</span><span>Ln 9, Col 35</span>')}
      ${hud}</div>`,
    script(at) {
      const view = (t, keys, label, v) => {
        at(t, (w) => showKeys(w, keys, label));
        at(t + 220, (w) => { w.dataset.view = v; });
        at(t + 1150, hideKeys);
      };
      // Type a command into a pane, then print its output.
      const run = (t, sel, cmd, out) => {
        const tt = (w) => w.querySelector(sel + ' .tt');
        for (let i = 1; i <= cmd.length; i++) {
          at(t + i * 38, (w) => { tt(w).querySelector('.ln1').innerHTML = prompt + ' ❯ ' + cmd.slice(0, i) + '<span class="cur-b"></span>'; });
        }
        const t2 = t + cmd.length * 38 + 260;
        at(t2, (w) => {
          const p = tt(w);
          p.querySelector('.ln1').innerHTML = prompt + ' ❯ ' + cmd;
          p.querySelector('.ln1').classList.remove('ln1');
          out.forEach((l) => termLine(p, l));
          termLine(p, prompt + ' ❯ <span class="cur-b"></span>');
        });
      };
      const focus = (t, sel) => at(t, (w) => w.querySelectorAll('.tp').forEach((p) => p.classList.toggle('fo', p.matches(sel))));
      view(800, ['⌘', '2'], 'Split', 'split');
      view(2700, ['⌘', '3'], 'Preview', 'preview');
      view(4500, ['⌘', '4'], 'Diff', 'diff');
      view(6500, ['⌘', '2'], 'Split', 'split');
      at(7900, (w) => showKeys(w, ['⌃', '`'], 'Terminal'));
      at(8120, (w) => { w.dataset.term = '1'; w.querySelector('.tbtn').classList.add('on'); });
      at(9050, hideKeys);
      run(8500, '.t1', 'git status -s', [' <span class="rd">M</span> docs/architecture.md', ' <span class="rd">M</span> docs/search.md',
        ' <span class="rd">M</span> package-lock.json', ' <span class="rd">M</span> src/indexer.ts', '<span class="rd">??</span> notes/']);
      at(9500, (w) => showKeys(w, ['⌘', 'D'], 'Split right'));
      at(9720, (w) => { w.dataset.panes = '2'; });
      focus(9720, '.t2');
      at(10600, hideKeys);
      run(9950, '.t2', 'git diff --stat', [' docs/architecture.md | 15 <span class="ok">++++++++++++</span><span class="rd">---</span>',
        ' docs/search.md       |  5 <span class="ok">+++++</span>', ' src/indexer.ts       | 12 <span class="ok">+++++++</span><span class="rd">-----</span>',
        ' 3 files changed, 24 insertions(+), 8 deletions(-)']);
      at(10950, (w) => showKeys(w, ['⌘', '⇧', 'D'], 'Split down'));
      at(11170, (w) => { w.dataset.panes = '3'; });
      focus(11170, '.t3');
      at(12100, hideKeys);
      run(11400, '.t3', 'git log --oneline -2', ['<span class="yl">b17dcae</span> Add sorting helpers', '<span class="yl">ea41f83</span> Initial handbook']);
    },
  };

  // ---- B) The review loop ------------------------------------------------------
  const SEARCH_SRC = [
    '<span class="h"># Search</span>', '',
    'Search runs against the local index. Type',
    'to filter; press Enter to open a result.', '',
    '<span class="h">## Ranking</span>', '',
    'Title matches rank above body matches, and',
    'exact tag matches rank above both.',
  ];
  const SEARCH_ADD = ['', 'Results are cached for 60 seconds per query.', 'The cache key is the query plus the active',
    'filters, so a new tag starts a new search.', 'See <span class="at">notes/cache-decision.md</span> for why.'];
  const FILES = [
    { p: 'docs/search.md', n: 'search.md', d: 'docs', s: 'M', a: 5, r: 0 },
    { p: 'src/indexer.ts', n: 'indexer.ts', d: 'src', s: 'M', a: 7, r: 5 },
    { p: 'notes/cache-decision.md', n: 'cache-decision.md', d: 'notes', s: 'U', a: 4, r: 0 },
  ];
  const STATS = {
    'docs/search.md': ['41 words', '236 chars', '9 lines'],
    'src/indexer.ts': ['214 words', '1,604 chars', '58 lines'],
    'notes/cache-decision.md': ['22 words', '131 chars', '4 lines'],
  };
  const DIFFS = {
    'docs/search.md': (again) => diffHead('search.md', `docs · 1 hunk · +${again ? 6 : 5}`) +
      hunk('## Ranking · line 6', [dl('', 'Title matches rank above body matches, and'), dl('', 'exact tag matches rank above both.'),
        ...SEARCH_ADD.slice(0, 4).map((l) => dl('a', l)),
        ...(again ? [dl('a', 'Rebuilding the index clears the cache.')] : []), dl('a', 'See notes/cache-decision.md for why.')]),
    'src/indexer.ts': () => diffHead('indexer.ts', 'src · 3 hunks · +7 −5') +
      '<div class="fold">1 import-only hunk folded — switch to Full to see it</div>' +
      hunk('export interface Entry { · line 18', [dl('', '  path: string;'), dl('', '  title: string;'), dl('', '  tokens: string[];'),
        dl('a', '  tags: string[];'), dl('', '}'), dl('', ''),
        dl('', 'export async function indexFile(root: string, rel: string) {'),
        dl('', '  const { data, body } = parseFrontMatter(text);'),
        dl('d', '  return { path: rel, title: data.title ?? rel, tokens: tokenize(body) };'),
        dl('a', '  const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];'),
        dl('a', '  return { path: rel, title: data.title ?? rel, tokens: tokenize(body), tags };')]),
    'notes/cache-decision.md': () => diffHead('cache-decision.md', 'notes · new file · +4') +
      hunk('notes/cache-decision.md · line 1', [dl('a', '# Cache search results'), dl('a', ''),
        dl('a', 'Decision: cache each query for 60 s. Rebuilding'), dl('a', 'the index clears it. Revisit if memory grows.')]),
  };
  const agentPrompt = 'Document the search result cache and note the decision.';
  let S; // review state, rebuilt on every reset
  const step = (w, n) => { w.dataset.step = n; w.closest('figure').dispatchEvent(new CustomEvent('demostep', { detail: n })); };

  function renderQueue(w) {
    const pending = FILES.map((_, i) => i).filter((i) => !S.reviewed[i]);
    const done = FILES.map((_, i) => i).filter((i) => S.reviewed[i]);
    [...pending, ...done].forEach((i, pos) => {
      const r = w.querySelector(`.chg[data-i="${i}"]`);
      r.style.transform = `translateY(${pos * 30}px)`;
      r.classList.toggle('in', S.shown[i]);
      r.classList.toggle('done', S.reviewed[i]);
      r.classList.toggle('again', S.again[i]);
      r.classList.toggle('cur', S.cur === i);
      const f = FILES[i];
      r.querySelector('.n').innerHTML = `<span class="p">+${S.cnt[i][0]}</span>${f.r ? ` <span class="q">−${S.cnt[i][1]}</span>` : ''}`;
    });
    const nrev = done.length;
    tick(w.querySelector('.rv .num'), nrev);
    const again = S.again.filter(Boolean).length;
    w.querySelector('.rv small').textContent = again ? `${again} changed again since you reviewed it` : 'Changed since you last looked';
    const segs = w.querySelectorAll('.meter i');
    const curPending = S.cur !== null && !S.reviewed[S.cur];
    segs.forEach((s, k) => { s.className = k < nrev ? 'done' : k === nrev && curPending ? 'now' : ''; });
    w.querySelector('.left').textContent = `${pending.length} left`;
    setBadge(w);
  }
  function setBadge(w) {
    const n = FILES.filter((_, i) => S.changed[i] && !S.reviewed[i]).length;
    const b = w.querySelector('.badge');
    b.classList.toggle('off', n === 0);
    if (b.textContent !== String(n)) {
      b.textContent = n;
      if (n) pop(b, [{ transform: 'scale(1.45)' }, { transform: 'scale(1)' }], { duration: 320 });
    }
  }
  function openDiff(w, i) {
    const f = FILES[i];
    const body = w.querySelector('.df .dfb');
    body.innerHTML = DIFFS[f.p](S.again[i]);
    pop(body, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    w.querySelector('.tabn').textContent = f.n;
    w.querySelector('.sbp').textContent = '~/atlas-docs/' + f.p;
    const st = STATS[f.p];
    w.querySelectorAll('.sbn').forEach((el, k) => { el.textContent = st[k]; });
  }

  const loop = {
    total: 20600,
    reset() { S = { changed: [0, 0, 0], shown: [0, 0, 0], reviewed: [0, 0, 0], again: [0, 0, 0], cur: null, cnt: [[0, 0], [0, 0], [0, 0]] }; },
    html: () => `<div class="dw" data-view="edit" data-side="files" data-panes="1">
      ${titleBar('search.md')}
      <div class="bd">
        ${activity(0)}
        <aside class="side">
          <div class="pane p-files">${filesHead}${tree([
            [0, '.git', 'c'], [0, 'docs', 'd', 'docs'], [1, 'architecture.md', 'f', 'docs/architecture.md'], [1, 'search.md', 'f', 'docs/search.md', '', 'cur'],
            [0, 'notes', 'd', 'notes'], [1, 'cache-decision.md', 'f', 'notes/cache-decision.md', '', 'new'], [1, 'standup.md', 'f', 'notes/standup.md'],
            [0, 'src', 'd', 'src'], [1, 'indexer.ts', 'f', 'src/indexer.ts'], [1, 'server.ts', 'f', 'src/server.ts'],
            [0, 'package-lock.json', 'f', 'package-lock.json'], [0, 'README.md', 'f', 'README.md']])}</div>
          <div class="pane p-chg">
            <div class="sh"><h4>Changes</h4><span class="ib">${IC.refresh}</span></div>
            <div class="rv"><strong><span class="num">0</span><span class="of"> / 3 reviewed</span></strong><small>Changed since you last looked</small>
              <div class="meter"><i></i><i></i><i></i></div>
              <div class="keys"><span><span class="k">↑</span><span class="k">↓</span> move</span><span><span class="k">Space</span> reviewed</span><span><span class="k">↩</span> open</span></div></div>
            <div class="gh">Worth reading <span class="c left">3 left</span></div>
            <div class="list">${FILES.map((f, i) => `<div class="chg" data-i="${i}" style="transform:translateY(${i * 30}px)"><span class="ck">${IC.check}</span><span class="gb ${f.s.toLowerCase()}">${f.s}</span><span class="fl"><b>${f.n}</b><i class="dot"></i><em>${f.d}</em></span><span class="n"></span></div>`).join('')}</div>
            <div class="gh noise">${IC.chev} Probably noise <span class="c">1</span></div>
          </div>
        </aside>
        <main class="ctr">
          <div class="pn docpn ed"><div class="code">${lines(SEARCH_SRC, 0)}</div></div>
          <div class="pn docpn df"><div class="dfb"></div></div>
          <div class="drawer">${pane('t1 fo', 'agent', '~/atlas-docs', '<div class="ln1">› <span class="cur-b"></span></div>')}</div>
        </main>
      </div>
      ${statusBar('~/atlas-docs/docs/search.md', '<span class="sbn">41 words</span><span class="sbn">236 chars</span><span class="sbn">9 lines</span><span>Ln 1, Col 1</span>')}
      ${hud}</div>`,
    script(at) {
      const tt = (w) => w.querySelector('.t1 .tt');
      const row = (w, p) => w.querySelector(`.row[data-p="${p}"]`);
      const flash = (t, p, badge, dir, dirBadge) => {
        at(t, (w) => {
          const r = row(w, p);
          r.classList.add('in', 'flash', 'lit');
          const g = r.querySelector('.gb');
          g.textContent = badge; g.className = 'gb ' + badge.toLowerCase();
          pop(g, [{ transform: 'scale(1.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 300 });
          const dg = dir && row(w, dir).querySelector('.gb');
          if (dg && !dg.textContent) { dg.textContent = '•'; dg.className = 'gb ' + dirBadge; }
        });
        at(t + 350, (w) => row(w, p).classList.remove('flash'));
        at(t + 2600, (w) => row(w, p).classList.remove('lit'));
      };
      const out = (w, html) => { tt(w).querySelector('.cl')?.remove(); return termLine(tt(w), html); };
      const edit = (t, verb, path, counts, i) => {
        at(t, (w) => out(w, `  <span class="dm">${verb}</span> ${path.padEnd(25)} ${counts}`));
        if (i !== undefined) at(t, (w) => { S.changed[i] = 1; setBadge(w); });
      };
      const keys = (t, k, label) => { at(t, (w) => showKeys(w, k, label)); at(t + 1100, hideKeys); };
      const plus = (a, r) => `<span class="ok">+${a}</span>${r ? ` <span class="rd">−${r}</span>` : ''}`;

      // Step 1: the agent works; the tree and the badge follow the disk.
      at(0, (w) => { step(w, 0); });
      for (let i = 1; i <= agentPrompt.length; i++) {
        at(150 + i * 22, (w) => { tt(w).querySelector('.ln1').innerHTML = '› ' + agentPrompt.slice(0, i) + '<span class="cur-b"></span>'; });
      }
      at(1650, (w) => { const l = tt(w).querySelector('.ln1'); l.textContent = '› ' + agentPrompt; l.className = 'dm'; termLine(tt(w), ''); });
      at(1900, (w) => termLine(tt(w), '<span class="ac">●</span> Updating search docs…'));
      edit(2700, 'Edit ', 'docs/search.md', plus(5), 0);
      flash(2700, 'docs/search.md', 'M', 'docs', 'm');
      at(2750, (w) => {
        const code = w.querySelector('.ed .code');
        SEARCH_ADD.forEach((h, k) => {
          const d = document.createElement('div');
          d.className = 'ln' + (instant ? '' : ' ins');
          d.innerHTML = `<span class="g">${10 + k}</span><span>${h}</span>`;
          if (!instant) d.style.animationDelay = k * 60 + 'ms';
          code.appendChild(d);
        });
      });
      for (let k = 1; k <= 6; k++) at(2750 + k * 60, (w) => {
        const [a, b, c] = w.querySelectorAll('.sbn');
        a.textContent = 41 + Math.round(33 * k / 6) + ' words';
        b.textContent = 236 + Math.round(197 * k / 6) + ' chars';
        c.textContent = (k < 6 ? 9 + Math.round(5 * k / 6) : 14) + ' lines';
      });
      edit(4100, 'Edit ', 'src/indexer.ts', plus(7, 5), 1);
      flash(4100, 'src/indexer.ts', 'M', 'src', 'm');
      edit(5500, 'Write', 'notes/cache-decision.md', plus(4), 2);
      flash(5500, 'notes/cache-decision.md', 'U', 'notes', 'u');
      edit(6900, 'Edit ', 'package-lock.json', plus(3, 1));
      flash(6900, 'package-lock.json', 'M');
      at(7700, (w) => termLine(tt(w), '<span class="ac">●</span> Done. 4 files changed.'));
      at(7750, (w) => { out(w, '› <span class="cur-b"></span>').classList.add('cl'); });

      // Step 2: the Changes view, counts filling in.
      at(8500, (w) => step(w, 1));
      keys(8600, ['⌘', '⇧', 'G'], 'Changes');
      at(8820, (w) => { w.dataset.side = 'changes'; w.dataset.view = 'diff'; S.cur = 0; openDiff(w, 0); renderQueue(w); });
      FILES.forEach((f, i) => {
        const t0 = 9100 + i * 300;
        at(t0, (w) => { S.shown[i] = 1; renderQueue(w); });
        const steps = 8;
        for (let k = 1; k <= steps; k++) at(t0 + k * 55, (w) => {
          S.cnt[i] = [Math.round(f.a * k / steps), Math.round(f.r * k / steps)];
          renderQueue(w);
        });
      });
      at(10200, (w) => w.querySelector('.noise').classList.add('in'));

      // Step 3: mark reviewed with Space, move with ↓, and the agent edits again.
      at(11000, (w) => step(w, 2));
      keys(11100, ['Space'], 'Mark reviewed');
      at(11350, (w) => { S.reviewed[0] = 1; S.cur = 1; renderQueue(w); });
      at(11750, (w) => openDiff(w, 1));
      keys(12900, ['↓'], 'Next file');
      at(13150, (w) => { S.cur = 2; renderQueue(w); openDiff(w, 2); });
      keys(14400, ['Space'], 'Mark reviewed');
      at(14650, (w) => { S.reviewed[2] = 1; S.cur = 1; renderQueue(w); });
      at(15050, (w) => openDiff(w, 1));
      at(16200, (w) => out(w, '<span class="ac">●</span> One more line on cache invalidation.'));
      edit(16900, 'Edit ', 'docs/search.md', plus(1));
      at(17000, (w) => {
        S.reviewed[0] = 0; S.again[0] = 1; S.cnt[0] = [6, 0]; renderQueue(w);
        const r = w.querySelector('.chg[data-i="0"]');
        pop(r, [{ background: 'rgba(216,200,154,.16)' }, { background: 'transparent' }], { duration: 1200, easing: 'ease-out' });
      });
      at(17100, (w) => { out(w, '› <span class="cur-b"></span>').classList.add('cl'); });
    },
  };

  // ---- Mount ---------------------------------------------------------------------
  function mount(name, def) {
    const root = document.querySelector(`.demo[data-demo="${name}"]`);
    if (!root) return null;
    const fig = root.closest('figure');
    const btn = fig.querySelector('.demo-btn');
    const tl = Timeline(root, def);
    const fit = () => root.style.setProperty('--s', root.clientWidth / 1280);
    fit();
    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(root); else addEventListener('resize', fit);

    const ICONS = {
      pause: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3" width="3" height="10" rx=".8"/><rect x="9.5" y="3" width="3" height="10" rx=".8"/></svg>',
      play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
      replay: '<svg viewBox="0 0 16 16" style="fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3"/></svg>',
    };
    let userPaused = false, visible = false, gate = Promise.resolve();
    tl.onstate = () => {
      const mode = tl.playing() ? 'pause' : tl.done ? 'replay' : 'play';
      const label = { pause: 'Pause', play: 'Play', replay: 'Replay' }[mode];
      btn.innerHTML = ICONS[mode] + '<span>' + label + '</span>';
      btn.setAttribute('aria-label', label + ' the animation');
      fig.classList.toggle('playing', tl.playing());
      fig.dispatchEvent(new CustomEvent('demostate'));
    };
    btn.addEventListener('click', () => {
      if (tl.playing()) { userPaused = true; tl.pause(); } else { userPaused = false; tl.play(); }
    });

    const pinned = params.get('demo') === name && params.has('t');
    if (pinned) {
      tl.seek(Math.max(0, +params.get('t') || 0));
      return tl;
    }
    if (reduced) { tl.seek(tl.total); return tl; }
    tl.seek(0);
    let started = false;
    const go = () => gate.then(() => {
      if (!visible || userPaused || tl.done) return;
      started = true;
      tl.play();
    });
    if (def.delay) gate = new Promise((r) => setTimeout(r, Math.max(0, def.delay - performance.now())));
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) go(); else if (started) tl.pause();
    }, { threshold: 0.4 }).observe(root);
    return tl;
  }

  hero.delay = 2400; // after the headline diff has written in
  mount('hero', hero);
  const lt = mount('loop', loop);

  // Keep the numbered steps in sync with the review demo.
  const steps = document.querySelector('ol.steps');
  const fig = document.querySelector('.demo[data-demo="loop"]')?.closest('figure');
  if (steps && fig && lt) {
    const items = steps.querySelectorAll('li');
    const mark = (n) => items.forEach((li, i) => li.classList.toggle('on', i === n));
    fig.addEventListener('demostep', (e) => mark(e.detail));
    const sync = () => {
      // Dim the other steps only while the story runs or is held mid-way.
      const live = !lt.done && (lt.playing() || lt.time() > 0);
      steps.classList.toggle('live', live);
      mark(live && lt.w.dataset.step ? +lt.w.dataset.step : -1);
    };
    fig.addEventListener('demostate', sync);
    sync();
  }
})();
