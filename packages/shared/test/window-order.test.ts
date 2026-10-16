import { describe, expect, it } from 'vitest';
import {
  applyLinePatches,
  checkLine,
  DEFAULT_WINDOW_ORDER_SETTINGS,
  defaultLineOptions,
  deriveOrder,
  floorTo,
  fractionInches,
  groupOrderLines,
  linesFromPhotoWindows,
  type MeasuredSize,
  orderSize,
  resolveOrderSettings,
  temperedSuggestions,
  type WindowOrderLine,
} from '../src/window-order.ts';

const S = DEFAULT_WINDOW_ORDER_SETTINGS;
const m = (widthIn: number, heightIn: number, extra: Partial<MeasuredSize> = {}): MeasuredSize => ({ widthIn, heightIn, uncertaintyIn: null, quality: 'good', ...extra });

function line(over: Partial<WindowOrderLine> = {}): WindowOrderLine {
  return { id: 'w1', photoWindowIds: ['w1'], uploadId: 'u1', location: 'Kitchen', measured: [m(36.3, 60.2)], ...defaultLineOptions(), style: 'double-hung', ...over };
}

describe('the order-size rule', () => {
  it('takes 1/4 in off the smallest measured width and height and floors to 1/8 in', () => {
    // 36.3 - 0.25 = 36.05 -> 36; 60.2 - 0.25 = 59.95 -> 59 7/8
    expect(orderSize([m(36.3, 60.2)], 'double-hung', S)).toEqual({ widthIn: 36, heightIn: 59.875 });
  });

  it('uses the smallest of several photos of one window, width and height separately', () => {
    expect(orderSize([m(36.5, 59.9), m(36.2, 60.4)], 'double-hung', S)).toEqual({ widthIn: 35.875, heightIn: 59.625 });
  });

  it('always rounds down, never to nearest, and survives float error at an exact eighth', () => {
    expect(floorTo(35.999, 0.125)).toBe(35.875);
    expect(floorTo(35.875, 0.125)).toBe(35.875);
    expect(floorTo(0.1 + 0.2 + 35.575, 0.125)).toBe(35.875);
    expect(orderSize([m(36.25, 60.25)], 'picture', S)).toEqual({ widthIn: 36, heightIn: 60 });
  });

  it('takes k x uncertainty off so we err small: k = 1 by default, configurable', () => {
    const u = [m(36.3, 60.2, { uncertaintyIn: { width: 0.2, height: 0.1 } })];
    // 36.3 - 0.2 - 0.25 = 35.85 -> 35 3/4; 60.2 - 0.1 - 0.25 = 59.85 -> 59 3/4
    expect(orderSize(u, 'double-hung', S)).toEqual({ widthIn: 35.75, heightIn: 59.75 });
    const k2 = resolveOrderSettings({ uncertaintyFactor: 2 });
    // 36.3 - 0.4 - 0.25 = 35.65 -> 35 5/8; 60.2 - 0.2 - 0.25 = 59.75
    expect(orderSize(u, 'double-hung', k2)).toEqual({ widthIn: 35.625, heightIn: 59.75 });
    const k0 = resolveOrderSettings({ uncertaintyFactor: 0 });
    expect(orderSize(u, 'double-hung', k0)).toEqual({ widthIn: 36, heightIn: 59.875 });
  });

  it('follows the company deductions and rounding step', () => {
    const s = resolveOrderSettings({ widthDeductionIn: 0.5, heightDeductionIn: 0.375, roundingIn: 0.25 });
    // 36.3 - 0.5 = 35.8 -> 35 3/4; 60.2 - 0.375 = 59.825 -> 59 3/4
    expect(orderSize([m(36.3, 60.2)], 'double-hung', s)).toEqual({ widthIn: 35.75, heightIn: 59.75 });
  });

  it('orders a circle square from its smaller side, and nothing when unmeasured', () => {
    expect(orderSize([m(30.4, 30.1)], 'circle', S)).toEqual({ widthIn: 29.75, heightIn: 29.75 });
    expect(orderSize([], 'circle', S)).toBeNull();
  });

  it('writes inches as fractions', () => {
    expect(fractionInches(35.875)).toBe('35 7/8');
    expect(fractionInches(36)).toBe('36');
    expect(fractionInches(0.25)).toBe('1/4');
    expect(fractionInches(59.0625)).toBe('59 1/16');
  });
});

describe('settings', () => {
  it('lays a company’s changes over the defaults, per style limit', () => {
    const s = resolveOrderSettings({ widthDeductionIn: 0.375, limits: { casement: { maxWidthIn: 40 } } });
    expect(s.widthDeductionIn).toBe(0.375);
    expect(s.heightDeductionIn).toBe(0.25);
    expect(s.limits.casement).toMatchObject({ maxWidthIn: 40, minWidthIn: 14, maxHeightIn: 72 });
    expect(s.limits['double-hung']).toEqual(S.limits['double-hung']);
    expect(resolveOrderSettings(null)).toEqual(S);
  });
});

describe('factory limits', () => {
  it('a line inside the limits is ready', () => {
    const c = checkLine(line(), S);
    expect(c).toMatchObject({ status: 'ready', reasons: [], order: { widthIn: 36, heightIn: 59.875 }, orderable: true, specialOrder: false });
  });

  it('a width over the style’s largest is an error with a plain reason', () => {
    const c = checkLine(line({ measured: [m(50, 40)] }), S);
    expect(c.status).toBe('error');
    expect(c.reasons[0]).toEqual({ level: 'error', message: 'Width 49 3/4 in is over the 48 in largest for Double-hung.' });
    expect(c.orderable).toBe(false);
  });

  it('checks the smallest sizes, united inches, glass area and tempered area', () => {
    expect(checkLine(line({ style: 'awning', measured: [m(20, 10)] }), S).reasons.map((r) => r.message)).toContain('Height 9 3/4 in is under the 12 in smallest for Awning.');
    // 47.75 + 83.75 = 131.5 UI > 120
    expect(checkLine(line({ measured: [m(48, 84)] }), S).reasons.map((r) => r.message)).toContain('131 1/2 united inches is over the 120 largest for Double-hung.');
    // picture 70 x 90 -> 43.6 sq ft > 40
    expect(checkLine(line({ style: 'picture', measured: [m(70.25, 90.25)] }), S).reasons.some((r) => r.message.includes('sq ft largest for this glass'))).toBe(true);
    // picture 60 x 72 = 30 sq ft: fine, but over 32? no; tempered limit 32 -> fine; make it 66 x 72 = 33 sq ft
    const tempered = checkLine(line({ style: 'picture', tempered: true, measured: [m(66.25, 72.25)] }), S);
    expect(tempered.reasons.map((r) => r.message)).toContain('33.0 sq ft is over the 32 sq ft largest for tempered glass in Picture.');
  });

  it('missing style or location, a bad quantity or a bad grid pattern is an error', () => {
    const c = checkLine(line({ style: null, location: ' ', quantity: 0, grid: { type: 'colonial', top: '3by2', bottom: '' } }), S);
    expect(c.status).toBe('error');
    expect(c.reasons.map((r) => r.message)).toEqual(expect.arrayContaining(['Name the room or location.', 'Pick a style.', 'Quantity must be 1 to 50.', 'Grid patterns look like 3x2 (lites wide x high).']));
    expect(checkLine(line({ grid: { type: 'prairie', top: '', bottom: '' } }), S).reasons[0]!.message).toBe('Give a grid pattern for at least one sash, or pick no grid.');
    expect(checkLine(line({ grid: { type: 'colonial', top: '3x2', bottom: '3x2' } }), S).status).toBe('ready');
  });

  it('flags arch and circle as special orders', () => {
    expect(checkLine(line({ style: 'arch', measured: [m(48, 20)] }), S).specialOrder).toBe(true);
  });

  it('a locked size is used as is (the order was marked ready)', () => {
    expect(checkLine(line({ lockedSize: { widthIn: 30, heightIn: 50 } }), S).order).toEqual({ widthIn: 30, heightIn: 50 });
  });
});

describe('check status', () => {
  it('a photo of quality check, or uncertainty over 1/4 in, is a check line until confirmed', () => {
    const q = checkLine(line({ measured: [m(36.3, 60.2, { quality: 'check' })] }), S);
    expect(q.status).toBe('check');
    expect(q.orderable).toBe(false);
    const u = checkLine(line({ measured: [m(36.3, 60.2, { uncertaintyIn: { width: 0.3, height: 0.1 } })] }), S);
    expect(u.status).toBe('check');
    expect(u.reasons[0]!.message).toContain('off by 5/16 in');
    expect(checkLine(line({ measured: [m(36.3, 60.2, { uncertaintyIn: { width: 0.25, height: 0.25 } })] }), S).status).toBe('ready');
    expect(checkLine(line({ confirmed: true, measured: [m(36.3, 60.2, { quality: 'check' })] }), S)).toMatchObject({ status: 'check', orderable: true });
  });

  it('an error is never made orderable by confirming', () => {
    expect(checkLine(line({ confirmed: true, style: null }), S).orderable).toBe(false);
  });

  it('a window measured only by the room scan (quote-grade) is an error, never orderable, even confirmed', () => {
    const room = m(36.3, 60.2, { quality: 'check', uncertaintyIn: { width: 1, height: 1 }, quoteOnly: true });
    const c = checkLine(line({ confirmed: true, measured: [room] }), S);
    expect(c.status).toBe('error');
    expect(c.orderable).toBe(false);
    expect(c.reasons[0]!.message).toMatch(/room scan only/);
    // The uncertainty gate flags it too
    expect(c.reasons.some((r) => r.level === 'check' && /off by 1 in/.test(r.message))).toBe(true);
  });

  it('a room-scan measurement next to an order-grade one is left out of the order size and the checks', () => {
    const room = m(35, 59, { quality: 'check', uncertaintyIn: { width: 1, height: 1 }, quoteOnly: true });
    const c = checkLine(line({ measured: [room, m(36.3, 60.2)] }), S);
    expect(c.status).toBe('ready');
    expect(c.order).toEqual({ widthIn: 36, heightIn: 59.875 });
  });
});

describe('safety glass suggestions (IRC R308.4)', () => {
  const ask = (safety: Partial<WindowOrderLine['safety']>, over: Partial<WindowOrderLine> = {}) => line({ ...over, safety: { ...line().safety, ...safety } });

  it('suggests nothing until a question is answered yes', () => {
    expect(temperedSuggestions(line(), { widthIn: 36, heightIn: 60 })).toEqual([]);
    expect(temperedSuggestions(ask({ besideDoor: false, wetArea: false, sillHeightIn: 30, walkway: false }), { widthIn: 36, heightIn: 60 })).toEqual([]);
  });

  it('beside a door: suggested when the sill is under 60 in or not given', () => {
    expect(temperedSuggestions(ask({ besideDoor: true }), null).map((s) => s.code)).toEqual(['IRC R308.4.2']);
    expect(temperedSuggestions(ask({ besideDoor: true, sillHeightIn: 59 }), null).map((s) => s.rule)).toEqual(['door']);
    expect(temperedSuggestions(ask({ besideDoor: true, sillHeightIn: 60 }), null)).toEqual([]);
  });

  it('a tub or shower: suggested when the sill is under 60 in above the standing surface', () => {
    expect(temperedSuggestions(ask({ wetArea: true, sillHeightIn: 40 }), null).map((s) => s.code)).toEqual(['IRC R308.4.5']);
    expect(temperedSuggestions(ask({ wetArea: true, sillHeightIn: 66 }), null)).toEqual([]);
  });

  it('a large low pane: over 9 sq ft per pane, bottom under 18 in, top over 36 in, a walkway within 36 in', () => {
    const big = { widthIn: 48, heightIn: 72 }; // picture: 24 sq ft, one pane
    expect(temperedSuggestions(ask({ sillHeightIn: 12, walkway: true }, { style: 'picture' }), big).map((s) => s.code)).toEqual(['IRC R308.4.3']);
    expect(temperedSuggestions(ask({ sillHeightIn: 18, walkway: true }, { style: 'picture' }), big)).toEqual([]); // bottom not under 18
    expect(temperedSuggestions(ask({ sillHeightIn: 12, walkway: false }, { style: 'picture' }), big)).toEqual([]); // no walkway
    expect(temperedSuggestions(ask({ sillHeightIn: 12, walkway: true }, { style: 'picture' }), { widthIn: 36, heightIn: 36 })).toEqual([]); // 9 sq ft, not over
    // A double-hung of the same size has two panes of 12 sq ft: still over 9.
    expect(temperedSuggestions(ask({ sillHeightIn: 12, walkway: true }, { style: 'double-hung' }), big)).toHaveLength(1);
    // 36 x 60 double-hung: 7.5 sq ft per pane -> not over 9.
    expect(temperedSuggestions(ask({ sillHeightIn: 12, walkway: true }, { style: 'double-hung' }), { widthIn: 36, heightIn: 60 })).toEqual([]);
  });

  it('a suggestion makes the line a check, shown, not forced; ticking tempered clears it', () => {
    const c = checkLine(ask({ besideDoor: true, sillHeightIn: 20 }), S);
    expect(c.status).toBe('check');
    expect(c.suggestions.map((s) => s.code)).toEqual(['IRC R308.4.2']);
    expect(c.reasons[0]!.message).toContain('IRC R308.4.2');
    const t = checkLine(ask({ besideDoor: true, sillHeightIn: 20 }, { tempered: true }), S);
    expect(t.status).toBe('ready');
    expect(t.suggestions).toHaveLength(1); // still shown
  });
});

describe('grouping and totals', () => {
  it('groups identical windows into one line with a quantity, and keeps different ones apart', () => {
    const lines = [
      line({ id: 'a', location: 'Bedroom 1' }),
      line({ id: 'b', location: 'Bedroom 2', measured: [m(36.35, 60.25)] }), // same order size 36 x 59 7/8... 60.25-0.25=60 -> 60
      line({ id: 'c', location: 'Bedroom 3', measured: [m(36.3, 60.2)], quantity: 2 }),
      line({ id: 'd', location: 'Bath', measured: [m(36.3, 60.2)], obscure: true }),
    ];
    const { groups, totals } = groupOrderLines(lines, S);
    expect(groups.map((g) => [g.lineNo, g.locations, g.quantity, g.widthIn, g.heightIn, g.obscure])).toEqual([
      [1, ['Bedroom 1', 'Bedroom 3'], 3, 36, 59.875, false],
      [2, ['Bedroom 2'], 1, 36, 60, false],
      [3, ['Bath'], 1, 36, 59.875, true],
    ]);
    expect(totals.windows).toBe(5);
    expect(totals.unitedIn).toBe(4 * (36 + 59.875) + (36 + 60));
    expect(totals.sqFt).toBe(Math.round(((4 * 36 * 59.875 + 36 * 60) / 144) * 100) / 100);
    expect(totals.lines).toBe(3);
  });

  it('leaves lines without a style or size out of the sheet', () => {
    expect(groupOrderLines([line({ style: null }), line({ id: 'x', measured: [] })], S).totals.windows).toBe(0);
  });

  it('ready to mark only when every line is orderable', () => {
    expect(deriveOrder([line()], S).canMarkReady).toBe(true);
    expect(deriveOrder([line(), line({ id: 'b', style: null })], S).canMarkReady).toBe(false);
    expect(deriveOrder([], S).canMarkReady).toBe(false);
  });
});

describe('lines from photo windows', () => {
  const pw = (id: string, over: Record<string, unknown> = {}) => ({ id, uploadId: `u-${id}`, widthIn: 36.3, heightIn: 60.2, quality: 'good' as const, ...over });

  it('one line per window; photos sharing a windowKey are one window; excluded photos are left out', () => {
    const lines = linesFromPhotoWindows([pw('p1', { label: 'Kitchen' }), pw('p2', { windowKey: 'k', widthIn: 30 }), pw('p3', { windowKey: 'k', widthIn: 29.9, uncertaintyIn: { width: 0.1, height: 0.1 } }), pw('p4')], new Set(['p4']));
    expect(lines.map((l) => [l.id, l.location, l.photoWindowIds, l.measured.length])).toEqual([
      ['p1', 'Kitchen', ['p1'], 1],
      ['k', 'Window 2', ['p2', 'p3'], 2],
    ]);
    expect(lines[1]!.measured[1]!.uncertaintyIn).toEqual({ width: 0.1, height: 0.1 });
    expect(lines[0]).toMatchObject({ style: null, glass: 'lowe-argon', screen: 'full', quantity: 1, tempered: false });
  });

  it('refreshing keeps the person’s options and takes the new measurements', () => {
    const [first] = linesFromPhotoWindows([pw('p1')], new Set());
    const edited = applyLinePatches([first!], [{ id: 'p1', style: 'slider-2', location: 'Den' }])!;
    const [again] = linesFromPhotoWindows([pw('p1', { widthIn: 40 })], new Set(), edited);
    expect(again).toMatchObject({ style: 'slider-2', location: 'Den', measured: [expect.objectContaining({ widthIn: 40 })] });
  });

  it('a room-scan window (no photo) is a quote-only line with no thumbnail; another photo of it gives the thumbnail', () => {
    const scan = { id: 'r1', windowKey: 'den', widthIn: 36, heightIn: 60, quality: 'check' as const, uncertaintyIn: { width: 1, height: 1 }, scale: { kind: 'roomplan' } };
    const [only] = linesFromPhotoWindows([scan], new Set());
    expect(only).toMatchObject({ id: 'den', uploadId: null, measured: [expect.objectContaining({ quoteOnly: true })] });
    expect(checkLine({ ...only!, style: 'picture' }, S).status).toBe('error');
    const [both] = linesFromPhotoWindows([scan, pw('a1', { windowKey: 'den', scale: { kind: 'ar' } })], new Set());
    expect(both!.uploadId).toBe('u-a1');
    expect(both!.measured.map((x) => x.quoteOnly === true)).toEqual([true, false]);
    expect(checkLine({ ...both!, style: 'picture' }, S).status).toBe('ready');
  });

  it('a patch naming a line that is not there is refused', () => {
    expect(applyLinePatches([line()], [{ id: 'nope', quantity: 2 }])).toBeNull();
  });
});
