import type { HomeownerCompany, HomeownerRequestView, HomeownerWindow, PublicQuoteConfig } from '@roofline/shared';

export const SLUG = 'summit-ridge';
export const BASE = `/api/public/homeowner/${SLUG}`;
export const REQ = 'd1a18ca3-63ed-447f-b53a-e1f6276ccf71';
export const TOKEN = 'Sb_kMSOnM2pD4CE7bykxE1EYltxTzm6CzaX9UZAnVmQ';
export const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
export const ADDRESS = '4810 Underwood Ave, Omaha, NE 68132';
export const APP = { url: 'https://apps.apple.com/us/app/winchoice/id0000000000', name: 'WinChoice' };

export const QUOTE_CONFIG: PublicQuoteConfig = {
  slug: SLUG,
  companyName: 'Summit Ridge Roofing',
  logoUrl: null,
  accentColor: '#1f6feb',
  phone: '+14025550180',
  products: ['windows', 'roof'],
  booking: true,
  consent: { version: 'v', text: 't', textingText: 'x', privacyUrl: 'https://x.test/p', termsUrl: 'https://x.test/t' },
  turnstileSiteKey: null,
  homeownerApp: APP,
};

export const COMPANY: HomeownerCompany = {
  apiVersion: 1,
  name: 'Summit Ridge Roofing',
  brandColor: null,
  phone: '+14025550180',
  services: ['windows', 'roof'],
  booking: true,
  privacyUrl: 'https://summit-ridge-roofing.roofline.test/privacy',
  termsUrl: 'https://summit-ridge-roofing.roofline.test/terms',
  consent: {
    version: '2026-10-16',
    text: 'By checking this box and clicking "Send my request", I agree that Summit Ridge Roofing may contact me.',
    textingText: 'Text me too: Summit Ridge Roofing may send text messages.',
  },
  windowStyles: [
    { key: 'double-hung', label: 'Double-hung' },
    { key: 'picture', label: 'Picture (does not open)' },
  ],
  trust: null,
  limits: { maxWindows: 60, maxPhotoBytes: 12_582_912, maxRoomLength: 40, maxLabelLength: 80, tokenDays: 60 },
};

export const CREATED = {
  requestId: REQ,
  token: TOKEN,
  expiresAt: '2099-12-15T21:22:11.011Z',
  status: 'ready',
  home: { address: ADDRESS, floors: null, outline: null },
  estimate: { windows: { low: 14, high: 28, likely: 14 }, roof: null },
  services: ['windows'],
};

export const WINDOW: HomeownerWindow = {
  id: 'w-kitchen-1',
  room: 'Kitchen',
  label: 'Over the sink',
  style: 'double-hung',
  scale: { kind: 'card', cardCorners: [[1437, 1968], [1587, 1969], [1587, 2063], [1437, 2064]], card: { widthMm: 85.6, heightMm: 53.98 } },
  uploadId: '33d44c23-1e91-42a6-bdb4-16c53aec0380',
  corners: [[644, 532], [2312, 675], [2312, 3357], [644, 3500]],
  widthIn: 35.9,
  heightIn: 60.1,
  sizeClass: 'standard',
  uncertaintyIn: { width: 0.55, height: 0.91 },
  quality: 'check',
  reasons: ['The card is small next to this window.'],
  sizeLabel: '35 7/8 x 60 1/8',
  uncertaintyLabel: 'about ±1 in',
};

const TIERS = (n: number) =>
  (['good', 'better', 'best'] as const).map((key, i) => ({
    key,
    label: ['Good', 'Better', 'Best'][i]!,
    name: ['Vinyl double-hung', 'Fiberglass', 'Wood-clad'][i]!,
    description: 'Double-pane, Low-E glass',
    total: n === 0 ? 0 : 8750 + i * 2000,
    perWindow: [],
    estimatedCount: n === 0 ? 0 : 13,
    estimatedTotal: 0,
  }));

export function view(windows: HomeownerWindow[] = [], extra: Partial<HomeownerRequestView> = {}): HomeownerRequestView {
  return {
    request: {
      id: REQ,
      status: 'ready',
      services: ['windows'],
      home: { address: ADDRESS, floors: null, outline: null },
      estimate: { windows: { low: 14, high: 28, likely: 14 }, roof: null },
      estimatedTotalOverride: null,
      contactFiled: false,
      createdAt: '2026-10-16T21:22:11.011Z',
      expiresAt: '2099-12-15T21:22:11.011Z',
    },
    windows,
    rooms: [...new Set(windows.map((w) => w.room))],
    quote: {
      tiers: TIERS(windows.length),
      measuredCount: windows.length,
      estimatedCount: windows.length === 0 ? 0 : 13,
      ...(windows.length > 0 && { missingHint: { measured: windows.length, expectedLow: 14, expectedHigh: 28, expectedLikely: 14, text: 'We think your home has about 14 to 28 windows and you have measured 1. Did we miss any?' } }),
    },
    ...extra,
  };
}
