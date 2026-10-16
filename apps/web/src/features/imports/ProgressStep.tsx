import { Button, Icon, Panel, ProgressBar, Tag } from '@roofline/ui';
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
      <Panel title={importCopy.progressLabel}>
        <div className={styles.progress}>
          <ProgressBar value={view.progress.processed} max={view.progress.total} label={importCopy.progressLabel} />
          <p className={styles.progressCount}>{importCopy.progressCount(view.progress.processed, view.progress.total)}</p>
        </div>
      </Panel>
    );
  }

  if (view.status === 'failed') {
    return (
      <Panel
        title={importCopy.failedTitle}
        actions={
          <Tag tone="bad" icon="alert">
            {importCopy.failedTag}
          </Tag>
        }
      >
        {view.errorPlain ? <p className={styles.error}>{view.errorPlain}</p> : null}
        {retry.isError ? (
          <p className={styles.error} role="alert">
            {retry.error instanceof ApiError ? retry.error.message : errors.generic}
          </p>
        ) : null}
        <Button variant="primary" busy={retry.isPending} onClick={() => retry.mutate()}>
          {importCopy.tryAgain}
        </Button>
      </Panel>
    );
  }

  const { counts } = view;
  // The download is an anchor. Button passes its extra attributes through to the link.
  const downloadAttributes = { download: true };
  return (
    <Panel
      title={importCopy.summaryTitle}
      actions={
        <Tag tone="ok" icon="check">
          {importCopy.doneTag}
        </Tag>
      }
    >
      <ul className={styles.counts}>
        {[
          importCopy.summaryNew(counts.new),
          importCopy.summaryUpdated(counts.updated),
          importCopy.summarySkipped(counts.skipped),
          importCopy.summaryJobs(counts.jobs),
          importCopy.summaryNotLocated(counts.notLocated),
        ].map((line) => (
          <li key={line} className={styles.count}>
            <span className={styles.glyph} aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            {line}
          </li>
        ))}
      </ul>
      {view.skippedDownloadUrl !== null ? (
        <div className={styles.download}>
          <Button variant="default" href={view.skippedDownloadUrl} {...downloadAttributes}>
            {importCopy.downloadSkipped}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
