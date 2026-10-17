import { cleanup, render, screen } from '@testing-library/react';
import { CONSENT_STATUSES, type ConsentStatus } from '@roofline/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { customers } from '../src/copy/customers.ts';
import { ConsentChip } from '../src/features/customers/ConsentChip.tsx';

afterEach(cleanup);

// A status is never only a colour: every texting state wears a glyph beside its words, so the grey ones are not blank.
describe('the texting status tag', () => {
  it.each(CONSENT_STATUSES)('consent %s shows its words with a glyph beside them', (status) => {
    render(<ConsentChip status={status} />);
    const tag = screen.getByText(customers.consent[status]);
    expect(tag.querySelector('svg')).not.toBeNull();
  });

  it.each([
    ['none', 'neutral'],
    ['express', 'neutral'],
    ['attested', 'ok'],
    ['written', 'ok'],
    ['revoked', 'bad'],
  ] as const satisfies readonly (readonly [ConsentStatus, string])[])('consent %s is a %s tag', (status, tone) => {
    render(<ConsentChip status={status} />);
    expect(screen.getByText(customers.consent[status])).toHaveAttribute('data-tone', tone);
  });

  it('gives the two plain states different glyphs, so they are told apart without reading', () => {
    const { container, rerender } = render(<ConsentChip status="none" />);
    const none = container.querySelector('svg')?.innerHTML;
    rerender(<ConsentChip status="express" />);
    const express = container.querySelector('svg')?.innerHTML;
    expect(none).toBeTruthy();
    expect(express).toBeTruthy();
    expect(none).not.toEqual(express);
  });
});
