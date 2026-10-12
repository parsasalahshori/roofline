import { useState } from 'react';
import { Button, Sheet } from '@roofline/ui';
import { hoursLabel, type RecountResult } from '@roofline/shared';
import { ApiError } from '../../api/client.ts';
import { timeBaselines } from '../../copy/agents.ts';
import { useRecount } from './api.ts';
import styles from './RecountSection.module.css';

const errorText = (error: unknown): string => (error instanceof ApiError ? error.message : timeBaselines.recountError);

/** Owner only: dry run first, a confirm sheet with before and after, then the real recount. */
export function RecountSection({ canRecount }: { canRecount: boolean }) {
  const mutation = useRecount();
  const [preview, setPreview] = useState<RecountResult | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canRecount) return null;

  const start = () => {
    setDone(false);
    setError(null);
    mutation.mutate(true, {
      onSuccess: (result) => setPreview(result),
      onError: (failure) => setError(errorText(failure)),
    });
  };

  const close = () => {
    setPreview(null);
    setError(null);
  };

  const confirm = () => {
    setError(null);
    mutation.mutate(false, {
      onSuccess: () => {
        setPreview(null);
        setDone(true);
      },
      onError: (failure) => setError(errorText(failure)),
    });
  };

  return (
    <div className={styles.section}>
      <Button variant="primary" disabled={mutation.isPending || preview !== null} onClick={start}>
        {mutation.isPending && preview === null ? timeBaselines.recountWorking : timeBaselines.recountButton}
      </Button>
      {done ? (
        <p className={styles.done} role="status">
          {timeBaselines.recountDone}
        </p>
      ) : null}
      {error !== null && preview === null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {preview !== null ? (
        <Sheet
          open
          title={timeBaselines.recountTitle}
          onClose={close}
          closeLabel={timeBaselines.recountClose}
          footer={
            <div className={styles.footer}>
              <Button variant="ghost" disabled={mutation.isPending} onClick={close}>
                {timeBaselines.recountCancel}
              </Button>
              <Button variant="primary" busy={mutation.isPending} disabled={mutation.isPending} onClick={confirm}>
                {timeBaselines.recountConfirm}
              </Button>
            </div>
          }
        >
          <div className={styles.sheetBody}>
            <p>{timeBaselines.recountIntro}</p>
            <p>{`${timeBaselines.recountBefore} ${hoursLabel(preview.beforeMinutes)} ${timeBaselines.estimate}`}</p>
            <p>{`${timeBaselines.recountAfter} ${hoursLabel(preview.afterMinutes)} ${timeBaselines.estimate}`}</p>
            <p>{`${timeBaselines.recountSteps} ${preview.steps}`}</p>
            {error !== null ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
