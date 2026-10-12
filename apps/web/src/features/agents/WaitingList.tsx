import { useId } from 'react';
import type { WaitingItem } from '@roofline/shared';
import { Banner, Button, EmptyState, Skeleton } from '@roofline/ui';
import { agents, agentsCommon } from '../../copy/agents.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { useCompany } from '../settings/api.ts';
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
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {group.title}
      </h2>
      <ul className={styles.list}>
        {group.items.map((item) => (
          <li key={item.id} className={styles.row}>
            <span className={styles.agent}>{AGENT_LABEL[item.agent]}</span>
            <span className={styles.text}>{item.text}</span>
            <time dateTime={item.since} className={styles.time}>
              {agentTimeLabel(item.since, zone)}
            </time>
            {item.href ? (
              <Button href={item.href} variant="ghost" className={styles.open}>
                {agents.waitingOpen}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Everything waiting on somebody, grouped by who it waits on. */
export function WaitingList() {
  const query = useWaiting();
  const zone = useCompany().data?.timezone;
  if (!query.data) {
    if (query.isError) {
      return (
        <EmptyState
          title={agents.waitingLoadError}
          action={<Button onClick={() => void query.refetch()}>{agentsCommon.retry}</Button>}
        />
      );
    }
    return (
      <div role="status" aria-label={agents.waitingLoading}>
        <Skeleton lines={3} />
      </div>
    );
  }
  const groups = groupItems(query.data.items);
  const stale = query.isError ? <Banner tone="warning">{agentsCommon.refreshFailed}</Banner> : null;
  if (groups.length === 0) {
    return (
      <>
        {stale}
        <EmptyState title={agents.waitingEmpty} />
      </>
    );
  }
  return (
    <>
      {stale}
      <section aria-label={agents.waitingListLabel} className={styles.groups}>
        {groups.map((group) => (
          <WaitingGroup key={group.key} group={group} zone={zone} />
        ))}
      </section>
    </>
  );
}
