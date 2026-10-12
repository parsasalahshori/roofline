import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_TIER_TEMPLATES, defaultPricebook, priceTier, toSurfaceArea } from '@roofline/shared';
import type { ProposalOptionView, Tier } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/app/providers.tsx';
import { proposals } from '../src/copy/proposals.ts';
import { OptionCard, quantitiesFor } from '../src/features/proposals/OptionCard.tsx';

const template = DEFAULT_TIER_TEMPLATES[0]!;
const base = { areaSqFt: 2480, areaType: 'surface' as const, pitch: 6, stories: 1, layers: 1, ridgeFt: 40, edgeFt: 120, valleyFt: 20, deckingSheets: 0, taxPercent: 0, markupPercent: 25 };

function makeOption(): ProposalOptionView {
  const q = quantitiesFor({ ...base, material: template.material, wastePercent: template.wastePercent });
  const priced = priceTier(template, base, defaultPricebook, q);
  return {
    id: 'o1', tier: template.tier as Tier, name: template.name, highlights: template.highlights, scope: priced.scope, addOns: template.addOns,
    calculation: priced.calculation, addOnLines: priced.addOnLines, totalCents: priced.totalCents, monthlyEstimateCents: 12300, enabled: true,
  };
}

function priceWith(patch: Partial<typeof template>) {
  const scope = { ...base, material: template.material, wastePercent: template.wastePercent };
  return priceTier({ ...template, ...patch }, base, defaultPricebook, quantitiesFor(scope)).totalCents;
}

function setup(over: Partial<React.ComponentProps<typeof OptionCard>> = {}) {
  const onChange = vi.fn();
  const option = makeOption();
  render(
    <Providers>
      <OptionCard option={option} editable basis="exact" prices={defaultPricebook} onChange={onChange} {...over} />
    </Providers>,
  );
  return { onChange, option };
}

describe('OptionCard', () => {
  afterEach(cleanup);

  it('quantitiesFor converts the area to squares', () => {
    const q = quantitiesFor({ ...base, material: 'architectural', wastePercent: 10 });
    expect(q.squares).toBe(toSurfaceArea(2480, 'surface', 6) / 100);
    expect(q.edgeFt).toBe(120);
  });

  it('shows the live total', () => {
    const { option } = setup();
    expect(screen.getAllByText(proposals.money(option.totalCents)).length).toBeGreaterThan(0);
  });

  it('commits waste on blur and re-prices', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    const field = screen.getByLabelText(proposals.fieldWaste);
    await user.clear(field);
    await user.type(field, '15');
    expect(screen.getAllByText(proposals.money(priceWith({ wastePercent: 15 }))).length).toBeGreaterThan(0);
    await user.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ wastePercent: 15 });
  });

  it('commits a material change at once', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.selectOptions(screen.getByLabelText(proposals.fieldMaterial), 'metal');
    expect(onChange).toHaveBeenCalledWith({ material: 'metal' });
  });

  it('adds, edits and removes add-ons', async () => {
    const user = userEvent.setup();
    const { onChange, option } = setup();
    await user.click(screen.getByRole('button', { name: proposals.addOnAdd }));
    const added = { name: proposals.addOnNewName, unit: 'per_job', rateCents: 0, taxable: false };
    const first = onChange.mock.calls[0]![0] as { addOns: unknown[] };
    expect(first.addOns.at(-1)).toEqual(added);
    expect(first.addOns).toHaveLength(option.addOns.length + 1);
    const rates = screen.getAllByLabelText(proposals.addOnRate);
    const rate = rates[rates.length - 1]!;
    await user.clear(rate);
    await user.type(rate, '100');
    await user.tab();
    const last = onChange.mock.calls.at(-1)![0] as { addOns: { rateCents: number }[] };
    expect(last.addOns.at(-1)!.rateCents).toBe(10000);
    onChange.mockClear();
    await user.click(screen.getByRole('button', { name: proposals.addOnRemove(proposals.addOnNewName) }));
    const after = onChange.mock.calls[0]![0] as { addOns: unknown[] };
    expect(after.addOns).toHaveLength(option.addOns.length);
  });

  it('toggles enabled', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(screen.getByRole('switch', { name: proposals.optionOn }));
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });

  it('renders no inputs when not editable', () => {
    setup({ editable: false });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('labels estimates only when the basis is estimate', () => {
    const { unmount } = render(
      <Providers>
        <OptionCard option={makeOption()} editable={false} basis="estimate" prices={defaultPricebook} onChange={vi.fn()} />
      </Providers>,
    );
    expect(screen.getAllByText(proposals.estimateLabel).length).toBeGreaterThan(0);
    unmount();
    setup({ basis: 'exact' });
    expect(screen.queryByText(proposals.estimateLabel)).toBeNull();
  });

  it('shows the saved total without prices', () => {
    const option = makeOption();
    setup({ prices: null, editable: false });
    expect(screen.getAllByText(proposals.money(option.totalCents)).length).toBeGreaterThan(0);
    expect(screen.getByText(proposals.pricesUnavailable)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
