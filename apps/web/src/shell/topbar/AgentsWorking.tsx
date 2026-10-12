import { Link } from 'react-router';
import { useTasksSummary } from '../../api/hooks.ts';
import { shell } from '../../copy/shell.ts';
import styles from './AgentsWorking.module.css';

/**
 * How many agents are running right now, as a link to the agents feed. The dot is green only
 * while some are working. It is not a live region: it changes every 30 seconds, not on purpose.
 */
export function AgentsWorking() {
  const { data } = useTasksSummary();
  if (!data) return null;
  return (
    <Link to="/agents/feed" className={styles.agents} data-state={data.working > 0 ? 'working' : 'quiet'}>
      <span className={styles.dot} aria-hidden="true" />
      {shell.agentsWorking(data.working)}
    </Link>
  );
}
