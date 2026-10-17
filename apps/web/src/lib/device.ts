/*
 * Which kind of device is looking at a page, for offering the right way to measure windows: an iPhone (or iPad, which
 * runs the iPhone app) opens the app, an Android phone measures in its browser, anything else shows a QR code to scan.
 */

export type Device = 'iphone' | 'android' | 'desktop';

type Nav = { userAgent: string; maxTouchPoints?: number };

export function detectDevice(nav: Nav = typeof navigator === 'undefined' ? { userAgent: '' } : navigator): Device {
  const ua = nav.userAgent;
  if (/iPhone|iPod|iPad/i.test(ua)) return 'iphone';
  // iPadOS asks for the desktop site and says Macintosh; only a touch screen gives it away.
  if (/Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return 'iphone';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}
