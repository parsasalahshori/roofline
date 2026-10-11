import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/features/auth/safeNext.ts';

describe('safeNext', () => {
  it.each(['/', '/approvals/x', '/approvals?x=1', '/jobs/123?tab=notes#top', '/a:b'])('keeps the local path %s', (path) => {
    expect(safeNext(path)).toBe(path);
  });

  it.each([
    ['a protocol-relative address', '//evil.example'],
    ['a protocol-relative address with a path', '//evil.example/steal'],
    ['a backslash address', '/\\evil.example'],
    ['a full address', 'https://evil.example'],
    ['a script address', 'javascript:alert(1)'],
    ['a path without a leading slash', 'approvals/x'],
    ['a tab hidden in the slashes (browsers strip it)', '/\t/evil.example'],
    ['a line break hidden in the slashes (browsers strip it)', '/\n/evil.example'],
    ['an empty string', ''],
  ])('falls back to / for %s', (_name, raw) => {
    expect(safeNext(raw)).toBe('/');
  });

  it('falls back to / when there is no next at all', () => {
    expect(safeNext(null)).toBe('/');
  });
});
