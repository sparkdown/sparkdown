// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { agentLaunchCommand, psq, tomlLiteral, type LaunchContext } from '../terminal';
import fixture from '../../../src-tauri/tests-fixtures/windows-launch-cases.json';

/**
 * Agent chip launch lines for local Windows terminals (PowerShell). The
 * shared fixture is also RUN on windows-latest by terminal.rs
 * `windows_smoke_agent_launch_lines_arrive_intact` (pwsh 7 and Windows
 * PowerShell 5.1, npm-style shims), which checks what the agent received.
 */

type Case = (typeof fixture.cases)[number];
const ctxOf = (c: Case): LaunchContext => ({
  ...(c.ctx as LaunchContext),
  shell: 'powershell',
});

describe('PowerShell launch lines (shared Windows fixture)', () => {
  it('agentLaunchCommand produces each fixture launch line', async () => {
    const lines = fixture.cases.map((c) => agentLaunchCommand(c.bin, ctxOf(c)));
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
      ?.env;
    if (env?.UPDATE_WIN_FIXTURE) {
      // Typed loosely: the frontend tsconfig has no Node types.
      const fs: { readFileSync(p: URL, e: string): string; writeFileSync(p: URL, d: string): void } =
        await import('node:fs' as string);
      const url = new URL('../../../src-tauri/tests-fixtures/windows-launch-cases.json', import.meta.url);
      const data = JSON.parse(fs.readFileSync(url, 'utf8'));
      data.cases.forEach((c: { launch: string }, i: number) => (c.launch = lines[i]));
      fs.writeFileSync(url, JSON.stringify(data, null, 2) + '\n');
      return;
    }
    fixture.cases.forEach((c, i) => expect(lines[i], c.name).toBe(c.launch));
  });

  it('no native-command argument carries a double quote', () => {
    // 5.1 (and 7.3+ for .cmd shims) would strip it; only the opencode env
    // assignment may hold JSON, and that is not a command-line argument.
    for (const c of fixture.cases) {
      const line = agentLaunchCommand(c.bin, ctxOf(c));
      const args = line.startsWith('$env:') ? line.slice(line.indexOf('; try {')) : line;
      expect(args, c.name).not.toContain('"');
      for (const a of c.argv) expect(a, c.name).not.toContain('"');
    }
  });
});

describe('psq (PowerShell single quotes)', () => {
  it('doubles ASCII and typographic single quotes; nothing else changes', () => {
    expect(psq('plain')).toBe("'plain'");
    expect(psq("O'Brien")).toBe("'O''Brien'");
    expect(psq('O\u2019Brien \u2018x\u201A\u201B')).toBe(
      "'O\u2019\u2019Brien \u2018\u2018x\u201A\u201A\u201B\u201B'",
    );
    // $, backtick and " are literal inside '…'.
    expect(psq('$env:X `n "q" C:\\a\\')).toBe('\'$env:X `n "q" C:\\a\\\'');
  });
});

describe('tomlLiteral', () => {
  it('literal strings keep Windows backslashes; apostrophes use the multi-line form', () => {
    expect(tomlLiteral('C:\\Program Files\\sd.exe')).toBe("'C:\\Program Files\\sd.exe'");
    expect(tomlLiteral("C:\\Users\\O'Brien\\sd.exe")).toBe("'''C:\\Users\\O'Brien\\sd.exe'''");
    expect(tomlLiteral("a'''b")).toBeNull();
    expect(tomlLiteral("ends'")).toBeNull();
    expect(tomlLiteral('new\nline')).toBeNull();
  });

  it('a path TOML cannot hold falls back to the teaching prompt, never a broken -c', () => {
    const cmd = agentLaunchCommand('codex', {
      shim: { program: "C:\\a'''b\\sd.exe", args: ['--mcp-stdio'] },
      installed: false,
      shell: 'powershell',
    });
    expect(cmd).toMatch(/^codex 'Read the file \$SPARKDOWN_CONTEXT/);
  });
});

describe('PowerShell launch: fallbacks and POSIX parity', () => {
  const WIN = { program: 'C:\\SparkDown\\sparkdown.exe', args: ['--mcp-stdio'] };

  it('claude without a session config file → teaching prompt (no inline JSON)', () => {
    const cmd = agentLaunchCommand('claude', { shim: WIN, installed: false, shell: 'powershell' });
    expect(cmd).toMatch(/^claude 'Read the file/);
    expect(cmd).not.toContain('--mcp-config');
  });

  it('the teaching prompt is the POSIX one minus its double quotes', () => {
    const posix = agentLaunchCommand('gemini', { shim: null, installed: false });
    const ps = agentLaunchCommand('gemini', { shim: null, installed: false, shell: 'powershell' });
    expect(ps).toBe(posix.replace(/"/g, ''));
  });

  it('installed agents: the bare command, Codex keeps its env_vars override', () => {
    const ctx = { shim: WIN, installed: true, shell: 'powershell' as const };
    expect(agentLaunchCommand('grok', ctx)).toBe('grok');
    expect(agentLaunchCommand('codex', ctx)).toBe(
      "codex -c 'mcp_servers.sparkdown.env_vars=[''SPARKDOWN_MCP'']'",
    );
  });

  it('opencode: the variable is set for the run and removed after it', () => {
    const cmd = agentLaunchCommand('opencode', { shim: WIN, installed: false, shell: 'powershell' });
    const m = /^\$env:OPENCODE_CONFIG_CONTENT = '(.*)'; try \{ opencode \} finally \{ Remove-Item Env:OPENCODE_CONFIG_CONTENT -ErrorAction SilentlyContinue \}$/.exec(
      cmd,
    );
    expect(m, cmd).not.toBeNull();
    expect(JSON.parse(m![1].replace(/''/g, "'")).mcp.sparkdown.command).toEqual([
      'C:\\SparkDown\\sparkdown.exe',
      '--mcp-stdio',
    ]);
  });

  it('remote from Windows keeps POSIX syntax (shell "posix" = the default)', () => {
    const remote = { program: '/home/u/.cache/sparkdown/mcp-shim', args: [] };
    const posix = agentLaunchCommand('codex', { shim: remote, installed: false, shell: 'posix' });
    expect(posix).toBe(agentLaunchCommand('codex', { shim: remote, installed: false }));
    expect(posix).toBe(
      `codex -c 'mcp_servers.sparkdown.command="/home/u/.cache/sparkdown/mcp-shim"' -c 'mcp_servers.sparkdown.args=[]' -c 'mcp_servers.sparkdown.env_vars=["SPARKDOWN_MCP"]'`,
    );
    // Even with a configFile present, POSIX Claude keeps the inline JSON.
    expect(
      agentLaunchCommand('claude', {
        shim: { ...remote, configFile: 'C:\\t\\c.json' },
        installed: false,
        shell: 'posix',
      }),
    ).toContain(`--mcp-config '{"mcpServers"`);
  });
});
