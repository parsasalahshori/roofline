import { Button, EmptyState, Panel, Skeleton, Stepper } from '@roofline/ui';
import type { TextingView } from '@roofline/shared';
import { ApiError } from '../../api/client.ts';
import { errors } from '../../copy/errors.ts';
import { texting } from '../../copy/texting.ts';
import { TextingForm } from './TextingForm.tsx';
import { useTexting } from './api.ts';
import { TextingStatus } from './TextingStatus.tsx';
import styles from './TextingSetup.module.css';

const STEPS = [{ label: texting.steps.business }, { label: texting.steps.carriers }, { label: texting.steps.on }];

/** The step in progress: the form is the first, the carriers' review the second; once approved every step is done. */
function stepOf(state: TextingView['state']): number {
  if (state === 'waiting') return 2;
  if (state === 'approved') return STEPS.length + 1;
  return 1;
}

/** The texting registration screen: the steps, then the form until the company sends it, then the carrier status. */
export function TextingSetup() {
  const query = useTexting();
  const data = query.data;

  // Shown only while there is nothing to show instead: a failed read with no earlier answer to keep
  if (data === undefined) {
    if (query.error) {
      return (
        <EmptyState
          title={query.error instanceof ApiError ? query.error.message : errors.generic}
          action={
            <Button variant="primary" onClick={() => void query.refetch()}>
              {errors.tryAgain}
            </Button>
          }
        />
      );
    }
    return (
      <Panel>
        <div role="status">
          <Skeleton lines={4} />
          <span className="visually-hidden">{texting.loading}</span>
        </div>
      </Panel>
    );
  }

  const editing = data.state === 'not_started' || data.state === 'needs_fix';
  return (
    <div className={styles.page}>
      <Panel>
        <Stepper label={texting.stepsLabel} steps={STEPS} current={stepOf(data.state)} doneLabel={texting.stepDone} />
      </Panel>
      {/* Keyed on the state so the form starts fresh when the answer changes from one to the other */}
      {editing ? <TextingForm key={data.state} view={data} /> : <TextingStatus view={data} />}
    </div>
  );
}
