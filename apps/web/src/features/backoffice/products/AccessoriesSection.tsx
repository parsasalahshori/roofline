import { type Accessory } from '@roofline/shared';
import { Button, Checkbox, Field, Icon, Select } from '@roofline/ui';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { emptyAccessory } from './catalog.ts';
import type { Draft } from './draft.ts';
import { DollarField, useCanEdit } from './fields.tsx';
import styles from './products.module.css';

const t = copy.products;
const PER: Accessory['per'][] = ['job', 'unit', 'linear-ft'];
const PER_LABEL: Record<Accessory['per'], string> = { job: t.perJob, unit: t.perUnitAcc, 'linear-ft': t.perLinearFt };

/** Job-level extras: disposal, capping, a permit. */
export function AccessoriesSection({ draft }: { draft: Draft }) {
  const canEdit = useCanEdit();
  const rows = draft.catalog.accessories;
  const edit = (id: string, patch: Partial<Accessory>) =>
    draft.change((catalog) => ({ ...catalog, accessories: catalog.accessories.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));

  return (
    <section aria-label={t.accessoriesTitle}>
      <p className="bo-foot">{t.accessoriesHelp}</p>
      {rows.length === 0 ? <p className="bo-foot bo-groupfoot">{t.noAccessories}</p> : null}
      {rows.length > 0 ? (
        <ul className="bo-group">
          {rows.map((acc, index) => {
            const n = index + 1;
            const key = (field: string) => `a:${acc.id}:${field}`;
            return (
              <li key={acc.id}>
                <div className={styles.editRow} data-archived={acc.archived || undefined}>
                  <div className={styles.editGrid}>
                    <Field label={t.accLabel(n)} labelHidden value={acc.label} error={draft.errors.get(key('label'))} disabled={!canEdit} onChange={(event) => edit(acc.id, { label: event.target.value })} />
                    <Select label={t.accPer(n)} value={acc.per} disabled={!canEdit} onChange={(per) => edit(acc.id, { per: per as Accessory['per'] })} options={PER.map((per) => ({ value: per, label: PER_LABEL[per] }))} />
                    <DollarField label={t.accPrice(n)} labelHidden value={acc.cents} error={draft.errors.get(key('cents'))} onChange={(value) => edit(acc.id, { cents: value })} />
                  </div>
                  <div className={styles.editMeta}>
                    <Checkbox label={t.accAuto(n)} checked={acc.autoAdd} disabled={!canEdit} onChange={(on) => edit(acc.id, { autoAdd: on })} />
                    {canEdit ? (
                      <Button variant="ghost" aria-label={acc.archived ? t.accRestore(n) : t.accArchive(n)} onClick={() => edit(acc.id, { archived: !acc.archived })}>
                        {acc.archived ? t.restore : t.archive}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {canEdit ? (
        <div className={styles.addRow}>
          <Button variant="ghost" onClick={() => draft.change((catalog) => ({ ...catalog, accessories: [...catalog.accessories, emptyAccessory()] }))}>
            <Icon name="plus" size={16} />
            {t.addAccessory}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
