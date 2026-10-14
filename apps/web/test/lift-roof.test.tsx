import { instantEstimate, type Calculation, type Ring } from '@roofline/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { legal } from '../src/copy/legal.ts';
import { liftMeasure, liftProposal } from '../src/copy/liftMeasure.ts';
import { parseCaptureDate } from '../src/features/measure/lift/aerial.ts';
import { cardCells, cardNumbers, MeasureCard } from '../src/features/measure/lift/MeasureCard.tsx';
import { panelLines, squaresFor, wholeDollars } from '../src/features/measure/lift/proposalLines.ts';
import { ProposalPanel } from '../src/features/measure/lift/ProposalPanel.tsx';
import { facetLetter, facetsData, lineKinds, linesData, readRoof } from '../src/features/measure/lift/roofModel.ts';
import { footprintsShown, ringCenter, scaleBarFor } from '../src/features/measure/lift/RoofView.tsx';
import { roofPhotoFor } from '../src/features/measure/lift/roofPhoto.ts';
import { shownShare, stageAt, type ScanSession } from '../src/features/measure/lift/scan.ts';
import type { MeasurementPreview, MeasurementView, PreviewOption } from '../src/features/measure/types.ts';
import { gableRoof } from './roof-model-fixture.ts';

const LNG = -96.8;
const LAT = 32.8;
const ring: Ring = [
  [LNG - 0.0001, LAT - 0.0001],
  [LNG + 0.0001, LAT - 0.0001],
  [LNG + 0.0001, LAT + 0.0001],
  [LNG - 0.0001, LAT + 0.0001],
];

function view(over: Partial<MeasurementView> = {}): MeasurementView {
  return {
    id: 'm1',
    propertyId: 'p1',
    jobId: null,
    kind: 'estimate',
    method: 'outline',
    drawMode: false,
    outline: [ring],
    structures: [],
    overhangFt: 1,
    center: [LNG, LAT],
    estimate: instantEstimate({ outline: [ring], pitchX12: 6, overhangFt: 1, valleyFt: 12 }),
    facets: null,
    providerRef: null,
    notes: null,
    createdAt: '2026-10-12T12:00:00.000Z',
    locked: false,
    hasCustomer: true,
    roof: null,
    ...over,
  };
}

const scanAt = (phase: ScanSession['phase'], progress: number): ScanSession => ({
  phase,
  progress,
  elapsedMs: progress * 4800,
  totalMs: 4800,
  facets: 2,
  start: () => undefined,
  restart: () => undefined,
});

function calculation(): Calculation {
  return {
    surfaceAreaSqFt: 3230,
    roofSquares: 32.3,
    materialBundles: 107,
    orderedSquares: 35.6,
    lines: [
      { code: 'material', name: 'Architectural shingles', quantity: 107, unit: 'bundle', unitCents: 4200, totalCents: 449400, taxable: true },
      { code: 'underlayment', name: 'Synthetic underlayment', quantity: 35.6, unit: 'sq', unitCents: 2400, totalCents: 85440, taxable: true },
      { code: 'labor', name: 'Roof installation', quantity: 32.3, unit: 'sq', unitCents: 13500, totalCents: 436050, taxable: false },
      { code: 'permit', name: 'Permit allowance', quantity: 1, unit: 'job', unitCents: 25000, totalCents: 25000, taxable: false },
    ],
    subtotalCents: 995890,
    markupCents: 248973,
    taxCents: 0,
    totalCents: 1244863,
  };
}

function option(tier: PreviewOption['tier'], totalCents: number): PreviewOption {
  return {
    tier,
    name: `${tier} shingles`,
    highlights: ['Shingles', 'Synthetic underlayment', 'Tear-off and cleanup'],
    material: 'architectural',
    wastePercent: 10,
    enabled: true,
    calculation: calculation(),
    addOnLines: [],
    totalCents,
    monthlyEstimateCents: Math.round(totalCents / 76),
  };
}

const preview: MeasurementPreview = {
  addressLine: '410 Truss Ave',
  city: 'Omaha',
  state: 'NE',
  customerName: 'Carmen Castellano',
  hailIn: 2.5,
  options: [option('good', 1917000), option('better', 2343000), option('best', 3798500)],
  financing: { aprBps: 999, months: 120 },
};

afterEach(() => cleanup());

describe('the roof model', () => {
  it('is read off the measurement only when it has facets', () => {
    expect(readRoof(view())).toBeNull();
    expect(readRoof({ ...view(), roof: null } as MeasurementView)).toBeNull();
    const roof = gableRoof(ring as [number, number][]);
    expect(readRoof({ ...view(), roof } as MeasurementView)).toBe(roof);
  });

  it('turns facets into closed polygons and lines into coloured segments', () => {
    const roof = gableRoof(ring as [number, number][]);
    const facets = facetsData(roof).features;
    expect(facets).toHaveLength(2);
    const first = facets[0]!.geometry.coordinates[0]!;
    expect(first[0]).toEqual(first.at(-1));
    const lines = linesData(roof).features;
    expect(lines.map((l) => l.properties.kind)).toEqual(['ridge', 'eave', 'eave', 'rake', 'rake']);
    expect(lines[0]!.properties.color).toBe('#ff5c50');
  });

  it('names facets A, B, C and lists hips in the legend only when the roof has them', () => {
    expect([0, 1, 25, 26].map(facetLetter)).toEqual(['A', 'B', 'Z', 'AA']);
    const roof = gableRoof(ring as [number, number][]);
    expect(lineKinds(roof)).toEqual(['ridge', 'valley', 'eave', 'rake']);
    roof.lines.push({ kind: 'hip', coords: [ring[0] as [number, number], ring[2] as [number, number]], lengthFt: 12 });
    expect(lineKinds(roof)).toEqual(['ridge', 'hip', 'valley', 'eave', 'rake']);
  });
});

describe('the scan', () => {
  it('finds, traces, reads and prices, in that order', () => {
    expect([0, 0.29, 0.31, 0.6, 0.9].map(stageAt)).toEqual(['finding', 'finding', 'tracing', 'reading', 'pricing']);
  });

  it('counts the numbers up from nothing to all of them', () => {
    expect(shownShare(0)).toBe(0);
    expect(shownShare(0.3)).toBe(0);
    expect(shownShare(0.6)).toBeGreaterThan(0);
    expect(shownShare(0.9)).toBe(1);
    expect(shownShare(1)).toBe(1);
  });
});

describe('the measure card', () => {
  it('shows the roof totals, waste and every line kind with its colour once measured', () => {
    const m = view();
    const numbers = cardNumbers(m, m.estimate, gableRoof(ring as [number, number][]), null);
    render(<MeasureCard m={m} numbers={numbers} scan={scanAt('done', 1)} outlineOnly={false} editing={false} onEdit={() => undefined} panels={null} />);
    expect(screen.getByText(liftMeasure.measuredBy)).toBeTruthy();
    expect(screen.getByText(liftMeasure.measuredIn(4.8))).toBeTruthy();
    expect(screen.getByText('13.4')).toBeTruthy();
    expect(screen.getByText(liftMeasure.sloped(1342))).toBeTruthy();
    const cells = [...document.querySelectorAll('[data-stat]')].map((el) => el.getAttribute('data-stat'));
    expect(cells).toEqual(['pitch', 'facets', 'waste', 'ridges', 'hips', 'valleys', 'eaves', 'rakes']);
    expect(screen.getByText('10%')).toBeTruthy();
    expect(screen.getByText(liftMeasure.feet(90))).toBeTruthy();
    expect(screen.getByRole('button', { name: liftMeasure.remeasure })).toBeTruthy();
  });

  it('reads 0 and "Reading" while the scan finds the roof, with the stage and a seconds counter', () => {
    const m = view();
    const numbers = cardNumbers(m, m.estimate, gableRoof(ring as [number, number][]), null);
    render(<MeasureCard m={m} numbers={numbers} scan={scanAt('scanning', 0.1)} outlineOnly={false} editing={false} onEdit={() => undefined} panels={null} />);
    expect(screen.getByText(liftMeasure.stage.finding)).toBeTruthy();
    expect(screen.getByText(liftMeasure.seconds(0.48))).toBeTruthy();
    expect(screen.getByText('0.0')).toBeTruthy();
    expect(screen.getByText(liftMeasure.pitchReading)).toBeTruthy();
    expect(screen.queryByRole('button', { name: liftMeasure.remeasure })).toBeNull();
  });

  it('without facets says so and shows the outline estimate, never inventing hips, eaves or rakes', () => {
    const m = view();
    const numbers = cardNumbers(m, m.estimate, null, 12);
    expect(cardCells(numbers, 1, true).map((c) => c.key)).toEqual(['pitch', 'facets', 'waste', 'ridges', 'valleys', 'edges']);
    render(<MeasureCard m={m} numbers={numbers} scan={scanAt('done', 1)} outlineOnly editing={false} onEdit={() => undefined} panels={<p>Panels</p>} />);
    expect(screen.getByText(liftMeasure.outlineOnly)).toBeTruthy();
    expect(screen.queryByText(/Hips|Eaves|Rakes/)).toBeNull();
    expect(screen.getByText('12%')).toBeTruthy();
  });

  it('says when the pitch is from Google Solar, and not otherwise', () => {
    const solar = view({ pitchSource: 'solar' });
    const numbers = cardNumbers(solar, solar.estimate, gableRoof(ring as [number, number][]), null);
    const { rerender } = render(
      <MeasureCard m={solar} numbers={numbers} scan={scanAt('done', 1)} outlineOnly={false} editing={false} onEdit={() => undefined} panels={null} />,
    );
    expect(screen.getByText(legal.solarPitchAttribution)).toBeTruthy();
    rerender(<MeasureCard m={solar} numbers={numbers} scan={scanAt('scanning', 0.2)} outlineOnly={false} editing={false} onEdit={() => undefined} panels={null} />);
    expect(screen.queryByText(legal.solarPitchAttribution)).toBeNull();
    const manual = view({ pitchSource: 'manual' });
    rerender(<MeasureCard m={manual} numbers={numbers} scan={scanAt('done', 1)} outlineOnly={false} editing={false} onEdit={() => undefined} panels={null} />);
    expect(screen.queryByText(legal.solarPitchAttribution)).toBeNull();
  });

  it('a roof measured in 3D says so, and says plainly when it needs review', () => {
    const roof3d = { version: 1 as const, outline: ring, faces: [], lines: [], pixelSizeM: 0.1, imageryQuality: 'HIGH', imageryDate: null };
    const good = view({ pitchSource: 'solar-3d', roof3d, needsReview: null });
    const numbers = cardNumbers(good, good.estimate, gableRoof(ring as [number, number][]), null);
    const { rerender } = render(
      <MeasureCard m={good} numbers={numbers} scan={scanAt('done', 1)} outlineOnly={false} editing={false} onEdit={() => undefined} panels={null} />,
    );
    expect(screen.getByText(legal.solar3dAttribution)).toBeTruthy();
    expect(screen.queryByText(liftMeasure.needsReview)).toBeNull();
    const shaky = view({ pitchSource: 'solar-3d', roof3d, needsReview: { reasons: ['trees', 'outline-off'] } });
    rerender(<MeasureCard m={shaky} numbers={numbers} scan={scanAt('done', 1)} outlineOnly={false} editing={false} onEdit={() => undefined} panels={null} />);
    expect(screen.getByText(liftMeasure.needsReview)).toBeTruthy();
    expect(screen.getByText(liftMeasure.reviewReason.trees)).toBeTruthy();
    expect(screen.getByText(liftMeasure.reviewReason['outline-off'])).toBeTruthy();
  });

  it("shows Google's roof photo only over Google's tiles, and credits Microsoft only while its outlines show", () => {
    const corners: [[number, number], [number, number], [number, number], [number, number]] = [ring[3]!, ring[2]!, ring[1]!, ring[0]!];
    const m = view({ roofPhoto: { url: '/api/measurements/m1/roof-photo', corners } });
    expect(roofPhotoFor(m, true)).toEqual({ url: '/api/measurements/m1/roof-photo', corners });
    expect(roofPhotoFor(m, false)).toBeNull();
    expect(roofPhotoFor(view(), true)).toBeNull();
    const roof3d = { version: 1 as const, outline: ring, faces: [], lines: [], pixelSizeM: 0.1, imageryQuality: 'HIGH', imageryDate: null };
    const shed = { footprintId: '2', included: false, areaSqFt: 120, ring };
    expect(footprintsShown(view(), false)).toBe(true);
    expect(footprintsShown(view({ roof3d }), false)).toBe(false);
    expect(footprintsShown(view({ roof3d, structures: [{ ...shed, footprintId: '1', included: true, main: true }] }), true)).toBe(false);
    expect(footprintsShown(view({ roof3d, structures: [{ ...shed, footprintId: '1', included: true, main: true }, shed] }), true)).toBe(true);
  });

  it('Adjust opens the controls', () => {
    const m = view();
    let editing = false;
    const numbers = cardNumbers(m, m.estimate, null, null);
    const { rerender } = render(
      <MeasureCard m={m} numbers={numbers} scan={scanAt('done', 1)} outlineOnly editing={editing} onEdit={(next) => (editing = next)} panels={<p>Panels</p>} />,
    );
    expect(screen.queryByText('Panels')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: liftMeasure.adjust }));
    expect(editing).toBe(true);
    rerender(<MeasureCard m={m} numbers={numbers} scan={scanAt('done', 1)} outlineOnly editing={editing} onEdit={(next) => (editing = next)} panels={<p>Panels</p>} />);
    expect(screen.getByText('Panels')).toBeTruthy();
  });
});

describe('the proposal panel', () => {
  it('spreads the markup over the lines, splits materials from labor, and adds tax when there is any', () => {
    const o = option('better', 2343000);
    const { materials, labor } = panelLines(o);
    expect(materials.map((l) => l.key)).toEqual(['material', 'underlayment']);
    expect(labor.map((l) => l.key)).toEqual(['labor', 'permit']);
    const sum = [...materials, ...labor].reduce((s, l) => s + l.cents, 0);
    expect(Math.abs(sum - (o.calculation.subtotalCents + o.calculation.markupCents))).toBeLessThanOrEqual(4);
    expect(materials[0]!.quantity).toBe('107 bundles');
    const taxed = { ...o, calculation: { ...o.calculation, taxCents: 5000 } };
    expect(panelLines(taxed).labor.at(-1)).toEqual({ key: 'tax', name: liftProposal.tax, quantity: '', cents: 5000 });
    expect(squaresFor(o).ordered).toBeCloseTo(35.53, 2);
  });

  it('shows Good, Better (recommended, picked) and Best with prices, then the picked tier’s lines and total', () => {
    render(<ProposalPanel preview={preview} pending={false} failed={false} customerName={null} controls={null} footer={<p>Footer</p>} />);
    expect(screen.getByText(liftProposal.title('Carmen'))).toBeTruthy();
    expect(screen.getByText(liftProposal.builtBy)).toBeTruthy();
    expect(screen.getByText(liftProposal.squaresLine(35.53, 32.3, 10))).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(screen.getByText(liftProposal.recommended)).toBeTruthy();
    expect(screen.getByText(liftProposal.totalFor('Better'))).toBeTruthy();
    expect(screen.getAllByText(wholeDollars(2343000)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(liftProposal.materialsFor('Better'))).toBeTruthy();
    expect(screen.getByText(/at 9\.99% APR for 120 months/)).toBeTruthy();
    fireEvent.click(radios[2]!);
    expect(screen.getByText(liftProposal.totalFor('Best'))).toBeTruthy();
    expect(screen.getByText('Footer')).toBeTruthy();
  });

  it('shows no prices for a rep (the preview has none)', () => {
    render(<ProposalPanel preview={{ ...preview, options: null }} pending={false} failed={false} customerName="Dana Homeowner" controls={null} footer={null} />);
    expect(screen.getByText(liftProposal.title('Dana'))).toBeTruthy();
    expect(screen.getByText(liftProposal.noPrices)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('map helpers', () => {
  it('picks a round number of feet that fits the bar', () => {
    const { feet, widthPx } = scaleBarFor(LAT, 20);
    expect(feet).toBe(20);
    expect(widthPx).toBeGreaterThan(0);
    expect(widthPx).toBeLessThanOrEqual(110);
    expect(scaleBarFor(LAT, 18).feet).toBeGreaterThan(feet);
  });

  it('puts a label at the average of the corners', () => {
    expect(ringCenter([[0, 0], [2, 0], [2, 2], [0, 2]])).toEqual([1, 1]);
  });

  it('reads the imagery service’s capture dates', () => {
    expect(parseCaptureDate('3/13/2025')?.toDateString()).toBe(new Date(2025, 2, 13).toDateString());
    expect(parseCaptureDate('20250313')?.getMonth()).toBe(2);
    expect(parseCaptureDate('Null')).toBeNull();
  });
});
