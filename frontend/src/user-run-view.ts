/**
 * Read a user-run view from the backend into the shape the palette and
 * Settings use. Anything that is not the expected shape is left out and
 * named in `problems`, so a missing or odd field can never reach render
 * code (a hook without `globs` once kept Settings from opening).
 */

import type { SaveHook, UserCommand, UserRunView } from './api';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function timeout(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return v;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function entryName(v: Obj, kind: string, i: number): string | string[] {
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  return name ? name : [`${kind} ${i + 1} has no name; it was skipped.`];
}

function command(v: unknown, i: number): UserCommand | string {
  if (!isObj(v)) return `Command ${i + 1} is not an object; it was skipped.`;
  const name = entryName(v, 'Command', i);
  if (Array.isArray(name)) return name[0]!;
  if (!isStrList(v.argv) || v.argv.length === 0 || !v.argv[0]!.trim()) {
    return `Command "${name}" has an argv that is not a list of strings; it was skipped.`;
  }
  const t = timeout(v.timeout_ms);
  return t === undefined && v.timeout_ms !== undefined
    ? `Command "${name}" has a timeout_ms that is not a positive whole number; it was skipped.`
    : { name, argv: [...v.argv], timeout_ms: t ?? null };
}

function hook(v: unknown, i: number): SaveHook | string {
  if (!isObj(v)) return `On-save hook ${i + 1} is not an object; it was skipped.`;
  const name = entryName(v, 'On-save hook', i);
  if (Array.isArray(name)) return name[0]!;
  if (!isStrList(v.argv) || v.argv.length === 0 || !v.argv[0]!.trim()) {
    return `On-save hook "${name}" has an argv that is not a list of strings; it was skipped.`;
  }
  // Missing or null globs = every file (same as the backend).
  const globs = v.globs === undefined || v.globs === null ? [] : v.globs;
  if (!isStrList(globs)) {
    return `On-save hook "${name}" has a globs value that is not a list of patterns; it was skipped.`;
  }
  if (v.enabled !== undefined && v.enabled !== null && typeof v.enabled !== 'boolean') {
    return `On-save hook "${name}" has an enabled value that is not true or false; it was skipped.`;
  }
  const t = timeout(v.timeout_ms);
  if (t === undefined && v.timeout_ms !== undefined) {
    return `On-save hook "${name}" has a timeout_ms that is not a positive whole number; it was skipped.`;
  }
  return { name, argv: [...v.argv], globs: [...globs], enabled: v.enabled === true, timeout_ms: t ?? null };
}

function list<T>(raw: unknown, key: string, parse: (v: unknown, i: number) => T | string, problems: string[]): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push(`"${key}" in the loaded user-run view was not a list; it was ignored.`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((v, i) => {
    const parsed = parse(v, i);
    if (typeof parsed === 'string') problems.push(parsed);
    else out.push(parsed);
  });
  return out;
}

/** Parse what `load_user_run` / `save_user_run` returned. Never throws. */
export function parseUserRunView(raw: unknown): UserRunView {
  const v: Obj = isObj(raw) ? raw : {};
  const problems: string[] = Array.isArray(v.problems) ? v.problems.map((p) => String(p)) : [];
  if (!isObj(raw)) problems.push('The user-run view could not be read.');
  const commands = list(v.commands, 'commands', command, problems);
  const save_hooks = list(v.save_hooks, 'save_hooks', hook, problems);
  return {
    commands,
    save_hooks,
    problems,
    file_error: typeof v.file_error === 'string' && v.file_error ? v.file_error : null,
    path: typeof v.path === 'string' ? v.path : '',
  };
}
