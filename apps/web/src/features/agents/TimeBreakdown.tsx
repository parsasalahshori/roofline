import { hoursLabel, type BaselineBreakdownRow } from '@roofline/shared';
import { Panel, Table, Td, Th, Tr } from '@roofline/ui';
import { agentPage } from '../../copy/agents.ts';
import styles from './AgentLists.module.css';

/** Where the saved time came from, one row per kind of work. */
export function TimeBreakdown({ rows }: { rows: BaselineBreakdownRow[] }) {
  return (
    <Panel title={agentPage.breakdownTitle} padded={rows.length === 0}>
      {rows.length === 0 ? (
        <p className={styles.empty}>{agentPage.breakdownEmpty}</p>
      ) : (
        <Table className={styles.breakdown}>
          <caption className="visually-hidden">{agentPage.breakdownCaption}</caption>
          <thead>
            <tr>
              <Th>{agentPage.colWork}</Th>
              <Th numeric>{agentPage.colUnits}</Th>
              <Th numeric>{agentPage.colTime}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.baseline}>
                <Td>{agentPage.baselineLabels[row.baseline]}</Td>
                <Td numeric>{row.units.toLocaleString('en-US')}</Td>
                <Td numeric>{hoursLabel(row.minutes)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
