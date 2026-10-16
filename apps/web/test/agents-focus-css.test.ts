// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `--focus` is a box-shadow (a halo of the surface and the ring colour), not a colour. Read by `outline`, `border` or
// `color` it is invalid when the page is drawn and the property falls back to none: a card's keyboard ring just vanishes,
// and no test that looks for the variable's name sees it. The colour for an outline is `--ring`.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

function styles(dir: string): string[] {
  return readdirSync(here(dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.css'))
    .map((name) => `${dir}/${name}`);
}

const files = [
  ...styles('../src/features/agents'),
  ...styles('../src/features/approvals'),
  ...styles('../../../packages/ui/src/components/ApprovalCard'),
  ...styles('../../../packages/ui/src/components/ReviewSteps'),
];

describe('focus rings in the Agents and approvals styles', () => {
  it('finds the stylesheets it checks', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)('%s never reads --focus where a colour is needed', (file) => {
    const source = readFileSync(here(file), 'utf8');
    const wrong = [...source.matchAll(/([\w-]+)\s*:\s*([^;{}]*var\(--focus\)[^;{}]*);/g)]
      .map((m) => ({ property: m[1]!, value: m[2]!.trim() }))
      .filter(({ property }) => property !== 'box-shadow');
    expect(wrong).toEqual([]);
  });

  it('draws the card and claim rings in the ring colour', () => {
    for (const file of ['../src/features/agents/AgentCard.module.css', '../src/features/agents/ClaimsBoard.module.css']) {
      expect(readFileSync(here(file), 'utf8')).toMatch(/outline:\s*2px solid var\(--ring\)/);
    }
  });
});
