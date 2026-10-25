import { OPTION_GROUPS, styleOfDesign, temperedSuggestions, type DesignIssue, type Layout, type OptionGroup, type ProductCatalog, type SafetyAnswers, type Tier, type WindowDesign } from '@roofline/shared';
import { Banner, Button, Icon, Segmented } from '@roofline/ui';
import { useState } from 'react';
import { backofficeDesigner as copy } from '../../../copy/backofficeDesigner.ts';
import { formatInches } from '../drawing/inches.ts';
import { listSections, mergeSection, placeSections, sectionCount, setSection, splitSection } from '../drawing/layout.ts';
import { changeProduct, chooseOption, GRID_PATTERNS } from './designs.ts';
import { EditableDrawing } from './EditableDrawing.tsx';
import { chosenOption, choicesFor, dollars, productOf, unitPriceCents } from './pricing.ts';
import { Group, InchesRow, Row, SelectRow, Stepper, TextRow } from './primitives.tsx';
import styles from './UnitInspector.module.css';

type Props = {
  design: WindowDesign;
  catalog: ProductCatalog;
  tier: Tier;
  issues: DesignIssue[];
  onChange: (next: WindowDesign) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
};

type YesNo = 'yes' | 'no' | 'unsure';
const toYesNo = (v: boolean | null): YesNo => (v === true ? 'yes' : v === false ? 'no' : 'unsure');
const fromYesNo = (v: YesNo): boolean | null => (v === 'yes' ? true : v === 'no' ? false : null);

/** A number in a row (blank = not answered). */
function NumberRow({ label, value, onChange }: { label: string; value: number | null; onChange: (n: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value === null ? '' : String(value));
  }
  return (
    <Row label={label}>
      <input
        style={{ width: '100%', minHeight: 32, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'right' }}
        inputMode="decimal"
        aria-label={label}
        value={text}
        placeholder={copy.unanswered}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          onChange(e.target.value.trim() === '' ? null : Number.isFinite(n) && n >= 0 ? n : value);
        }}
      />
    </Row>
  );
}

/** The unit editor: a right-side inspector on a tablet or desktop, a bottom sheet on a phone (the page's CSS decides). */
export function UnitInspector({ design, catalog, tier, issues, onChange, onDuplicate, onDelete, onClose }: Props) {
  const product = productOf(catalog, design.productId);
  const sections = listSections(design.layout);
  const [sectionId, setSectionId] = useState(sections[0]!.id);
  const selected = sections.find((s) => s.id === sectionId) ?? sections[0]!;
  const placed = placeSections(design.layout, design.widthIn, design.heightIn);
  const selectedRect = placed.find((p) => p.id === selected.id)?.rect;
  const [parts, setParts] = useState(2);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const total = sectionCount(design.layout);
  const maxParts = Math.max((product?.maxSections ?? 1) - total + 1, 1);
  const partCount = Math.min(Math.max(parts, 2), Math.max(maxParts, 2));
  const canSplit = product !== undefined && maxParts >= 2;

  const set = (patch: Partial<WindowDesign>) => onChange({ ...design, ...patch });
  const setLayout = (layout: Layout) => onChange({ ...design, layout });
  const split = (direction: 'columns' | 'rows') => {
    const next = splitSection(design.layout, selected.id, direction, partCount, design.widthIn, design.heightIn);
    if (next !== design.layout) setLayout(next);
  };

  const suggestions = temperedSuggestions({ safety: design.safety, style: styleOfDesign(design, product) }, { widthIn: design.widthIn, heightIn: design.heightIn });
  const temperedChoices = choicesFor(catalog, 'tempered', design.productId);
  const temperedPick = temperedChoices[temperedChoices.length - 1];
  const temperedOn = chosenOption(catalog, design, 'tempered') !== undefined;
  const safety = (patch: Partial<SafetyAnswers>) => set({ safety: { ...design.safety, ...patch } });
  const unitCents = unitPriceCents(catalog, design, tier);
  // The safety-glass warning has its own block below, with the button
  const shownIssues = issues.filter((i) => i.field !== 'safety');
  const frameColor = chosenOption(catalog, design, 'exterior-color')?.value;
  const productOptions = catalog.products.filter((p) => !p.archived || p.id === design.productId).map((p) => ({ value: p.id, label: p.archived ? copy.archivedProduct(p.name) : p.name }));
  const gridOptions = [...new Set([...GRID_PATTERNS, ...sections.flatMap((s) => s.grid.split('/'))])].map((p) => ({ value: p, label: p === '' ? copy.gridNone : copy.gridPattern(p) }));
  const sashes = selected.grid.split('/');
  const hung = selected.opening === 'hung-sash';
  const gridValue = (i: 0 | 1) => (i === 1 ? (sashes[1] ?? sashes[0] ?? '') : (sashes[0] ?? ''));

  return (
    <div className={styles.inspector}>
      <header className={styles.bar}>
        <div className={styles.barText}>
          <h2 className={styles.title}>{design.label}</h2>
          <p className={styles.sub}>{copy.priceEach(dollars(unitCents), catalog.tiers[tier].label)}</p>
        </div>
        <Button variant="primary" size="sm" onClick={onClose}>
          {copy.done}
        </Button>
      </header>

      <div className={styles.body}>
        {shownIssues.length > 0 ? (
          <div className={styles.issues}>
            {shownIssues.map((issue) => (
              <Banner key={`${issue.field}-${issue.message}`} tone={issue.level === 'error' ? 'danger' : 'warning'}>
                {issue.message}
              </Banner>
            ))}
          </div>
        ) : null}

        <EditableDrawing design={design} frameColorValue={frameColor} selectedSectionId={selected.id} onSelectSection={setSectionId} onLayout={setLayout} />
        <p className={styles.hint}>{copy.drawingHint}</p>

        <Group title={copy.groups.unit}>
          <TextRow label={copy.fields.room} value={design.label} onChange={(label) => set({ label })} />
          <SelectRow label={copy.fields.product} value={design.productId} options={productOptions} onChange={(id) => onChange(changeProduct(catalog, design, id))} />
          <SelectRow label={copy.fields.shape} value={design.shape} options={(product?.shapes ?? ['rect']).map((s) => ({ value: s, label: copy.shapes[s] }))} onChange={(shape) => set({ shape: shape as WindowDesign['shape'] })} />
          <Row label={copy.fields.quantity} as="div">
            <Stepper label={copy.fields.quantity} value={design.quantity} min={1} max={99} onChange={(quantity) => set({ quantity })} minusLabel={copy.fewer} plusLabel={copy.more} />
          </Row>
        </Group>

        <Group title={copy.groups.size} footer={design.sizeSource.kind === 'measured' ? copy.fromMeasurementNote : copy.sizeNote(product ? formatInches(product.limits.maxWidthIn) : '', product ? formatInches(product.limits.maxHeightIn) : '')}>
          <InchesRow label={copy.fields.width} value={design.widthIn} disabled={design.sizeSource.kind === 'measured'} unit={copy.inches} onCommit={(widthIn) => set({ widthIn })} />
          <InchesRow label={copy.fields.height} value={design.heightIn} disabled={design.sizeSource.kind === 'measured'} unit={copy.inches} onCommit={(heightIn) => set({ heightIn })} />
          {design.sizeSource.kind === 'measured' ? (
            <Row label={copy.fromMeasurement} as="div">
              <Button variant="quiet" size="sm" onClick={() => set({ sizeSource: { kind: 'typed' } })}>
                {copy.typeASize}
              </Button>
            </Row>
          ) : null}
        </Group>

        <Group title={copy.groups.sections} footer={selectedRect ? copy.sectionFooter(sections.indexOf(selected) + 1, total, formatInches(selectedRect.w), formatInches(selectedRect.h)) : undefined}>
          <SelectRow label={copy.fields.opening} value={selected.opening} options={(product?.openings ?? [selected.opening]).map((o) => ({ value: o, label: copy.openings[o] }))} onChange={(opening) => setLayout(setSection(design.layout, selected.id, { opening: opening as typeof selected.opening }))} />
          {hung ? (
            <>
              <SelectRow label={copy.fields.gridTop} value={gridValue(0)} options={gridOptions} onChange={(top) => setLayout(setSection(design.layout, selected.id, { grid: `${top}/${gridValue(1)}` === '/' ? '' : `${top}/${gridValue(1)}` }))} />
              <SelectRow label={copy.fields.gridBottom} value={gridValue(1)} options={gridOptions} onChange={(bottom) => setLayout(setSection(design.layout, selected.id, { grid: `${gridValue(0)}/${bottom}` === '/' ? '' : `${gridValue(0)}/${bottom}` }))} />
            </>
          ) : (
            <SelectRow label={copy.fields.grid} value={gridValue(0)} options={gridOptions} onChange={(grid) => setLayout(setSection(design.layout, selected.id, { grid }))} />
          )}
          <Row label={copy.fields.parts} as="div">
            <Stepper label={copy.fields.parts} value={partCount} min={2} max={Math.max(maxParts, 2)} onChange={setParts} minusLabel={copy.fewer} plusLabel={copy.more} />
          </Row>
          <div className={styles.splitButtons}>
            <Button variant="default" disabled={!canSplit} onClick={() => split('columns')}>
              <Icon name="layers" size={18} />
              {copy.splitColumns}
            </Button>
            <Button variant="default" disabled={!canSplit} onClick={() => split('rows')}>
              <Icon name="layers" size={18} />
              {copy.splitRows}
            </Button>
          </div>
          {total > 1 ? (
            <div className={styles.splitButtons}>
              <Button variant="quiet" onClick={() => setLayout(mergeSection(design.layout, selected.id))}>
                <Icon name="undo" size={18} />
                {copy.mergeSections}
              </Button>
            </div>
          ) : null}
        </Group>

        <Group title={copy.groups.options}>
          {OPTION_GROUPS.map((group: OptionGroup) => {
            const choices = choicesFor(catalog, group, design.productId);
            if (choices.length === 0) return null;
            const none = choices.some((c) => c.isDefault) || group === 'grid' || group === 'screen' ? [] : [{ value: '', label: copy.optionNone }];
            return <SelectRow key={group} label={copy.optionGroups[group]} value={chosenOption(catalog, design, group)?.id ?? ''} options={[...none, ...choices.map((c) => ({ value: c.id, label: c.label }))]} onChange={(id) => onChange(chooseOption(catalog, design, group, id))} />;
          })}
        </Group>

        <Group title={copy.groups.safety} footer={copy.safetyNote}>
          <Row label={copy.safety.besideDoor} as="div">
            <Segmented<YesNo> label={copy.safety.besideDoor} size="sm" value={toYesNo(design.safety.besideDoor)} onChange={(v) => safety({ besideDoor: fromYesNo(v) })} options={yesNoOptions()} />
          </Row>
          <Row label={copy.safety.wetArea} as="div">
            <Segmented<YesNo> label={copy.safety.wetArea} size="sm" value={toYesNo(design.safety.wetArea)} onChange={(v) => safety({ wetArea: fromYesNo(v) })} options={yesNoOptions()} />
          </Row>
          <NumberRow label={copy.safety.sillHeight} value={design.safety.sillHeightIn} onChange={(sillHeightIn) => safety({ sillHeightIn })} />
          <Row label={copy.safety.walkway} as="div">
            <Segmented<YesNo> label={copy.safety.walkway} size="sm" value={toYesNo(design.safety.walkway)} onChange={(v) => safety({ walkway: fromYesNo(v) })} options={yesNoOptions()} />
          </Row>
        </Group>
        {suggestions.length > 0 && !temperedOn ? (
          <div className={styles.suggestion} role="status">
            {suggestions.map((s) => (
              <p key={s.rule}>{s.message}</p>
            ))}
            {temperedPick ? (
              <Button variant="primary" size="sm" onClick={() => onChange(chooseOption(catalog, design, 'tempered', temperedPick.id))}>
                {copy.useTempered}
              </Button>
            ) : null}
          </div>
        ) : null}

        <Group title={copy.groups.notes}>
          <label className={styles.notes}>
            <span className={styles.srOnly}>{copy.fields.notes}</span>
            <textarea rows={3} value={design.notes} placeholder={copy.notesPlaceholder} onChange={(e) => set({ notes: e.target.value })} />
          </label>
        </Group>

        <Group>
          <div className={styles.actionRow}>
            <Button variant="quiet" onClick={onDuplicate}>
              <Icon name="layers" size={18} />
              {copy.duplicateUnit}
            </Button>
          </div>
          {confirmDelete ? (
            <div className={styles.actionRow}>
              <Button variant="danger" onClick={onDelete}>
                {copy.confirmDelete(design.label)}
              </Button>
              <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
                {copy.cancel}
              </Button>
            </div>
          ) : (
            <div className={styles.actionRow}>
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Icon name="x" size={18} />
                {copy.deleteUnit}
              </Button>
            </div>
          )}
        </Group>
      </div>
    </div>
  );
}

function yesNoOptions() {
  return [
    { value: 'yes' as const, label: copy.yes },
    { value: 'no' as const, label: copy.no },
    { value: 'unsure' as const, label: copy.unsure },
  ];
}
