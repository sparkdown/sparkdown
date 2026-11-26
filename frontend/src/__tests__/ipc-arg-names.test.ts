import { describe, it, expect } from 'vitest';

// Tauri matches command arguments by their camelCase name (`old_path` in Rust
// is `oldPath` in the invoke payload). A snake_case key is not an error: the
// argument is simply missing, and an Option argument silently becomes None.
// This test reads every #[tauri::command] signature and every invoke() call
// and checks that each top-level payload key names a real argument.
// Typed loosely: the frontend tsconfig has no Node types.
const fs = (await import('node:fs' as string)) as {
  readFileSync(p: string, enc: 'utf8'): string;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
};
const fromHere = (rel: string) => decodeURIComponent(new URL(rel, import.meta.url).pathname);

function walk(dir: string, ext: string, skip: (name: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p, ext, skip));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Text from `open` (an opening bracket) to its matching close, exclusive. */
function balanced(src: string, open: number): string {
  const o = src[open];
  const c = o === '(' ? ')' : o === '{' ? '}' : '>';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Split on commas that are not nested in brackets. */
function topLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const camel = (s: string) =>
  s.replace(/^_+/, '').replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
// Arguments Tauri fills in itself; they are not part of the payload.
const INJECTED = /^(tauri::)?(WebviewWindow|Window|AppHandle|Webview)\b|^(tauri::)?State</;

function rustCommands(): Map<string, Set<string>> {
  const cmds = new Map<string, Set<string>>();
  for (const file of walk(fromHere('../../../src-tauri/src'), '.rs')) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /#\[tauri::command\][\s\S]*?\bfn\s+([a-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const params = topLevel(balanced(src, m.index + m[0].length - 1));
      const names = new Set<string>();
      for (const p of params) {
        const pm = /^(?:mut\s+)?([a-z0-9_]+)\s*:\s*(.+)$/s.exec(p);
        if (pm && !INJECTED.test(pm[2].trim())) names.add(camel(pm[1]));
      }
      cmds.set(m[1], names);
    }
  }
  return cmds;
}

type Call = { file: string; cmd: string; keys: string[] };

function invokeCalls(): Call[] {
  const calls: Call[] = [];
  const files = walk(fromHere('..'), '.ts', (n) => n === '__tests__');
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /\binvoke(?:<[^>]*>)?\(\s*["']([a-z0-9_]+)["']\s*(,\s*\{)?/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (!m[2]) {
        calls.push({ file, cmd: m[1], keys: [] });
        continue;
      }
      const body = balanced(src, m.index + m[0].length - 1);
      const keys = topLevel(body)
        .filter((p) => !p.startsWith('...'))
        .map((p) => /^([A-Za-z0-9_$]+)/.exec(p)?.[1] ?? p);
      calls.push({ file, cmd: m[1], keys });
    }
  }
  return calls;
}

describe('invoke payloads match the Rust command arguments', () => {
  const cmds = rustCommands();
  const calls = invokeCalls();

  it('finds the commands and the calls', () => {
    expect(cmds.size).toBeGreaterThan(50);
    expect(calls.length).toBeGreaterThan(50);
    expect(cmds.get('git_stage_hunk')).toEqual(
      new Set(['root', 'path', 'untracked', 'oldPath', 'side', 'hunkHeader', 'fingerprint']),
    );
  });

  it('every payload key is a camelCase argument of its command', () => {
    const wrong: string[] = [];
    for (const c of calls) {
      const args = cmds.get(c.cmd);
      if (!args) continue; // plugin commands (e.g. plugin:...) are not in src-tauri
      for (const k of c.keys) {
        if (!args.has(k)) wrong.push(`${c.cmd}: "${k}" (expected one of ${[...args].join(', ') || 'none'})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('stage and file-layer calls send the hunk header and the old path', () => {
    const byCmd = (cmd: string) => calls.filter((c) => c.cmd === cmd).flatMap((c) => c.keys);
    expect(byCmd('git_stage_hunk')).toEqual(expect.arrayContaining(['hunkHeader', 'oldPath']));
    expect(byCmd('git_file_layers')).toEqual(expect.arrayContaining(['oldPath']));
  });
});
