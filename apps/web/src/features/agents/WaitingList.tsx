import { useId } from 'react';
import type { WaitingItem } from '@roofline/shared';
import { Banner, Button, EmptyState, Panel, Skeleton } from '@roofline/ui';
import { agents, agentsCommon } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { InlineError } from '../approvals/InlineError.tsx';
import { useCompany } from '../settings/api.ts';
import { AgentGlyph } from './AgentGlyph.tsx';
import { useWaiting } from './api.ts';
import { agentTimeLabel } from './time.ts';
import styles from './WaitingList.module.css';

type Group = { key: string; title: string; items: WaitingItem[] };

/** You first, then Office, then each person in the order they first appear. Empty groups are left out. */
function groupItems(items: WaitingItem[]): Group[] {
  const you: Group = { key: 'you', title: agents.waitingGroupYou, items: [] };
  const office: Group = { key: 'office', title: agents.waitingGroupOffice, items: [] };
  const people = new Map<string, Group>();
  for (const item of items) {
    const on = item.waitingOn;
    if (on.kind === 'you') you.items.push(item);
    else if (on.kind === 'office') office.items.push(item);
    else {
      const group = people.get(on.name) ?? { key: 'person:' + on.name, title: on.name, items: [] };
      group.items.push(item);
      people.set(on.name, group);
    }
  }
  return [you, office, ...people.values()].filter((group) => group.items.length > 0);
}

function WaitingGroup({ group, zone }: { group: Group; zone: string | undefined }) {
  return (
    <Panel title={group.title} tag={group.items.length} padded={false}>
      <ul className={styles.list}>
        {group.items.map((item) => (
          <li key={item.id} className={styles.row}>
            <AgentGlyph agent={item.agent} />
            <div className={styles.text}>
              <p className={styles.sentence}>{item.text}</p>
              <p className={styles.meta}>
                <span className={styles.agent}>{AGENT_LABEL[item.agent]}</span>
                <time dateTime={item.since} className={styles.time}>
                  {agentTimeLabel(item.since, zone)}
                </time>
              </p>
            </div>
            {item.href ? (
              <Button href={item.href} variant="default" size="sm" className={styles.open}>
                {agents.waitingOpen}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Everything waiting on somebody, grouped by who it waits on. */
export function WaitingList() {
  const query = useWaiting();
  const zone = useCompany().data?.timezone;
  const listId = useId();
  if (!query.data) {
    if (query.isError) {
      return <InlineError tag={agentsCommon.errorTag} message={agents.waitingLoadError} retryLabel={agentsCommon.retry} onRetry={() => void query.refetch()} />;
    }
    return (
      <div className={styles.loading} role="status" aria-label={agents.waitingLoading}>
        {[0, 1, 2].map((index) => (
          <div key={index} className={styles.skeletonRow}>
            <Skeleton width="22px" height="22px" />
            <Skeleton width={index === 1 ? '45%' : '60%'} height="0.875rem" />
          </div>
        ))}
      </div>
    );
  }
  const groups = groupItems(query.data.items);
  const stale = query.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null;
  if (groups.length === 0) {
    return (
      <>
        {stale}
        <Panel as="div">
          <EmptyState
            title={agents.waitingEmpty}
            body={agents.waitingEmptyBody}
            action={
              <Button variant="default" href="/agents/feed">
                {agents.waitingEmptyAction}
              </Button>
            }
          />
        </Panel>
      </>
    );
  }
  return (
    <>
      {stale}
      <section id={listId} aria-label={agents.waitingListLabel} className={styles.groups}>
        {groups.map((group) => (
          <WaitingGroup key={group.key} group={group} zone={zone} />
        ))}
      </section>
    </>
  );
}
