import { describe, expect, it } from 'vitest';
import { joinCommandLine, splitCommandLine, trySplitCommandLine } from '../user-run-argv';

describe('splitCommandLine', () => {
  it('splits on whitespace and keeps quoted groups', () => {
    expect(splitCommandLine('prettier --write .')).toEqual(['prettier', '--write', '.']);
    expect(splitCommandLine(`pretty "hello world" 'a b'`)).toEqual(['pretty', 'hello world', 'a b']);
    expect(splitCommandLine('  prettier   --write  ')).toEqual(['prettier', '--write']);
  });

  it('keeps Windows paths inside double quotes', () => {
    expect(splitCommandLine(String.raw`"C:\Program Files\app.exe" --flag`)).toEqual([
      String.raw`C:\Program Files\app.exe`,
      '--flag',
    ]);
  });

  it('treats a semicolon as an argument, not a shell separator', () => {
    expect(splitCommandLine('echo hello; echo other')).toEqual(['echo', 'hello;', 'echo', 'other']);
  });

  it('unescapes \\" and \\\\ inside double quotes', () => {
    expect(splitCommandLine(String.raw`say "say \"hi\""`)).toEqual(['say', 'say "hi"']);
  });

  it('rejects empty lines and unclosed quotes', () => {
    expect(trySplitCommandLine('')).toBeNull();
    expect(trySplitCommandLine('   ')).toBeNull();
    expect(trySplitCommandLine('"open')).toBeNull();
    expect(() => splitCommandLine('')).toThrow(/empty command/);
    expect(() => splitCommandLine('"open')).toThrow(/unclosed quote/);
  });

  it('round-trips through joinCommandLine', () => {
    const argv = ['prettier', '--write', 'hello world', String.raw`C:\Program Files\app.exe`];
    expect(splitCommandLine(joinCommandLine(argv))).toEqual(argv);
  });
});
