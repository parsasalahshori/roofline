import { Banner, Button } from '@roofline/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../../../api/client.ts';
import { forwarding } from '../../../copy/forwarding.ts';
import { useForwardingTest, useStartForwardingTest } from './forwarding-api.ts';
import styles from './ForwardingTest.module.css';

/*
 * One-click forwarding test: the server calls the business number and checks that the call reaches
 * the Roofline number. The button starts a test; the status polls until the server reports a result.
 */

const copy = forwarding.test;

type Outcome = 'calling' | 'verified' | 'not_received' | 'failed' | null;

export function ForwardingTest() {
  const [testId, setTestId] = useState<string | null>(null);
  const start = useStartForwardingTest();
  const poll = useForwardingTest(testId);
  const queryClient = useQueryClient();

  const status = poll.data?.status;
  const polling = testId !== null && !poll.isError && (status === undefined || status === 'calling');
  const busy = start.isPending || polling;

  // A verified test changes the forwarding state the settings show, so the settings reload once
  useEffect(() => {
    if (status === 'verified') void queryClient.invalidateQueries({ queryKey: ['front-desk', 'settings'] });
  }, [status, queryClient]);

  const outcome: Outcome =
    start.isError || poll.isError || status === 'failed'
      ? 'failed'
      : busy
        ? 'calling'
        : status === 'verified' || status === 'not_received'
          ? status
          : null;

  function startTest() {
    setTestId(null);
    start.mutate(undefined, {
      onSuccess: ({ id }) => setTestId(id),
    });
  }

  const retry = outcome === 'not_received' || outcome === 'failed';
  // A refused start (no business number, too many tests today, ...) says why in a plain sentence; anything else is the generic line
  const startError = start.error;
  const failedSentence =
    startError instanceof ApiError && startError.status >= 400 && startError.status < 500 && startError.message.trim() !== ''
      ? startError.message
      : copy.failed;

  return (
    <div className={styles.wrap}>
      <Button type="button" className={styles.button} busy={busy} onClick={startTest}>
        {retry ? copy.retry : copy.start}
      </Button>
      <div role="status" aria-live="polite" className={styles.status}>
        {outcome === 'calling' ? <Banner tone="info">{copy.calling}</Banner> : null}
        {outcome === 'verified' ? <Banner tone="info">{copy.verified}</Banner> : null}
        {outcome === 'not_received' ? <Banner tone="warning">{copy.notReceived}</Banner> : null}
        {outcome === 'failed' ? <Banner tone="danger">{failedSentence}</Banner> : null}
      </div>
    </div>
  );
}
