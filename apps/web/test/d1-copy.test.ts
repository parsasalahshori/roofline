// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CARRIERS, forwardingSteps } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { forwarding } from '../src/copy/forwarding.ts';
import { frontDesk } from '../src/copy/front-desk.ts';

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/copy/${name}`, import.meta.url)), 'utf8');

describe('D1 copy', () => {
  it('labels every carrier', () => {
    for (const carrier of CARRIERS) {
      expect(forwarding.carriers[carrier].trim().length, carrier).toBeGreaterThan(0);
    }
    expect(Object.keys(forwarding.carriers).sort()).toEqual([...CARRIERS].sort());
  });

  it('has plain labels for the forwarding screen', () => {
    for (const text of [
      forwarding.title,
      forwarding.modes.all,
      forwarding.modes.no_answer,
      forwarding.turnOn,
      forwarding.turnOff,
      forwarding.dialIntro,
      forwarding.stepsIntro,
    ]) {
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it('leaves the step sentences to the shared package', () => {
    const source = read('forwarding.ts');
    for (const carrier of CARRIERS) {
      for (const mode of ['all', 'no_answer'] as const) {
        const { on, off } = forwardingSteps(carrier, mode, '+15551234567');
        for (const sentence of [...on, ...off]) expect(source.includes(sentence), sentence).toBe(false);
      }
    }
  });

  it('has the Front Desk words other tasks use', () => {
    for (const text of [
      frontDesk.windowEmpty,
      frontDesk.conversationEmpty,
      frontDesk.settingsEmpty,
      frontDesk.transferPhone.title,
      frontDesk.transferPhone.empty,
    ]) {
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it('names no carrier in the Front Desk words', () => {
    const source = read('front-desk.ts');
    for (const name of ['Verizon', 'AT&T', 'T-Mobile', 'RingCentral', 'Google', 'Ooma', 'Spectrum', 'Comcast', 'Grasshopper']) {
      expect(source.includes(name), name).toBe(false);
    }
  });
});
