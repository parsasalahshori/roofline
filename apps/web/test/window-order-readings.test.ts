import { DEFAULT_WINDOW_ORDER_SETTINGS, orderSize, type MeasuredSize } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { windowOrder as copy } from '../src/copy/windowOrder.ts';
import { orderReadings } from '../src/features/measure/windows/order/readings.ts';

const m = (widthIn: number, heightIn: number, uncertaintyIn: MeasuredSize['uncertaintyIn'] = null, extra: Partial<MeasuredSize> = {}): MeasuredSize => ({ widthIn, heightIn, uncertaintyIn, quality: 'good', ...extra });
const S = DEFAULT_WINDOW_ORDER_SETTINGS;

describe('orderReadings: the readings the order size is taken from', () => {
  it('is the smallest reading of each side when the photos share one error', () => {
    const photos = [m(71.25, 59.375, { width: 0.75, height: 0.625 }), m(71.375, 59.5, { width: 0.75, height: 0.625 }), m(71.625, 59.75, { width: 0.75, height: 0.625 })];
    const r = orderReadings(photos, 1)!;
    expect(r.width).toMatchObject({ inches: 71.25, error: 0.75 });
    expect(r.height).toMatchObject({ inches: 59.375, error: 0.625 });
    expect(r.known).toBe(true);
  });

  it('adds up to the order size: reading, less its error, less the fit allowance, rounded down (the 58 1/2 on the demo sheet)', () => {
    const photos = [m(71.25, 59.375, { width: 0.75, height: 0.625 }), m(71.375, 59.5, { width: 0.75, height: 0.625 })];
    const r = orderReadings(photos, S.uncertaintyFactor)!;
    const size = orderSize(photos, 'slider-3', S)!;
    expect(size).toEqual({ widthIn: 70.25, heightIn: 58.5 });
    // The sides' own errors, not the larger of the two on both: 59 3/8 - 5/8 - 1/4 = 58 1/2
    expect(Math.floor((r.height.inches - r.height.error - S.heightDeductionIn) / S.roundingIn) * S.roundingIn).toBe(size.heightIn);
    expect(Math.floor((r.width.inches - r.width.error - S.widthDeductionIn) / S.roundingIn) * S.roundingIn).toBe(size.widthIn);
  });

  it('takes the photo that is smallest after its error, which is not always the smallest reading', () => {
    // A LiDAR reading (small error) and a sheet photo that reads wider but with a big error
    const photos = [m(36, 60, { width: 0.125, height: 0.125 }), m(36.125, 60.125, { width: 0.5, height: 0.5 })];
    const r = orderReadings(photos, 1)!;
    expect(r.width.reading).toBe(photos[1]);
    expect(r.width).toMatchObject({ inches: 36.125, error: 0.5 });
    expect(orderSize(photos, 'double-hung', S)!.widthIn).toBe(Math.floor((36.125 - 0.5 - S.widthDeductionIn) / S.roundingIn) * S.roundingIn);
  });

  it('keeps each side on its own photo', () => {
    const photos = [m(36, 61, { width: 0.125, height: 0.125 }), m(37, 60, { width: 0.125, height: 0.125 })];
    const r = orderReadings(photos, 1)!;
    expect(r.width.reading).toBe(photos[0]);
    expect(r.height.reading).toBe(photos[1]);
  });

  it('leaves a room scan out when there is any other reading, and reads none when nothing is measured', () => {
    const scan = m(30, 40, null, { quoteOnly: true });
    const photo = m(36, 60, { width: 0.125, height: 0.125 });
    expect(orderReadings([scan, photo], 1)!.width.reading).toBe(photo);
    expect(orderReadings([], 1)).toBeNull();
  });

  it('knows nothing of the error when the method cannot tell, and counts it as none', () => {
    const r = orderReadings([m(35.5, 47.75)], 1)!;
    expect(r.known).toBe(false);
    expect(r.width.error).toBe(0);
  });
});

describe('the error line', () => {
  it('is one ± when both sides have the same error, and one each when they differ', () => {
    expect(copy.errors.line(0.75, 0.75)).toBe('±3/4');
    expect(copy.errors.line(0.75, 0.625)).toBe('±3/4 × ±5/8');
    // Errors that read the same to the sixteenth are one
    expect(copy.errors.line(0.1, 0.125)).toBe('±1/8');
  });

  it('is said in words for a screen reader', () => {
    expect(copy.errors.speech(0.75, 0.75)).toBe('plus or minus 3/4');
    expect(copy.errors.speech(0.75, 0.625)).toBe('plus or minus 3/4 wide and 5/8 high');
  });
});
