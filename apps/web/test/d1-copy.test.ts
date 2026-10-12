// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CARRIERS, forwardingSteps } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { forwarding } from '../src/copy/forwarding.ts';
import { conversationCopy } from '../src/copy/front-desk-conversation.ts';
import { frontDeskInbox } from '../src/copy/front-desk-inbox.ts';
import { frontDeskSettings } from '../src/copy/front-desk-settings.ts';

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

  it('has no empty Front Desk words', () => {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') expect(value.trim().length, path).toBeGreaterThan(0);
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
      }
    };
    walk(frontDeskInbox, 'frontDeskInbox');
    walk(conversationCopy, 'conversationCopy');
    walk(frontDeskSettings, 'frontDeskSettings');
  });

  it('names no carrier in the Front Desk words', () => {
    const source = ['front-desk-inbox.ts', 'front-desk-conversation.ts', 'front-desk-settings.ts'].map(read).join('\n');
    for (const name of ['Verizon', 'AT&T', 'T-Mobile', 'RingCentral', 'Google', 'Ooma', 'Spectrum', 'Comcast', 'Grasshopper']) {
      expect(source.includes(name), name).toBe(false);
    }
  });
});
