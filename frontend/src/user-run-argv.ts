/**
 * Split and join a typed command line the same way the Rust runner does.
 * Whitespace separates arguments; single quotes are literal; in double
 * quotes, `\\` and `\"` are escapes and any other backslash is kept (so
 * Windows paths stay intact). There is no shell expansion.
 */

export function splitCommandLine(input: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let started = false;
  const chars = [...input];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false;
      } else if (c === '\\') {
        const next = chars[i + 1];
        if (next === '"' || next === '\\') {
          cur += next;
          i++;
        } else if (next !== undefined) {
          cur += '\\' + next;
          i++;
        } else {
          cur += '\\';
        }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === "'") {
      started = true;
      inSingle = true;
    } else if (c === '"') {
      started = true;
      inDouble = true;
    } else if (/\s/.test(c)) {
      if (started) {
        args.push(cur);
        cur = '';
        started = false;
      }
    } else {
      started = true;
      cur += c;
    }
  }
  if (inSingle || inDouble) {
    throw new Error('unclosed quote');
  }
  if (started) args.push(cur);
  if (args.length === 0) throw new Error('empty command');
  return args;
}

/** Quote argv for a text field (not for a shell). */
export function joinCommandLine(argv: string[]): string {
  return argv.map(quoteArg).join(' ');
}

function quoteArg(a: string): string {
  if (a === '') return '""';
  if (!/[\s"'\\]/.test(a)) return a;
  return `"${a.replace(/["\\]/g, (ch) => `\\${ch}`)}"`;
}

/** Parse a typed line into argv, or null when it is empty or unclosed. */
export function trySplitCommandLine(input: string): string[] | null {
  try {
    return splitCommandLine(input);
  } catch {
    return null;
  }
}
