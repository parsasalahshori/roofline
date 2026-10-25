import { TIERS } from '@roofline/shared';
import { Field } from '@roofline/ui';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import shared from '../backoffice.module.css';
import type { Draft } from './draft.ts';
import { NumField, useCanEdit } from './fields.tsx';

const t = copy.products;

/** Good, Better, Best names and notes; the markup; the most a rep may discount. */
export function RulesSection({ draft }: { draft: Draft }) {
  const canEdit = useCanEdit();
  const { catalog } = draft;
  return (
    <div>
      <h3 className="bo-grouphead">{t.tiersTitle}</h3>
      <div className={shared.card}>
        <div className={shared.grid}>
          {TIERS.map((tier) => (
            <div key={tier} className={shared.span}>
              <div className={shared.grid}>
                <Field
                  label={t.tierLabel(t.tierNames[tier])}
                  value={catalog.tiers[tier].label}
                  error={draft.errors.get('t:' + tier)}
                  disabled={!canEdit}
                  onChange={(event) => draft.change((c) => ({ ...c, tiers: { ...c.tiers, [tier]: { ...c.tiers[tier], label: event.target.value } } }))}
                />
                <Field
                  label={t.tierNote(t.tierNames[tier])}
                  value={catalog.tiers[tier].note}
                  disabled={!canEdit}
                  onChange={(event) => draft.change((c) => ({ ...c, tiers: { ...c.tiers, [tier]: { ...c.tiers[tier], note: event.target.value } } }))}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="bo-foot bo-groupfoot">{t.tiersHelp}</p>

      <h3 className="bo-grouphead">{t.rulesTitle}</h3>
      <div className={shared.card}>
        <div className={shared.grid}>
          <NumField label={t.markup} help={t.markupHelp} value={catalog.markupPercent} error={draft.errors.get('markup')} onChange={(value) => draft.change((c) => ({ ...c, markupPercent: value }))} />
          <NumField label={t.maxDiscount} help={t.maxDiscountHelp} value={catalog.maxRepDiscountPercent} error={draft.errors.get('maxDiscount')} onChange={(value) => draft.change((c) => ({ ...c, maxRepDiscountPercent: value }))} />
        </div>
      </div>
    </div>
  );
}
