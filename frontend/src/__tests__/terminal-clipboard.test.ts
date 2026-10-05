import { describe, it, expect } from 'vitest';
import { clipboardAction, agentLaunchCommand } from '../terminal';

/** Build a minimal KeyboardEvent-like object for clipboardAction. */
function key(k: string, mods: Partial<KeyboardEvent> = {}, type = 'keydown'): KeyboardEvent {
  return {
    key: k,
    type,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  } as KeyboardEvent;
}

const SHIM = { program: '/Applications/SparkDown.app/Contents/MacOS/sparkdown', args: ['--mcp-stdio'] };

describe('agentLaunchCommand', () => {
  it('injects our stdio server additively for Claude Code, with no prompt', () => {
    const cmd = agentLaunchCommand('claude', { shim: SHIM, installed: false });
    expect(cmd).toBe(
      `claude --mcp-config '{"mcpServers":{"sparkdown":{"command":"${SHIM.program}","args":["--mcp-stdio"]}}}'`,
    );
    expect(cmd).not.toContain('--strict-mcp-config');
    expect(cmd).not.toContain('SPARKDOWN_CONTEXT');
  });

  it('injects three config overrides for Codex (forwarding SPARKDOWN_MCP), with no prompt', () => {
    const cmd = agentLaunchCommand('codex', { shim: SHIM, installed: false });
    expect(cmd).toBe(
      `codex -c 'mcp_servers.sparkdown.command="${SHIM.program}"' -c 'mcp_servers.sparkdown.args=["--mcp-stdio"]' -c 'mcp_servers.sparkdown.env_vars=["SPARKDOWN_MCP"]'`,
    );
    expect(cmd).not.toContain('SPARKDOWN_CONTEXT');
    expect(agentLaunchCommand('codex', { shim: SHIM, installed: false, extraArgs: '--model gpt-5' })).toMatch(
      /env_vars=\["SPARKDOWN_MCP"\]' --model gpt-5$/,
    );
  });

  it('Codex installed: still forwards SPARKDOWN_MCP (Codex strips the server env)', () => {
    expect(agentLaunchCommand('codex', { shim: SHIM, installed: true })).toBe(
      `codex -c 'mcp_servers.sparkdown.env_vars=["SPARKDOWN_MCP"]'`,
    );
    expect(agentLaunchCommand('codex', { shim: SHIM, installed: true, extraArgs: '--yolo' })).toBe(
      `codex -c 'mcp_servers.sparkdown.env_vars=["SPARKDOWN_MCP"]' --yolo`,
    );
    // No server at all (unreachable, not installed): no half entry, just the prompt.
    const fallback = agentLaunchCommand('codex', { shim: null, installed: false });
    expect(fallback).toMatch(/^codex 'Read the file/);
    expect(fallback).not.toContain('env_vars');
  });

  it('Codex on a remote host: the remote shim script, same env forward', () => {
    const remote = { program: '/home/u/.cache/sparkdown/mcp-shim', args: [] };
    expect(agentLaunchCommand('codex', { shim: remote, installed: false })).toBe(
      `codex -c 'mcp_servers.sparkdown.command="/home/u/.cache/sparkdown/mcp-shim"' -c 'mcp_servers.sparkdown.args=[]' -c 'mcp_servers.sparkdown.env_vars=["SPARKDOWN_MCP"]'`,
    );
  });

  it('quotes a shim path with an apostrophe safely', () => {
    const odd = { program: "/Users/o'neil/SparkDown", args: ['--mcp-stdio'] };
    expect(agentLaunchCommand('codex', { shim: odd, installed: false })).toContain(
      `-c 'mcp_servers.sparkdown.command="/Users/o'\\''neil/SparkDown"'`,
    );
  });

  it('injects inline config for opencode that merges with the user config', () => {
    const cmd = agentLaunchCommand('opencode', { shim: SHIM, installed: false });
    const m = /^OPENCODE_CONFIG_CONTENT='(.*)' opencode$/.exec(cmd);
    expect(m, cmd).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual({
      mcp: {
        sparkdown: {
          type: 'local',
          command: [SHIM.program, '--mcp-stdio'],
          enabled: true,
          environment: { SPARKDOWN_MCP: '{env:SPARKDOWN_MCP}' },
        },
      },
    });
    expect(agentLaunchCommand('opencode', { shim: SHIM, installed: false, extraArgs: '--model x/y' })).toMatch(
      /' opencode --model x\/y$/,
    );
    // Remote shim script takes no args; no server → teaching prompt.
    const remote = agentLaunchCommand('opencode', {
      shim: { program: '/home/u/.cache/sparkdown/mcp-shim', args: [] },
      installed: false,
    });
    expect(remote).toContain('"command":["/home/u/.cache/sparkdown/mcp-shim"]');
    expect(agentLaunchCommand('opencode', { shim: null, installed: false })).toMatch(
      /^opencode 'Read the file/,
    );
  });

  it('opencode inline config survives an apostrophe in the shim path', () => {
    const cmd = agentLaunchCommand('opencode', {
      shim: { program: "/Users/o'neil/sd", args: ['--mcp-stdio'] },
      installed: false,
    });
    expect(cmd).toContain(`"command":["/Users/o'\\''neil/sd","--mcp-stdio"]`);
  });

  it('launches a bare command when the agent is already installed', () => {
    expect(agentLaunchCommand('grok', { shim: SHIM, installed: true })).toBe('grok');
    expect(agentLaunchCommand('kiro-cli', { shim: SHIM, installed: true })).toBe('kiro-cli');
    // Even claude: no need to inject when it is installed.
    expect(agentLaunchCommand('claude', { shim: SHIM, installed: true })).toBe('claude');
  });

  it('falls back to the file-bridge prompt: no shim, or an agent with no flag and not installed', () => {
    expect(agentLaunchCommand('mystery', { shim: SHIM, installed: false })).toMatch(
      /^mystery 'Read the file \$SPARKDOWN_CONTEXT/,
    );
    expect(agentLaunchCommand('claude', { shim: null, installed: false })).toMatch(
      /^claude 'Read the file \$SPARKDOWN_CONTEXT/,
    );
    // grok not installed and not injectable → prompt fallback.
    expect(agentLaunchCommand('grok', { shim: SHIM, installed: false })).toMatch(
      /^grok 'Read the file \$SPARKDOWN_CONTEXT/,
    );
  });

  it('fallback prompt is safe inside single quotes (no apostrophes or backticks)', () => {
    const cmd = agentLaunchCommand('gemini', { shim: null, installed: false });
    const inner = cmd.slice(cmd.indexOf("'") + 1, cmd.lastIndexOf("'"));
    expect(inner).not.toMatch(/['`]/);
  });

  it('appends configured per-agent flags on the injection path', () => {
    expect(agentLaunchCommand('claude', { shim: SHIM, installed: false, extraArgs: '--model opus' })).toBe(
      `claude --mcp-config '{"mcpServers":{"sparkdown":{"command":"${SHIM.program}","args":["--mcp-stdio"]}}}' --model opus`,
    );
  });

  it('appends configured per-agent flags on the installed and fallback paths', () => {
    expect(agentLaunchCommand('grok', { shim: SHIM, installed: true, extraArgs: '--yolo' })).toBe(
      'grok --yolo',
    );
    expect(agentLaunchCommand('gemini', { shim: null, installed: false, extraArgs: '--yolo' })).toMatch(
      /^gemini --yolo 'Read the file \$SPARKDOWN_CONTEXT/,
    );
  });

  it('ignores blank/whitespace-only flags', () => {
    expect(agentLaunchCommand('claude', { shim: SHIM, installed: false, extraArgs: '   ' })).toBe(
      `claude --mcp-config '{"mcpServers":{"sparkdown":{"command":"${SHIM.program}","args":["--mcp-stdio"]}}}'`,
    );
  });
});

describe('clipboardAction', () => {
  it('macOS: ⌘C copies only when there is a selection', () => {
    expect(clipboardAction(key('c', { metaKey: true }), true)).toBe('copy');
    expect(clipboardAction(key('C', { metaKey: true }), true)).toBe('copy');
    expect(clipboardAction(key('c', { metaKey: true }), false)).toBeNull();
  });

  it('macOS: ⌘V pastes', () => {
    expect(clipboardAction(key('v', { metaKey: true }), false)).toBe('paste');
  });

  it('Linux/Windows: Ctrl+Shift+C / Ctrl+Shift+V', () => {
    expect(clipboardAction(key('c', { ctrlKey: true, shiftKey: true }), true)).toBe('copy');
    expect(clipboardAction(key('v', { ctrlKey: true, shiftKey: true }), false)).toBe('paste');
  });

  it('plain Ctrl+C stays with the terminal (SIGINT), even with a selection', () => {
    expect(clipboardAction(key('c', { ctrlKey: true }), true)).toBeNull();
  });

  it('ignores keyup, Alt combos, and other keys', () => {
    expect(clipboardAction(key('c', { metaKey: true }, 'keyup'), true)).toBeNull();
    expect(clipboardAction(key('c', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(clipboardAction(key('x', { metaKey: true }), true)).toBeNull();
  });
});
