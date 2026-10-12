import { Button, ProgressBar } from '@roofline/ui';
import type { ImportView } from '@roofline/shared';
import { ApiError } from '../../api/client.ts';
import { errors } from '../../copy/errors.ts';
import { importCopy } from '../../copy/import.ts';
import { useRetryImport } from './api.ts';
import styles from './ImportWizard.module.css';

export type ProgressStepProps = { view: ImportView };

/** The import while it runs (a progress bar), then its summary, or the failure with a retry. */
export function ProgressStep({ view }: ProgressStepProps) {
  const retry = useRetryImport(view.id);

  if (view.status === 'queued' || view.status === 'processing') {
    return (
      <div className={styles.wizard}>
        <p className={styles.note}>{importCopy.progressLabel}</p>
        <ProgressBar value={view.progress.processed} max={view.progress.total} label={importCopy.progressLabel} />
      </div>
    );
  }

  if (view.status === 'failed') {
    return (
      <div className={styles.wizard}>
        <h2 className={styles.title}>{importCopy.failedTitle}</h2>
        {view.errorPlain ? <p className={styles.error}>{view.errorPlain}</p> : null}
        {retry.isError ? (
          <p className={styles.error} role="alert">
            {retry.error instanceof ApiError ? retry.error.message : errors.generic}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button variant="primary" busy={retry.isPending} onClick={() => retry.mutate()}>
            {importCopy.tryAgain}
          </Button>
        </div>
      </div>
    );
  }

  const { counts } = view;
  // The download is an anchor. Button passes its extra attributes through to the link.
  const downloadAttributes = { download: true };
  return (
    <div className={styles.wizard}>
      <h2 className={styles.title}>{importCopy.summaryTitle}</h2>
      <ul className={styles.counts}>
        <li>{importCopy.summaryNew(counts.new)}</li>
        <li>{importCopy.summaryUpdated(counts.updated)}</li>
        <li>{importCopy.summarySkipped(counts.skipped)}</li>
        <li>{importCopy.summaryJobs(counts.jobs)}</li>
        <li>{importCopy.summaryNotLocated(counts.notLocated)}</li>
      </ul>
      {view.skippedDownloadUrl !== null ? (
        <div className={styles.actions}>
          <Button variant="ghost" href={view.skippedDownloadUrl} {...downloadAttributes}>
            {importCopy.downloadSkipped}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
