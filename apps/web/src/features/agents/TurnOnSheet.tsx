import { useState } from 'react';
import { Banner, Button, Sheet } from '@roofline/ui';
import type { RuleSentence, ScreenAgent } from '@roofline/shared';
import { agentPage } from '../../copy/agents.ts';
import { common } from '../../copy/common.ts';
import { usePauseAgent } from './api.ts';
import { RulesList } from './RulesList.tsx';
import styles from './AgentControls.module.css';

export type TurnOnSheetProps = {
  agent: ScreenAgent;
  rules: RuleSentence[];
  onClose: () => void;
};

/** Turning a new agent on: the rules first, then Turn on. Nothing is sent until the owner confirms. */
export function TurnOnSheet({ agent, rules, onClose }: TurnOnSheetProps) {
  const [failed, setFailed] = useState(false);
  const mutation = usePauseAgent(agent);

  const confirm = () => {
    setFailed(false);
    mutation.mutate(false, { onSuccess: onClose, onError: () => setFailed(true) });
  };

  return (
    <Sheet
      open
      title={agentPage.turnOnTitle}
      onClose={onClose}
      closeLabel={common.close}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" disabled={mutation.isPending} onClick={onClose}>
            {agentPage.turnOnCancel}
          </Button>
          <Button variant="primary" busy={mutation.isPending} onClick={confirm}>
            {agentPage.turnOnConfirm}
          </Button>
        </div>
      }
    >
      <div className={styles.sheetBody}>
        <p>{agentPage.turnOnIntro}</p>
        <RulesList rules={rules} />
        {failed ? <Banner tone="danger">{agentPage.pauseError}</Banner> : null}
      </div>
    </Sheet>
  );
}
