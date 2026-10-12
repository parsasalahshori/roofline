import { describe, expect, test } from 'vitest';
import { FRONT_DESK_TOOLS, TEXT_CHANNEL_TOOLS } from '@roofline/shared';
import { FRONT_DESK_HANDLERS, handlersFor, toolNamesFor } from '../../src/front-desk/tools/index.ts';

const OFF = { canMove: false, canCancel: false };
const ON = { canMove: true, canCancel: true };

describe('front desk tool index', () => {
  test('every tool has a handler', () => {
    for (const name of Object.keys(FRONT_DESK_TOOLS)) {
      expect(FRONT_DESK_HANDLERS).toHaveProperty(name);
    }
  });

  test('move and cancel follow the settings', () => {
    const off = toolNamesFor('voice', OFF);
    expect(off).not.toContain('move_inspection');
    expect(off).not.toContain('cancel_inspection');
    const on = toolNamesFor('voice', ON);
    expect(on).toContain('move_inspection');
    expect(on).toContain('cancel_inspection');
    expect(toolNamesFor('voice', { canMove: true, canCancel: false })).not.toContain('cancel_inspection');
  });

  test('sms is a subset of the text channel tools', () => {
    const sms = toolNamesFor('sms', ON);
    for (const n of sms) expect(TEXT_CHANNEL_TOOLS).toContain(n);
    expect(sms).not.toContain('transfer_to_person');
    expect(sms).not.toContain('end_call');
  });

  test('names are alphabetical', () => {
    for (const ch of ['voice', 'sms'] as const) {
      const names = toolNamesFor(ch, ON);
      expect(names).toEqual([...names].sort());
    }
  });

  test('handlersFor keys equal toolNamesFor', () => {
    for (const ch of ['voice', 'sms'] as const) {
      for (const s of [OFF, ON]) {
        expect(Object.keys(handlersFor(ch, s)).sort()).toEqual(toolNamesFor(ch, s));
      }
    }
  });
});
