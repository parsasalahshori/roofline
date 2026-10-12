import { useState } from 'react';
import { Banner, Button, Sheet, Toggle } from '@roofline/ui';
import type { AgentDetail, ScreenAgent } from '@roofline/shared';
import { agentPage } from '../../copy/agents.ts';
import { common } from '../../copy/common.ts';
import { usePauseAgent } from './api.ts';
import styles from './AgentControls.module.css';

export type PauseSwitchProps = {
  agent: ScreenAgent;
  paused: AgentDetail['paused'];
  isOwner: boolean;
};

/** Owner: a switch (pausing asks first, resuming does not). Everyone else: a read-only status line. */
export function PauseSwitch({ agent, paused, isOwner }: PauseSwitchProps) {
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const mutation = usePauseAgent(agent);

  const statusText =
    paused === null ? null : paused.byName ? `${agentPage.pausedBy} ${paused.byName}` : agentPage.pauseLabel;

  if (!isOwner) {
    return paused === null ? null : (
      <div className={styles.controls}>
        <p className={styles.status} aria-live="polite">
          {statusText}
        </p>
      </div>
    );
  }

  const close = () => {
    setConfirming(false);
    setFailed(false);
  };

  const onToggle = (next: boolean) => {
    if (next) {
      setFailed(false);
      setConfirming(true);
      return;
    }
    mutation.mutate(false);
  };

  const confirm = () => {
    setFailed(false);
    mutation.mutate(true, { onSuccess: close, onError: () => setFailed(true) });
  };

  return (
    <div className={styles.controls}>
      <Toggle checked={paused !== null} onChange={onToggle} label={agentPage.pauseLabel} disabled={mutation.isPending && !confirming} />
      {statusText !== null && paused?.byName ? (
        <p className={styles.status} aria-live="polite">
          {statusText}
        </p>
      ) : null}
      {mutation.isError && !confirming ? <Banner tone="danger">{agentPage.pauseError}</Banner> : null}
      {confirming ? (
        <Sheet
          open
          title={agentPage.pauseTitle}
          onClose={close}
          closeLabel={common.close}
          footer={
            <div className={styles.footer}>
              <Button variant="ghost" disabled={mutation.isPending} onClick={close}>
                {agentPage.pauseCancel}
              </Button>
              <Button variant="primary" busy={mutation.isPending} onClick={confirm}>
                {agentPage.pauseConfirm}
              </Button>
            </div>
          }
        >
          <div className={styles.sheetBody}>
            <p>{agentPage.pauseBody}</p>
            {failed ? <Banner tone="danger">{agentPage.pauseError}</Banner> : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
