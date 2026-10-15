import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealUsgsLidarApi } from '../../src/providers/usgs-lidar.ts';
import { TILE_URL } from './usgs-lidar-fixture.ts';

/*
 * The real USGS client against a mocked fetch (no network): it must refuse what would silently corrupt a tile, a
 * byte range answered as something else, and an HTML page in place of a file's size.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, headers: Record<string, string>, body: Uint8Array = new Uint8Array(0)) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(status === 204 || body.byteLength === 0 ? null : body, { status, headers })));
}

describe('RealUsgsLidarApi over HTTP', () => {
  const api = new RealUsgsLidarApi();
  const range: [number, number] = [100, 109];
  const ten = new Uint8Array(10).fill(7);

  it('a byte range comes back as 206 with the matching Content-Range', async () => {
    answer(206, { 'content-range': 'bytes 100-109/5000', 'content-length': '10' }, ten);
    expect(await api.getBytes(TILE_URL, { timeoutMs: 1000, maxBytes: 100, range })).toEqual(ten);
  });

  it('a 200 with the range\'s byte count, or a 206 for another offset, is refused (never stitched into a tile)', async () => {
    answer(200, { 'content-length': '10' }, ten);
    await expect(api.getBytes(TILE_URL, { timeoutMs: 1000, maxBytes: 100, range })).rejects.toMatchObject({ reason: 'bad-answer' });
    answer(206, { 'content-range': 'bytes 0-9/5000', 'content-length': '10' }, ten);
    await expect(api.getBytes(TILE_URL, { timeoutMs: 1000, maxBytes: 100, range })).rejects.toMatchObject({ reason: 'bad-answer' });
  });

  it('size: an HTML page answered with 200 is not a file size', async () => {
    answer(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '1234' });
    await expect(api.size(TILE_URL, { timeoutMs: 1000 })).rejects.toMatchObject({ reason: 'bad-answer' });
    answer(200, { 'content-type': 'application/octet-stream', 'content-length': '1234' });
    expect(await api.size(TILE_URL, { timeoutMs: 1000 })).toBe(1234);
  });

  it('a body over the byte cap is refused while streaming', async () => {
    answer(200, {}, new Uint8Array(500));
    await expect(api.getBytes(TILE_URL, { timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ reason: 'too-large' });
  });
});
