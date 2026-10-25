import { OPTION_GROUPS, type OptionChoice, type OptionGroup } from '@roofline/shared';
import { Button, Checkbox, Field, Icon, Select } from '@roofline/ui';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { emptyOption } from './catalog.ts';
import type { Draft } from './draft.ts';
import { DollarField, useCanEdit } from './fields.tsx';
import styles from './products.module.css';

const t = copy.products;
const PER: OptionChoice['adder']['per'][] = ['unit', 'section', 'lite', 'sq-ft'];
const PER_LABEL: Record<OptionChoice['adder']['per'], string> = { unit: t.perUnit, section: t.perSection, lite: t.perLite, 'sq-ft': t.perSqFt };

/** The choices a customer picks on a unit, one group after another. */
export function OptionsSection({ draft }: { draft: Draft }) {
  return (
    <div>
      <p className="bo-foot">{t.optionsHelp}</p>
      {OPTION_GROUPS.map((group) => (
        <Group key={group} draft={draft} group={group} />
      ))}
    </div>
  );
}

function Group({ draft, group }: { draft: Draft; group: OptionGroup }) {
  const canEdit = useCanEdit();
  const groupName = t.optionGroups[group];
  const rows = draft.catalog.options.filter((o) => o.group === group);

  const edit = (id: string, patch: Partial<OptionChoice>) =>
    draft.change((catalog) => ({ ...catalog, options: catalog.options.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
  const makeDefault = (id: string, on: boolean) =>
    draft.change((catalog) => ({
      ...catalog,
      options: catalog.options.map((o) => (o.group !== group ? o : o.id === id ? { ...o, isDefault: on } : on ? { ...o, isDefault: false } : o)),
    }));

  return (
    <section aria-label={groupName}>
      <h3 className="bo-grouphead">{groupName}</h3>
      {rows.length === 0 ? <p className="bo-foot bo-groupfoot">{t.noOptions}</p> : null}
      {rows.length > 0 ? (
        <ul className="bo-group">
          {rows.map((option, index) => {
            const n = index + 1;
            const key = (field: string) => `o:${option.id}:${field}`;
            return (
              <li key={option.id}>
                <div className={styles.editRow} data-archived={option.archived || undefined}>
                  <div className={styles.editGrid}>
                    <Field label={t.optionLabel(groupName, n)} labelHidden value={option.label} error={draft.errors.get(key('label'))} disabled={!canEdit} onChange={(event) => edit(option.id, { label: event.target.value })} />
                    <Field label={t.optionValue(groupName, n)} labelHidden placeholder={t.colValue} value={option.value} error={draft.errors.get(key('value'))} disabled={!canEdit} onChange={(event) => edit(option.id, { value: event.target.value })} />
                    <DollarField label={t.optionAdder(groupName, n)} labelHidden value={option.adder.cents} error={draft.errors.get(key('cents'))} onChange={(value) => edit(option.id, { adder: { ...option.adder, cents: value } })} />
                    <Select
                      label={t.optionPer(groupName, n)}
                      value={option.adder.per}
                      disabled={!canEdit}
                      onChange={(per) => edit(option.id, { adder: { ...option.adder, per: per as OptionChoice['adder']['per'] } })}
                      options={PER.map((per) => ({ value: per, label: PER_LABEL[per] }))}
                    />
                  </div>
                  <div className={styles.editMeta}>
                    <details className={styles.products}>
                      <summary aria-label={t.optionProducts(groupName, n)}>{option.productIds.length === 0 ? t.allProducts : t.someProducts(option.productIds.length)}</summary>
                      <div className={styles.productList}>
                        {draft.catalog.products
                          .filter((p) => !p.archived)
                          .map((p) => (
                            <Checkbox
                              key={p.id}
                              label={p.name}
                              checked={option.productIds.includes(p.id)}
                              disabled={!canEdit}
                              onChange={(on) => edit(option.id, { productIds: on ? [...option.productIds, p.id] : option.productIds.filter((id) => id !== p.id) })}
                            />
                          ))}
                        <p className="bo-foot">{t.allProducts}</p>
                      </div>
                    </details>
                    <Checkbox label={t.optionDefault(groupName, n)} checked={option.isDefault} disabled={!canEdit} onChange={(on) => makeDefault(option.id, on)} />
                    {canEdit ? (
                      <Button variant="ghost" aria-label={option.archived ? t.optionRestore(groupName, n) : t.optionArchive(groupName, n)} onClick={() => edit(option.id, { archived: !option.archived })}>
                        {option.archived ? t.restore : t.archive}
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
          <Button variant="ghost" onClick={() => draft.change((catalog) => ({ ...catalog, options: [...catalog.options, emptyOption(group)] }))}>
            <Icon name="plus" size={16} />
            {t.addOption(groupName)}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
