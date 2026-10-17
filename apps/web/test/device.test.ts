import { describe, expect, it } from 'vitest';
import { detectDevice } from '../src/lib/device.ts';

describe('detectDevice', () => {
  it('tells an iPhone, an Android phone and a computer apart', () => {
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148' })).toBe('iphone');
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36' })).toBe('android');
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 0 })).toBe('desktop');
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' })).toBe('desktop');
    expect(detectDevice({ userAgent: '' })).toBe('desktop');
  });

  it('an iPad runs the iPhone app, even when it asks for the desktop site', () => {
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148' })).toBe('iphone');
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5 })).toBe('iphone');
  });

  it('an Android tablet is Android; a Chrome OS or Linux computer is a computer', () => {
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X710) Chrome/126 Safari/537.36' })).toBe('android');
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/126' })).toBe('desktop');
    expect(detectDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/127.0' })).toBe('desktop');
  });
});
