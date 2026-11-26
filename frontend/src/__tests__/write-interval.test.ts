// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { WRITE_INTERVAL_MS } from '../app/documents';

describe('WRITE_INTERVAL_MS', () => {
  it('matches MIN_WRITE_INTERVAL_MS in src-tauri/src/commands.rs', async () => {
    // Typed loosely: the frontend tsconfig has no Node types.
    const fs: { readFileSync(p: URL, enc: string): string } = await import('node:fs' as string);
    const src = fs.readFileSync(new URL('../../../src-tauri/src/commands.rs', import.meta.url), 'utf8');
    const m = /const MIN_WRITE_INTERVAL_MS: u64 = (\d+);/.exec(src);
    expect(m?.[1]).toBe(String(WRITE_INTERVAL_MS));
  });
});
