import { SKIP_KEYS, type ImportView, type SkipKey } from '@roofline/shared';
import { Button, Icon, Panel, Table, Tag, Td, Th, Tr, type IconName, type TagTone } from '@roofline/ui';
import { importCopy } from '../../copy/import.ts';
import styles from './ImportWizard.module.css';
import { WizardActions } from './WizardActions.tsx';

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

/** How each outcome looks as a tag: a colour and a glyph beside its words. */
const OUTCOME_LOOK: Record<'create' | 'update' | 'skip', { tone: TagTone; icon: IconName }> = {
  create: { tone: 'ok', icon: 'plus' },
  update: { tone: 'info', icon: 'refresh' },
  skip: { tone: 'warn', icon: 'minus' },
};

/** A count's glyph, in a circle in front of its words. */
function Glyph({ name }: { name: IconName }) {
  return (
    <span className={styles.glyph} aria-hidden="true">
      <Icon name={name} size={16} />
    </span>
  );
}

/** Shows what the import will do: the counts and the first rows as they will be saved. */
export function PreviewStep({ view, onBack, onNext }: PreviewStepProps) {
  const { counts } = view;
  const reasons = SKIP_KEYS.filter((key) => counts.skippedBy[key] > 0);

  return (
    <>
      <Panel title={importCopy.previewTitle} padded={false}>
        <div className={styles.summary}>
          <ul className={styles.counts}>
            <li className={styles.count}>
              <Glyph name="plus" />
              {importCopy.newCustomers(counts.new)}
            </li>
            <li className={styles.count}>
              <Glyph name="refresh" />
              {importCopy.existingCustomers(counts.updated)}
            </li>
            <li className={styles.count}>
              <Glyph name="minus" />
              <div>
                {importCopy.willSkip(counts.skipped)}
                {reasons.length > 0 ? (
                  <ul className={styles.reasons}>
                    {reasons.map((key) => (
                      <li key={key}>{SKIP_LABELS[key](counts.skippedBy[key])}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          </ul>
        </div>
        <Table regionLabel={importCopy.previewTableLabel}>
          <thead>
            <tr>
              <Th numeric>{importCopy.colRow}</Th>
              <Th>{importCopy.colName}</Th>
              <Th>{importCopy.colPhone}</Th>
              <Th>{importCopy.colEmail}</Th>
              <Th>{importCopy.colAddress}</Th>
              <Th>{importCopy.colStage}</Th>
              <Th>{importCopy.colOutcome}</Th>
            </tr>
          </thead>
          <tbody>
            {view.preview.map((row) => {
              const look = OUTCOME_LOOK[row.outcome];
              return (
                <Tr key={row.row}>
                  <Td numeric>{row.row}</Td>
                  <Td>{row.name ?? ''}</Td>
                  <Td className={styles.mono}>{row.phone ?? ''}</Td>
                  <Td>{row.email ?? ''}</Td>
                  <Td>{row.address ?? ''}</Td>
                  <Td>{row.stage ?? ''}</Td>
                  <Td>
                    <Tag tone={look.tone} icon={look.icon}>
                      {row.outcome === 'skip' && row.reason
                        ? importCopy.outcomeWithReason(OUTCOME_LABELS[row.outcome], row.reason)
                        : OUTCOME_LABELS[row.outcome]}
                    </Tag>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </Panel>
      <WizardActions status={importCopy.stepOf(3, 5)}>
        <Button type="button" variant="default" onClick={onBack}>
          {importCopy.back}
        </Button>
        <Button type="button" variant="primary" onClick={onNext}>
          {importCopy.next}
        </Button>
      </WizardActions>
    </>
  );
}
