// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIDE_PANEL_REM } from '../src/features/agents/sidePanel.ts';

// The Agents overview decides in two places whether the picked agent's panel sits beside the cards: the layout, in CSS, as a
// container query, and the window, in code, to choose between a card that picks and a card that opens its page. If the two
// disagree there is a width where the panel is there and the cards open pages, or the cards pick and no panel shows.

const css = (name: string) => readFileSync(fileURLToPath(new URL(`../src/features/agents/${name}`, import.meta.url)), 'utf8');

describe('where the Agents overview puts the picked agent\'s panel', () => {
  it('asks for the same width in the layout and in the window', () => {
    const widths = [...css('AgentsWindow.module.css').matchAll(/@container\s*\(min-width:\s*([\d.]+)rem\)/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([SIDE_PANEL_REM]);
  });
});
