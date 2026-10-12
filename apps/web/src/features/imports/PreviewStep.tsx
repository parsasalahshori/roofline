import { SKIP_KEYS, type ImportView, type SkipKey } from '@roofline/shared';
import { Button } from '@roofline/ui';
import { importCopy } from '../../copy/import.ts';
import styles from './ImportWizard.module.css';

export type PreviewStepProps = { view: ImportView; onBack: () => void; onNext: () => void };

const SKIP_LABELS: Record<SkipKey, (n: number) => string> = {
  noName: importCopy.skipNoName,
  noContact: importCopy.skipNoContact,
  badPhone: importCopy.skipBadPhone,
  duplicate: importCopy.skipDuplicate,
};

const OUTCOME_LABELS: Record<'create' | 'update' | 'skip', string> = {
  create: importCopy.outcomeCreate,
  update: importCopy.outcomeUpdate,
  skip: importCopy.outcomeSkip,
};

/** Shows what the import will do: the counts and the first rows as they will be saved. */
export function PreviewStep({ view, onBack, onNext }: PreviewStepProps) {
  const { counts } = view;
  const reasons = SKIP_KEYS.filter((key) => counts.skippedBy[key] > 0);

  return (
    <section className={styles.wizard}>
      <h2 className={styles.title}>{importCopy.previewTitle}</h2>
      <ul className={styles.counts}>
        <li>{importCopy.newCustomers(counts.new)}</li>
        <li>{importCopy.existingCustomers(counts.updated)}</li>
        <li>
          {importCopy.willSkip(counts.skipped)}
          {reasons.length > 0 ? (
            <ul className={styles.reasons}>
              {reasons.map((key) => (
                <li key={key}>{SKIP_LABELS[key](counts.skippedBy[key])}</li>
              ))}
            </ul>
          ) : null}
        </li>
      </ul>
      <div className={styles.tableBox}>
        <table className={styles.table} aria-label={importCopy.previewTableLabel}>
          <thead>
            <tr>
              <th scope="col">{importCopy.colRow}</th>
              <th scope="col">{importCopy.colName}</th>
              <th scope="col">{importCopy.colPhone}</th>
              <th scope="col">{importCopy.colEmail}</th>
              <th scope="col">{importCopy.colAddress}</th>
              <th scope="col">{importCopy.colStage}</th>
              <th scope="col">{importCopy.colOutcome}</th>
            </tr>
          </thead>
          <tbody>
            {view.preview.map((row) => (
              <tr key={row.row}>
                <td>{row.row}</td>
                <td>{row.name ?? ''}</td>
                <td>{row.phone ?? ''}</td>
                <td>{row.email ?? ''}</td>
                <td>{row.address ?? ''}</td>
                <td>{row.stage ?? ''}</td>
                <td>
                  {row.outcome === 'skip' && row.reason
                    ? importCopy.outcomeWithReason(OUTCOME_LABELS[row.outcome], row.reason)
                    : OUTCOME_LABELS[row.outcome]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onBack}>
          {importCopy.back}
        </Button>
        <Button type="button" variant="primary" onClick={onNext}>
          {importCopy.next}
        </Button>
      </div>
    </section>
  );
}
