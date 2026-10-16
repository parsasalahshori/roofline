import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_TIER_TEMPLATES, defaultPricebook, materialNames, priceTier, toSurfaceArea } from '@roofline/shared';
import type { ProposalOptionView, Tier } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../src/app/providers.tsx';
import { proposals } from '../src/copy/proposals.ts';
import { OptionCard, quantitiesFor } from '../src/features/proposals/OptionCard.tsx';
import { chooseFromListbox } from './crm-helpers.ts';

const template = DEFAULT_TIER_TEMPLATES[0]!;
const base = { areaSqFt: 2480, areaType: 'surface' as const, pitch: 6, stories: 1, layers: 1, ridgeFt: 40, edgeFt: 120, valleyFt: 20, deckingSheets: 0, taxPercent: 0, markupPercent: 25 };

function makeOption(tier: Tier = template.tier as Tier): ProposalOptionView {
  const q = quantitiesFor({ ...base, material: template.material, wastePercent: template.wastePercent });
  const priced = priceTier(template, base, defaultPricebook, q);
  return {
    id: 'o1', tier, name: template.name, highlights: template.highlights, scope: priced.scope, addOns: template.addOns,
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
    await chooseFromListbox(user, proposals.fieldMaterial, 'Standing seam metal');
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

  it('the recommended option is ringed and says so; the others are not', () => {
    const { unmount } = render(
      <Providers>
        <OptionCard option={makeOption('better')} editable basis="exact" prices={defaultPricebook} onChange={vi.fn()} />
      </Providers>,
    );
    const better = screen.getByRole('region', { name: proposals.optionHeading('better') });
    expect(better).toHaveAttribute('data-recommended', 'true');
    expect(within(better).getByText(proposals.recommended)).toBeInTheDocument();
    unmount();

    setup();
    const good = screen.getByRole('region', { name: proposals.optionHeading('good') });
    expect(good).not.toHaveAttribute('data-recommended');
    expect(screen.queryByText(proposals.recommended)).toBeNull();
  });

  it('under its name, one line: what it is made of and the waste it allows for', () => {
    const { option } = setup();
    expect(screen.getByText(proposals.specLine(materialNames[option.scope.material], option.scope.wastePercent))).toBeInTheDocument();
  });

  it('the total is the last thing in the card, after the price lines', () => {
    const { option } = setup();
    const card = screen.getByRole('region', { name: proposals.optionHeading(option.tier) });
    const total = within(card).getByText(proposals.totalLabel);
    const lines = within(card).getByText(proposals.linesHeading);
    expect(lines.compareDocumentPosition(total) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an option left out of the proposal says so in a tag, in the row', () => {
    const option = { ...makeOption(), enabled: false };
    render(
      <Providers>
        <OptionCard option={option} editable={false} basis="exact" prices={defaultPricebook} onChange={vi.fn()} />
      </Providers>,
    );
    expect(screen.getByText(proposals.optionLeftOut)).toBeInTheDocument();
    cleanup();

    setup({ editable: false });
    expect(screen.queryByText(proposals.optionLeftOut)).toBeNull();
  });

  it('with a way to pick it, the row is a radio that says whether it is the picked one and shows its price', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const option = makeOption();
    const { rerender } = render(
      <Providers>
        <OptionCard option={option} editable basis="exact" prices={defaultPricebook} onChange={vi.fn()} open={false} onSelect={onSelect} />
      </Providers>,
    );

    const radio = screen.getByRole('radio');
    expect(radio).not.toBeChecked();
    // The row is the radio's label: its name is the tier, the option's name and what it is made of, and its price
    expect(radio).toHaveAccessibleName(expect.stringContaining(option.name));
    expect(radio).toHaveAccessibleName(expect.stringContaining(proposals.money(option.totalCents)));
    await user.click(radio);
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender(
      <Providers>
        <OptionCard option={option} editable basis="exact" prices={defaultPricebook} onChange={vi.fn()} open onSelect={onSelect} />
      </Providers>,
    );
    expect(screen.getByRole('radio')).toBeChecked();
  });

  it('a row that is not picked shows only its heading: no fields, no lines, no total', () => {
    const option = makeOption();
    render(
      <Providers>
        <OptionCard option={option} editable basis="exact" prices={defaultPricebook} onChange={vi.fn()} open={false} onSelect={vi.fn()} />
      </Providers>,
    );
    // Hidden, not gone: what was typed stays while the other rows are looked at, but none of it can be reached
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText(proposals.totalLabel)).not.toBeVisible();
  });

  it('without a way to pick it (a phone, where tabs pick) the heading is not a radio and has no price', () => {
    setup();
    expect(screen.queryByRole('radio')).toBeNull();
    const card = screen.getByRole('region', { name: proposals.optionHeading(template.tier as Tier) });
    // The only price in the card is the total at its foot
    expect(within(card).getAllByText(proposals.money(makeOption().totalCents))).toHaveLength(1);
  });

  it('the price lines are a table with the amounts at the right', () => {
    const { option } = setup({ editable: false });
    const table = screen.getAllByRole('table')[0]!;
    expect(within(table).getAllByRole('row')).toHaveLength(option.calculation.lines.length + 1);
    expect(within(table).getByRole('columnheader', { name: proposals.lineAmount })).toHaveAttribute('data-numeric', 'true');
  });
});
