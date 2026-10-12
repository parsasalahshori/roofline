import { hoursLabel, type BaselineBreakdownRow } from '@roofline/shared';
import { agentPage, agentsCommon } from '../../copy/agents.ts';
import styles from './AgentLists.module.css';

/** Where the saved time came from, one row per kind of work. */
export function TimeBreakdown({ rows }: { rows: BaselineBreakdownRow[] }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.title}>{agentPage.breakdownTitle}</h3>
      {rows.length === 0 ? (
        <p className={styles.empty}>{agentPage.breakdownEmpty}</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <caption className={styles.caption}>{agentPage.breakdownCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{agentPage.colWork}</th>
                <th scope="col">{agentPage.colUnits}</th>
                <th scope="col">{agentPage.colTime}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.baseline}>
                  <td>{agentPage.baselineLabels[row.baseline]}</td>
                  <td>{row.units}</td>
                  <td>{`${hoursLabel(row.minutes)} ${agentsCommon.estimate}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
