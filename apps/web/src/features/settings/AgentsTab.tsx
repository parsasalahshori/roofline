import { agents } from '../../copy/agents.ts';
import styles from './AgentRules.module.css';
import { TimeBaselines } from '../agents/TimeBaselines.tsx';
import { AgentRules } from './AgentRules.tsx';

/** The Agents settings tab: how we count time saved (A1), then the agent rules form (G1). */
export function AgentsTab() {
  return (
    <>
      <nav className={styles.navigation} aria-label={agents.settingsNav}>
        <a href="#agent-rules">{agents.rulesJump}</a>
        <a href="#agent-time-baselines">{agents.baselinesJump}</a>
      </nav>
      <div id="agent-rules" className={styles.anchor}><AgentRules /></div>
      <div id="agent-time-baselines" className={styles.anchor}><TimeBaselines /></div>
    </>
  );
}
