import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { errors } from '../../copy/errors.ts';
import { texting } from '../../copy/texting.ts';
import { TextingForm } from './TextingForm.tsx';
import { useTexting } from './api.ts';
import { TextingStatus } from './TextingStatus.tsx';

/** The texting registration screen: the form until the company sends it, then the carrier status. */
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
      <div role="status">
        <Skeleton lines={4} />
        <span className="visually-hidden">{texting.loading}</span>
      </div>
    );
  }

  if (data.state === 'not_started' || data.state === 'needs_fix') {
    // Keyed on the state so the form starts fresh when the answer changes from one to the other
    return <TextingForm key={data.state} view={data} />;
  }
  return <TextingStatus view={data} />;
}
