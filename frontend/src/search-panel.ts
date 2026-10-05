import { EditorView, type Panel } from '@codemirror/view';
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
} from '@codemirror/search';

/**
 * VS Code / Kiro-style floating search widget. Sits in the top-right of the
 * editor, sized to its own content (not full width). Opens search-only; a
 * chevron on the left expands the replace row. Match toggles (case, word,
 * regex) live inside each input; an "N of M" counter sits between the field
 * and the nav buttons.
 */
export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'sd-find';

  // Chevron toggles the replace row (collapsed by default).
  const chevron = document.createElement('button');
  chevron.className = 'sd-find-chevron';
  chevron.type = 'button';
  chevron.title = 'Toggle Replace';
  chevron.innerHTML = svgChevronRight();

  const fields = document.createElement('div');
  fields.className = 'sd-find-fields';

  // --- Find row ------------------------------------------------------------
  const findRow = document.createElement('div');
  findRow.className = 'sd-find-row';

  const findWrap = inputWrap('Find');
  const findInput = findWrap.input;
  const caseBtn = miniToggle('Aa', 'Match case');
  const wordBtn = miniToggle('ab', 'Match whole word');
  wordBtn.classList.add('sd-find-mini-word');
  const regexBtn = miniToggle('.*', 'Use regular expression');
  findWrap.tools.append(caseBtn, wordBtn, regexBtn);

  const count = document.createElement('span');
  count.className = 'sd-find-count';

  const prevBtn = iconBtn('Previous (⇧⏎)', svgArrowUp());
  const nextBtn = iconBtn('Next (⏎)', svgArrowDown());
  const closeBtn = iconBtn('Close (Esc)', svgClose());

  findRow.append(findWrap.el, count, prevBtn, nextBtn, closeBtn);

  // --- Replace row (hidden until expanded) ---------------------------------
  const replaceRow = document.createElement('div');
  replaceRow.className = 'sd-find-row sd-find-replace';
  const replaceWrap = inputWrap('Replace');
  const replaceInput = replaceWrap.input;
  const replaceBtn = iconBtn('Replace (⏎)', svgReplace());
  const replaceAllBtn = iconBtn('Replace all', svgReplaceAll());
  replaceRow.append(replaceWrap.el, replaceBtn, replaceAllBtn);

  fields.append(findRow, replaceRow);
  dom.append(chevron, fields);

  // --- State ---------------------------------------------------------------
  let caseSensitive = false;
  let wholeWord = false;
  let regexp = false;
  let expanded = false;

  const setExpanded = (v: boolean) => {
    expanded = v;
    dom.classList.toggle('expanded', expanded);
    chevron.innerHTML = expanded ? svgChevronDown() : svgChevronRight();
  };

  const commit = () => {
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({
        search: findInput.value,
        replace: replaceInput.value,
        caseSensitive,
        wholeWord,
        regexp,
      })),
    });
    updateCount();
  };

  const updateCount = () => {
    const q = getSearchQuery(view.state);
    if (!q.search || !q.valid) { count.textContent = ''; count.classList.remove('sd-find-noresults'); return; }
    const matches: { from: number; to: number }[] = [];
    try {
      const cursor = q.getCursor(view.state.doc);
      let r = cursor.next();
      while (!r.done) { matches.push({ from: r.value.from, to: r.value.to }); r = cursor.next(); }
    } catch { count.textContent = ''; return; }

    if (matches.length === 0) {
      count.textContent = 'No results';
      count.classList.add('sd-find-noresults');
      return;
    }
    count.classList.remove('sd-find-noresults');
    // Which match is currently selected?
    const sel = view.state.selection.main;
    let idx = matches.findIndex((m) => m.from === sel.from && m.to === sel.to);
    if (idx === -1) idx = matches.findIndex((m) => m.from >= sel.from);
    const human = idx === -1 ? 1 : idx + 1;
    count.textContent = `${human} of ${matches.length}`;
  };

  // --- Wiring --------------------------------------------------------------
  chevron.onclick = () => { setExpanded(!expanded); if (expanded) replaceInput.focus(); };

  findInput.addEventListener('input', commit);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? findPrevious(view) : findNext(view); updateCount(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); view.focus(); }
  });
  replaceInput.addEventListener('input', commit);
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceNext(view); updateCount(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); view.focus(); }
  });

  prevBtn.onclick = () => { findPrevious(view); updateCount(); };
  nextBtn.onclick = () => { findNext(view); updateCount(); };
  closeBtn.onclick = () => { closeSearchPanel(view); view.focus(); };
  replaceBtn.onclick = () => { replaceNext(view); updateCount(); };
  replaceAllBtn.onclick = () => { replaceAll(view); updateCount(); };

  const toggle = (btn: HTMLElement, get: () => boolean, set: (v: boolean) => void) => {
    btn.addEventListener('click', () => { set(!get()); btn.classList.toggle('active', get()); commit(); findInput.focus(); });
  };
  toggle(caseBtn, () => caseSensitive, (v) => caseSensitive = v);
  toggle(wordBtn, () => wholeWord, (v) => wholeWord = v);
  toggle(regexBtn, () => regexp, (v) => regexp = v);

  return {
    dom,
    top: false,
    mount() {
      const q = getSearchQuery(view.state);
      if (q.search) findInput.value = q.search;
      caseSensitive = q.caseSensitive; caseBtn.classList.toggle('active', caseSensitive);
      wholeWord = q.wholeWord; wordBtn.classList.toggle('active', wholeWord);
      regexp = q.regexp; regexBtn.classList.toggle('active', regexp);
      setExpanded(false);
      updateCount();
      findInput.focus();
      findInput.select();
    },
  };
}

// --- DOM helpers -----------------------------------------------------------
function inputWrap(placeholder: string): { el: HTMLElement; input: HTMLInputElement; tools: HTMLElement } {
  const el = document.createElement('div');
  el.className = 'sd-find-inputwrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.className = 'sd-find-input';
  input.setAttribute('autocomplete', 'off');
  input.spellcheck = false;
  const tools = document.createElement('div');
  tools.className = 'sd-find-intools';
  el.append(input, tools);
  return { el, input, tools };
}
function miniToggle(label: string, title: string, isSvg = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sd-find-mini';
  b.title = title;
  b.type = 'button';
  if (isSvg) b.innerHTML = label; else b.textContent = label;
  return b;
}
function iconBtn(title: string, svg: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sd-find-icon';
  b.title = title;
  b.innerHTML = svg;
  b.type = 'button';
  return b;
}

const svgChevronRight = () => '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const svgChevronDown = () => '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const svgArrowUp = () => '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>';
const svgArrowDown = () => '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/></svg>';
const svgClose = () => '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const svgReplace = () => '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h5v5"/><path d="M19 4l-7 7"/><rect x="4" y="13" width="7" height="7" rx="1"/></svg>';
const svgReplaceAll = () => '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3h5v5"/><path d="M18 3l-6 6"/><rect x="3" y="11" width="6" height="6" rx="1"/><path d="M13 14h5v5"/><path d="M18 14l-5 5"/></svg>';
