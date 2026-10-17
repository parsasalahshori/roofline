import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { guardUpload, UPLOAD_GUARD, UploadGate } from '../../src/public/homeowner-upload.ts';

/*
 * How the homeowner API bounds the photos it is receiving: how many at once, and when a stalled one is cut off. No
 * database; the clock is faked.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('UploadGate', () => {
  test('three at once per request, six per address, twelve in all', () => {
    expect(UPLOAD_GUARD).toMatchObject({ perRequest: 3, perIp: 6, inProcess: 12 });
    const gate = new UploadGate();

    // One request: three, not four
    const a = [gate.enter('req-a', 'ip-1'), gate.enter('req-a', 'ip-1'), gate.enter('req-a', 'ip-1')];
    expect(a.every((p) => p !== null)).toBe(true);
    expect(gate.enter('req-a', 'ip-1')).toBeNull();

    // One address: six in all, whoever they are for
    const b = [gate.enter('req-b', 'ip-1'), gate.enter('req-b', 'ip-1'), gate.enter('req-b', 'ip-1')];
    expect(b.every((p) => p !== null)).toBe(true);
    expect(gate.enter('req-c', 'ip-1')).toBeNull();
    // ...but another address is not held back
    expect(gate.enter('req-c', 'ip-2')).not.toBeNull();
    expect(gate.inFlight).toBe(7);

    // The whole process: twelve
    const others = ['ip-3', 'ip-4', 'ip-5', 'ip-6'].flatMap((ip, i) => [gate.enter(`req-${i}x`, ip), gate.enter(`req-${i}x`, ip)]);
    expect(others.filter((p) => p !== null)).toHaveLength(5);
    expect(gate.inFlight).toBe(12);
    expect(gate.enter('req-new', 'ip-new')).toBeNull();
  });

  test('a place given back is free again, once, however often it is given back', () => {
    const gate = new UploadGate({ perRequest: 1, perIp: 1, inProcess: 2 });
    const first = gate.enter('r', 'ip');
    expect(first).not.toBeNull();
    expect(gate.enter('r', 'ip')).toBeNull();
    first!.leave();
    first!.leave(); // a second call must not free another place
    expect(gate.inFlight).toBe(0);
    const again = gate.enter('r', 'ip');
    expect(again).not.toBeNull();
    expect(gate.enter('r', 'ip')).toBeNull();
    again!.leave();
    expect(gate.inFlight).toBe(0);
  });
});

/** A request stream as far as the guard needs one: it can emit data, and destroying it with an error emits 'error'. */
function fakeRequest() {
  const events = new EventEmitter();
  const destroy = vi.fn((error?: Error) => {
    if (error) events.emit('error', error);
  });
  // `events` is for the test to emit data on and count listeners; `stream` is what the guard is given.
  return { events, destroy, stream: Object.assign(events, { destroy }) as unknown as Readable };
}

describe('guardUpload', () => {
  test('a photo that stops arriving is cut off after the idle time; bytes arriving keep it alive', () => {
    vi.useFakeTimers();
    const req = fakeRequest();
    guardUpload(req.stream, 1000, 100_000);
    vi.advanceTimersByTime(900);
    expect(req.destroy).not.toHaveBeenCalled();
    req.events.emit('data', Buffer.from('x'));
    vi.advanceTimersByTime(900); // 900 after the last bytes
    expect(req.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200); // 1100 after them
    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(req.destroy.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  test('a photo that keeps trickling in is still cut off after the total time', () => {
    vi.useFakeTimers();
    const req = fakeRequest();
    guardUpload(req.stream, 1000, 5000);
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(500);
      req.events.emit('data', Buffer.from('x'));
    }
    expect(req.destroy).not.toHaveBeenCalled(); // 4500 ms in
    vi.advanceTimersByTime(600);
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  test('once the body has been read, stopping the guard ends the clock and removes its listener', () => {
    vi.useFakeTimers();
    const req = fakeRequest();
    const stop = guardUpload(req.stream, 1000, 5000);
    expect(req.events.listenerCount('data')).toBe(1);
    stop();
    expect(req.events.listenerCount('data')).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(req.destroy).not.toHaveBeenCalled();
  });

  test('destroying the request with an error is never an uncaught error event', () => {
    vi.useFakeTimers();
    const req = fakeRequest();
    guardUpload(req.stream, 1000, 5000);
    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  test('the real bounds are a 20 second silence and 3 minutes in all', () => {
    expect(UPLOAD_GUARD.idleMs).toBe(20_000);
    expect(UPLOAD_GUARD.totalMs).toBe(180_000);
  });
});
