import { useState } from 'react';
import type { BaselineKey, TimeBaselineRow } from '@roofline/shared';
import { Banner, Button, Field, Panel, Skeleton, UiLink } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { agentPage, timeBaselines as copy } from '../../copy/agents.ts';
import { useSaveTimeBaselines, useTimeBaselines } from './api.ts';
import { rateLabel } from './money.ts';
import { RecountSection } from './RecountSection.tsx';
import styles from './TimeBaselines.module.css';

/** The plain-English problem with what was typed, or null when it is a usable number of minutes. */
export function validateMinutes(text: string): string | null {
  const trimmed = text.trim();
  const n = Number(trimmed);
  if (trimmed === '' || Number.isNaN(n)) return copy.errorNotNumber;
  if (n < 0 || n > 600) return copy.errorRange;
  if (!Number.isInteger(n * 2)) return copy.errorStep;
  return null;
}

function basisWords(row: TimeBaselineRow): string {
  const parts = [row.basis];
  if (row.perCallLength) parts.push(copy.plusCallLength);
  if (row.capMinutes !== null) parts.push(`${copy.capPrefix} ${row.capMinutes} ${copy.capSuffix}`);
  return parts.join('. ');
}

export function TimeBaselines() {
  const query = useTimeBaselines();
  const save = useSaveTimeBaselines();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  if (query.isPending) {
    return (
      <div role="status" aria-label={copy.loading}>
        <Skeleton />
      </div>
    );
  }
  if (query.isError) return <Banner tone="danger">{copy.loadError}</Banner>;
  const data = query.data;

  const draftOf = (row: TimeBaselineRow) => drafts[row.key] ?? String(row.minutes);
  const errors = new Map(data.rows.map((row) => [row.key, validateMinutes(draftOf(row))]));
  const hasError = [...errors.values()].some((message) => message !== null);

  const changes: Partial<Record<BaselineKey, number | null>> = {};
  for (const row of data.rows) {
    if (drafts[row.key] === undefined || errors.get(row.key) !== null) continue;
    const n = Number(drafts[row.key]);
    if (n === row.minutes) continue;
    changes[row.key] = n === row.defaultMinutes ? null : n;
  }
  // A valid draft that equals the saved number (1.50 and 1.5) is not an edit; an invalid one always is
  const unsaved = data.rows.some(
    (row) => drafts[row.key] !== undefined && (errors.get(row.key) !== null || Number(drafts[row.key]) !== row.minutes),
  );
  const changed = Object.keys(changes).length > 0;

  const edit = (key: string, value: string) => {
    setSaved(false);
    setDrafts((current) => ({ ...current, [key]: value }));
  };
  const submit = () => {
    save.mutate(
      { minutes: changes },
      {
        onSuccess: () => {
          setDrafts({});
          setSaved(true);
        },
      },
    );
  };
  const saveMessage = save.error instanceof ApiError ? save.error.message : copy.saveError;

  return (
    <Panel title={copy.title}>
      <div className={styles.root}>
        <p className={styles.text}>{copy.intro}</p>
        <p className={styles.quiet}>{copy.onlyFinished}</p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className={styles.caption}>{copy.tableCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{copy.colWork}</th>
                <th scope="col">{copy.colUnit}</th>
                <th scope="col">{copy.colBasis}</th>
                <th scope="col">{copy.colMinutes}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const work = agentPage.baselineLabels[row.key];
                const draft = draftOf(row);
                const differs = Number(draft) !== row.defaultMinutes || validateMinutes(draft) !== null;
                return (
                  <tr key={row.key}>
                    <th scope="row">{work}</th>
                    <td>
                      <span className={styles.cellLabel}>{copy.colUnit}</span>
                      {row.unit}
                    </td>
                    <td>
                      <span className={styles.cellLabel}>{copy.colBasis}</span>
                      {basisWords(row)}
                    </td>
                    <td>
                      <span className={styles.cellLabel}>{copy.colMinutes}</span>
                      {data.canEdit ? (
                        <div className={styles.edit}>
                          <Field
                            label={`${copy.inputLabelPrefix} ${work}`}
                            labelHidden
                            type="number"
                            inputMode="decimal"
                            step={0.5}
                            min={0}
                            max={600}
                            value={draft}
                            error={errors.get(row.key) ?? undefined}
                            onChange={(event) => edit(row.key, event.target.value)}
                          />
                          <span className={styles.hint}>{`${copy.defaultIs} ${row.defaultMinutes}`}</span>
                          {differs ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              aria-label={`${copy.reset} ${copy.resetLabelSuffix} ${work}`}
                              onClick={() => edit(row.key, String(row.defaultMinutes))}
                            >
                              {copy.reset}
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        `${row.minutes} ${copy.minutesSuffix}`
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.canEdit ? (
          <div className={styles.saveRow}>
            <Button type="button" busy={save.isPending} disabled={hasError || !changed || save.isPending} onClick={submit}>
              {save.isPending ? copy.saving : copy.save}
            </Button>
            {saved && !save.isPending ? <p role="status" className={styles.text}>{copy.saved}</p> : null}
            {save.isError ? <p role="alert" className={styles.problem}>{saveMessage}</p> : null}
          </div>
        ) : (
          <p className={styles.text}>{copy.ownerOnly}</p>
        )}
        <p className={styles.text}>
          {`${copy.ratePrefix} ${rateLabel(data.hourlyRateCents)} ${copy.rateSuffix}`}
          {data.canEdit ? (
            <>
              {' '}
              <UiLink href={copy.rateHref} className={styles.link}>
                {copy.rateLinkText}
              </UiLink>
            </>
          ) : null}
        </p>
        <RecountSection canRecount={data.canEdit} blocked={unsaved} />
      </div>
    </Panel>
  );
}
