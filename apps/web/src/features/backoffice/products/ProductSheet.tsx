import {
  OPENING_KINDS,
  TIERS,
  UNIT_SHAPES,
  PRODUCT_KINDS,
  type OpeningKind,
  type Product,
  type ProductKind,
  type Tier,
  type UnitShape,
} from '@roofline/shared';
import { Button, Checkbox, Field, Segmented, Select, Table, Td, Th, Tr, IconButton, Icon } from '@roofline/ui';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { AppleSheet } from '../AppleSheet.tsx';
import shared from '../backoffice.module.css';
import { seedRule } from './catalog.ts';
import type { Draft } from './draft.ts';
import { DollarField, NumField, useCanEdit } from './fields.tsx';
import { OpeningSymbol } from './OpeningSymbol.tsx';
import styles from './products.module.css';

const t = copy.products;
const DOOR_OPENINGS = OPENING_KINDS.filter((kind) => kind.startsWith('door-'));
const WINDOW_OPENINGS = OPENING_KINDS.filter((kind) => !kind.startsWith('door-'));

const toggle = <T,>(list: T[], item: T, on: boolean): T[] => (on ? (list.includes(item) ? list : [...list, item]) : list.filter((entry) => entry !== item));

/** One product's form, in a side panel. Edits go straight into the price book being edited; Done closes the panel. */
export function ProductSheet({ draft, productId, onClose }: { draft: Draft; productId: string | null; onClose: () => void }) {
  const product = draft.catalog.products.find((p) => p.id === productId);
  return (
    <AppleSheet
      variant="inspector"
      open={product !== undefined}
      title={product ? t.sheetTitle(product.name) : ''}
      onClose={onClose}
      closeLabel={t.sheetClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t.sheetDone}
        </Button>
      }
    >
      {product ? <ProductForm draft={draft} product={product} /> : null}
    </AppleSheet>
  );
}

function ProductForm({ draft, product }: { draft: Draft; product: Product }) {
  const canEdit = useCanEdit();
  const key = (field: string) => `p:${product.id}:${field}`;
  const err = (field: string) => draft.errors.get(key(field));
  const edit = (patch: Partial<Product>) =>
    draft.change((catalog) => ({ ...catalog, products: catalog.products.map((p) => (p.id === product.id ? { ...p, ...patch } : p)) }));
  const tierName = (tier: Tier) => draft.catalog.tiers[tier].label;
  const openingChoices: readonly OpeningKind[] = product.kind === 'patio-door' ? DOOR_OPENINGS : WINDOW_OPENINGS;

  function setLimit(limit: keyof Product['limits'], value: number) {
    edit({ limits: { ...product.limits, [limit]: value } });
  }

  return (
    <div className={styles.form}>
      <div className={shared.grid}>
        <Field className={shared.span} label={t.fields.name} value={product.name} error={err('name')} disabled={!canEdit} onChange={(event) => edit({ name: event.target.value })} />
        <Select
          label={t.fields.kind}
          value={product.kind}
          disabled={!canEdit}
          onChange={(value) => {
            const kind = value as ProductKind;
            // Openings that do not belong to the other kind go away, so a window never keeps a door panel
            const keep = product.openings.filter((o) => o.startsWith('door-') === (kind === 'patio-door'));
            edit({ kind, openings: keep });
          }}
          options={PRODUCT_KINDS.map((kind) => ({ value: kind, label: t.kinds[kind] }))}
        />
        <NumField label={t.fields.maxSections} value={product.maxSections} error={err('maxSections')} onChange={(value) => edit({ maxSections: value })} />
        <Field className={shared.span} label={t.fields.description} multiline rows={2} value={product.description} disabled={!canEdit} onChange={(event) => edit({ description: event.target.value })} />
      </div>

      <fieldset className={styles.fieldset}>
        <legend>{t.fields.openings}</legend>
        <p className={shared.note}>{t.fields.openingsHelp}</p>
        <div className={styles.checks}>
          {openingChoices.map((opening) => (
            <Checkbox
              key={opening}
              checked={product.openings.includes(opening)}
              disabled={!canEdit}
              onChange={(on) => edit({ openings: toggle(product.openings, opening, on) })}
              label={
                <span className={styles.openingLabel}>
                  <OpeningSymbol kind={opening} />
                  {t.openingNames[opening]}
                </span>
              }
            />
          ))}
        </div>
        {err('openings') ? <p className={styles.error}>{err('openings')}</p> : null}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend>{t.fields.shapes}</legend>
        <div className={styles.checks}>
          {UNIT_SHAPES.map((shape: UnitShape) => (
            <Checkbox key={shape} checked={product.shapes.includes(shape)} disabled={!canEdit} onChange={(on) => edit({ shapes: toggle(product.shapes, shape, on) })} label={t.shapeNames[shape]} />
          ))}
        </div>
        {err('shapes') ? <p className={styles.error}>{err('shapes')}</p> : null}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend>{t.fields.limits}</legend>
        <div className={shared.grid}>
          <NumField label={t.fields.minWidth} value={product.limits.minWidthIn} error={err('minWidthIn')} onChange={(value) => setLimit('minWidthIn', value)} />
          <NumField label={t.fields.maxWidth} value={product.limits.maxWidthIn} error={err('maxWidthIn')} onChange={(value) => setLimit('maxWidthIn', value)} />
          <NumField label={t.fields.minHeight} value={product.limits.minHeightIn} error={err('minHeightIn')} onChange={(value) => setLimit('minHeightIn', value)} />
          <NumField label={t.fields.maxHeight} value={product.limits.maxHeightIn} error={err('maxHeightIn')} onChange={(value) => setLimit('maxHeightIn', value)} />
          <NumField label={t.fields.maxUnited} value={product.limits.maxUnitedIn} error={err('maxUnitedIn')} onChange={(value) => setLimit('maxUnitedIn', value)} />
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend>{t.fields.priceRule}</legend>
        <Segmented
          label={t.ruleKindLabel}
          value={product.price.kind}
          onChange={(kind) => {
            if (kind !== product.price.kind && canEdit) edit({ price: seedRule(kind) });
          }}
          options={[
            { value: 'united-inch', label: t.ruleKinds['united-inch'] },
            { value: 'sq-ft', label: t.ruleKinds['sq-ft'] },
          ]}
        />
        {product.price.kind === 'united-inch' ? <BreaksTable draft={draft} product={product} tierName={tierName} edit={edit} /> : <SqFtRates draft={draft} product={product} tierName={tierName} edit={edit} />}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend>{t.fields.perExtra}</legend>
        <div className={styles.threeUp}>
          {TIERS.map((tier) => (
            <DollarField
              key={tier}
              label={t.extraSection(tierName(tier))}
              value={product.perExtraSectionCents[tier]}
              error={err(`extra:${tier}`)}
              onChange={(value) => edit({ perExtraSectionCents: { ...product.perExtraSectionCents, [tier]: value } })}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}

type RuleProps = { draft: Draft; product: Product; tierName: (tier: Tier) => string; edit: (patch: Partial<Product>) => void };

function BreaksTable({ draft, product, tierName, edit }: RuleProps) {
  const canEdit = useCanEdit();
  if (product.price.kind !== 'united-inch') return null;
  const rule = product.price;
  const key = (field: string) => `p:${product.id}:${field}`;
  const setBreaks = (breaks: typeof rule.breaks) => edit({ price: { kind: 'united-inch', breaks } });
  const last = rule.breaks[rule.breaks.length - 1];

  return (
    <div className={styles.rule}>
      <p className={shared.note}>{t.breaksHelp}</p>
      <Table regionLabel={t.breaksTitle}>
        <thead>
          <tr>
            <Th>{t.colUpTo}</Th>
            {TIERS.map((tier) => (
              <Th key={tier} numeric>
                {tierName(tier)}
              </Th>
            ))}
            <Th>
              <span className={styles.srOnly}>{t.colActions}</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rule.breaks.map((row, index) => (
            <Tr key={index}>
              <Td>
                <NumField
                  label={t.breakUpTo(index + 1)}
                  labelHidden
                  value={row.maxUi}
                  error={draft.errors.get(key(`break:${index}:maxUi`))}
                  onChange={(value) => setBreaks(rule.breaks.map((r, i) => (i === index ? { ...r, maxUi: value } : r)))}
                />
              </Td>
              {TIERS.map((tier) => (
                <Td key={tier} numeric>
                  <DollarField
                    label={t.breakPrice(index + 1, tierName(tier))}
                    labelHidden
                    value={row.cents[tier]}
                    error={draft.errors.get(key(`break:${index}:${tier}`))}
                    onChange={(value) => setBreaks(rule.breaks.map((r, i) => (i === index ? { ...r, cents: { ...r.cents, [tier]: value } } : r)))}
                  />
                </Td>
              ))}
              <Td>
                {canEdit && rule.breaks.length > 1 ? (
                  <IconButton label={t.removeBreak(index + 1)} icon={<Icon name="x" size={16} />} onClick={() => setBreaks(rule.breaks.filter((_, i) => i !== index))} />
                ) : null}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {draft.errors.get(key('breaks')) ? <p className={styles.error}>{draft.errors.get(key('breaks'))}</p> : null}
      {canEdit ? (
        <Button
          variant="default"
          size="sm"
          onClick={() =>
            setBreaks([...rule.breaks, { maxUi: last && Number.isFinite(last.maxUi) ? last.maxUi + 10 : 100, cents: last ? { ...last.cents } : { good: 0, better: 0, best: 0 } }])
          }
        >
          <Icon name="plus" size={16} />
          {t.addBreak}
        </Button>
      ) : null}
    </div>
  );
}

function SqFtRates({ draft, product, tierName, edit }: RuleProps) {
  if (product.price.kind !== 'sq-ft') return null;
  const rule = product.price;
  const key = (field: string) => `p:${product.id}:${field}`;
  return (
    <div className={styles.rule}>
      <div className={styles.threeUp}>
        {TIERS.map((tier) => (
          <DollarField
            key={'rate' + tier}
            label={t.sqFtRate(tierName(tier))}
            value={rule.centsPerSqFt[tier]}
            error={draft.errors.get(key(`rate:${tier}`))}
            onChange={(value) => edit({ price: { ...rule, centsPerSqFt: { ...rule.centsPerSqFt, [tier]: value } } })}
          />
        ))}
        {TIERS.map((tier) => (
          <DollarField
            key={'min' + tier}
            label={t.sqFtMin(tierName(tier))}
            value={rule.minimumCents[tier]}
            error={draft.errors.get(key(`min:${tier}`))}
            onChange={(value) => edit({ price: { ...rule, minimumCents: { ...rule.minimumCents, [tier]: value } } })}
          />
        ))}
      </div>
    </div>
  );
}
