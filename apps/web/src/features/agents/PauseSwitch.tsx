import { useState } from 'react';
import { Banner, Button, Sheet, Toggle } from '@roofline/ui';
import { G1_AGENTS, type AgentDetail, type RuleSentence, type ScreenAgent } from '@roofline/shared';
import { agentPage, agentsDash } from '../../copy/agents.ts';
import { common } from '../../copy/common.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { usePauseAgent } from './api.ts';
import { TurnOnSheet } from './TurnOnSheet.tsx';
import styles from './AgentControls.module.css';

export type PauseSwitchProps = {
  agent: ScreenAgent;
  paused: AgentDetail['paused'];
  isOwner: boolean;
  rules?: RuleSentence[];
  /** `card` is the dashboard switch: on means running, and a reader who cannot change it sees no control. */
  variant?: 'page' | 'card';
};

/** Owner: a switch (pausing asks first, resuming does not). Everyone else: a read-only status line. */
export function PauseSwitch({ agent, paused, isOwner, rules = [], variant = 'page' }: PauseSwitchProps) {
  const card = variant === 'card';
  const [turningOn, setTurningOn] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const mutation = usePauseAgent(agent);

  const statusText =
    paused === null ? null : paused.byName ? `${agentPage.pausedBy} ${paused.byName}` : agentPage.pauseLabel;

  if (!isOwner) {
    if (card) return null;
    return paused === null ? null : (
      <div className={styles.controls}>
        <p className={styles.status} aria-live="polite">
          {statusText}
        </p>
      </div>
    );
  }

  if (paused !== null && (G1_AGENTS as readonly string[]).includes(agent)) {
    return (
      <div className={styles.controls}>
        {card ? (
          <Toggle checked={false} onChange={() => setTurningOn(true)} label={`${AGENT_LABEL[agent]} ${agentsDash.running}`} labelHidden />
        ) : (
          <Button variant="primary" onClick={() => setTurningOn(true)}>
            {agentPage.turnOnButton}
          </Button>
        )}
        {turningOn ? <TurnOnSheet agent={agent} rules={rules} onClose={() => setTurningOn(false)} /> : null}
      </div>
    );
  }

  const close = () => {
    setConfirming(false);
    setFailed(false);
    mutation.reset();
  };

  // The switch means the same on the page and on the card: on is running. Turning it off pauses (after a confirmation),
  // turning it on resumes.
  const onToggle = (value: boolean) => {
    if (!value) {
      setFailed(false);
      mutation.reset();
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
      <Toggle
        checked={paused === null}
        onChange={onToggle}
        label={card ? `${AGENT_LABEL[agent]} ${agentsDash.running}` : agentPage.runningLabel}
        labelHidden={card}
        disabled={mutation.isPending && !confirming}
      />
      {!card && statusText !== null && paused?.byName ? (
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
