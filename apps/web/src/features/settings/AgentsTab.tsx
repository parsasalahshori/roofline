import { useRef, type MouseEvent } from 'react';
import { agents } from '../../copy/agents.ts';
import styles from './AgentRules.module.css';
import { TimeBaselines } from '../agents/TimeBaselines.tsx';
import { AgentRules } from './AgentRules.tsx';

/** Scroll only the window body; native hash scrolling also moves its clipped title/close bar. */
function jumpTo(event: MouseEvent<HTMLAnchorElement>, target: HTMLDivElement | null) {
  if (!target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  let scroller = target.parentElement;
  while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (scroller) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  target.focus({ preventScroll: true });
}

/** Rules first, with time estimates and the owner-only recount still fully available. */
export function AgentsTab() {
  const rules = useRef<HTMLDivElement>(null);
  const baselines = useRef<HTMLDivElement>(null);
  return (
    <>
      <nav className={styles.navigation} aria-label={agents.settingsNav}>
        <a href="#agent-rules" onClick={(event) => jumpTo(event, rules.current)}>{agents.rulesJump}</a>
        <a href="#agent-time-baselines" onClick={(event) => jumpTo(event, baselines.current)}>{agents.baselinesJump}</a>
      </nav>
      <div id="agent-rules" ref={rules} tabIndex={-1} className={styles.anchor}><AgentRules /></div>
      <div id="agent-time-baselines" ref={baselines} tabIndex={-1} className={styles.anchor}><TimeBaselines /></div>
    </>
  );
}
