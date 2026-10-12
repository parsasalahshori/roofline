import { describe, expect, test } from 'vitest';
import { pathForLog } from '../src/errors.ts';

describe('pathForLog', () => {
  test('a homeowner link token never reaches the log', () => {
    expect(pathForLog('/public/proposals/abcDEF123_-xyz/sign')).toBe('/public/proposals/:token/sign');
    expect(pathForLog('/public/proposals/abcDEF123_-xyz')).toBe('/public/proposals/:token');
    expect(pathForLog('/PUBLIC/proposals/secret/view')).toBe('/PUBLIC/proposals/:token/view');
  });

  test('other paths are logged as they are', () => {
    expect(pathForLog('/jobs/123')).toBe('/jobs/123');
    expect(pathForLog('/proposals/p1/pdf')).toBe('/proposals/p1/pdf');
  });
});
