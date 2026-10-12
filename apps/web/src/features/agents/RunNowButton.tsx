import { useEffect, useState } from 'react';
import { Banner, Button } from '@roofline/ui';
import type { RunNow, ScreenAgent } from '@roofline/shared';
import { agentPage, agentsCommon } from '../../copy/agents.ts';
import { useMe } from '../../api/hooks.ts';
import { useRunNow } from './api.ts';
import styles from './AgentControls.module.css';

export type RunNowButtonProps = {
  agent: ScreenAgent;
  runNow: RunNow;
};

function isFuture(value: string | null): value is string {
  return value !== null && new Date(value).getTime() > Date.now();
}

function clock(value: string): string {
  return new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/[\u202f\u00a0]/g, ' ');
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** What "run now" looks like for this agent: a button, a cooldown line, or a plain statement. */
export function RunNowButton({ agent, runNow }: RunNowButtonProps) {
  const propNext = runNow.kind === 'available' ? runNow.nextAllowedAt : null;
  const [startedUntil, setStartedUntil] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [error, setError] = useState<{ message: string; at: string | null } | null>(null);
  const mutation = useRunNow(agent);
  const me = useMe();
  const canRun = me.data?.role === 'owner' || me.data?.role === 'office';
  const until = later(startedUntil, propNext);
  const shownError = error !== null && error.at === propNext ? error.message : null;

  useEffect(() => {
    if (until === null) return;
    const ms = new Date(until).getTime() - Date.now();
    if (!(ms > 0)) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), Math.min(ms + 250, 2_147_483_647));
    return () => window.clearTimeout(id);
  }, [until]);

  if (runNow.kind !== 'available') {
    const text =
      runNow.kind === 'works_when_asked'
        ? agentPage.worksWhenAsked
        : runNow.kind === 'answers_calls'
          ? agentPage.answersCalls
          : agentsCommon.comingSoon;
    return (
      <div className={styles.controls}>
        <p className={styles.status} aria-live="polite">
          {text}
        </p>
      </div>
    );
  }

  if (!canRun) return null;

  const run = () => {
    const at = propNext;
    setError(null);
    mutation.mutate(undefined, {
      onSuccess: (result) => {
        setError(null);
        setStartedUntil(result.nextAllowedAt);
      },
      onError: (e) => setError({ message: e.message || agentPage.runError, at }),
    });
  };

  return (
    <div className={styles.controls}>
      <div aria-live="polite">
        {isFuture(until) ? (
          <p className={styles.status}>{`${agentPage.runNowAgain} ${clock(until)}`}</p>
        ) : (
          <div className={styles.runButton}>
            <Button variant="primary" busy={mutation.isPending} onClick={run}>
              {agentPage.runNowButton}
            </Button>
          </div>
        )}
      </div>
      {shownError !== null ? <Banner tone="danger">{shownError}</Banner> : null}
    </div>
  );
}
