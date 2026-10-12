import { useEffect, useState, type FormEvent } from 'react';
import type { ProposalStatus, ProposalView } from '@roofline/shared';
import { Button, Field, Skeleton, UiLink } from '@roofline/ui';
import type { PropertyRecord } from '../create/api.ts';
import { estimator } from '../../copy/estimator.ts';
import { useHomeSearch, useProposalGroup } from './api.ts';
import { MakeProposal } from './MakeProposal.tsx';
import type { MakeTarget } from './types.ts';
import styles from './EstimatorWindow.module.css';

/** How long the person has to stop typing before the search runs. */
const DEBOUNCE_MS = 250;
/** Most matches shown at once. */
const MAX_RESULTS = 8;

const GROUPS: { key: keyof typeof estimator.groups; statuses: readonly ProposalStatus[] }[] = [
  { key: 'review', statuses: ['draft', 'ready'] },
  { key: 'out', statuses: ['sent', 'viewed'] },
  { key: 'signed', statuses: ['signed'] },
  { key: 'declined', statuses: ['declined'] },
  { key: 'expired', statuses: ['expired'] },
];

function homeLabel(p: PropertyRecord): string {
  return `${p.addressLine}, ${p.city}, ${p.state} ${p.zip}`;
}

function ProposalGroup({ group, q }: { group: (typeof GROUPS)[number]; q: string }) {
  const list = useProposalGroup(group.statuses, q);
  const items: ProposalView[] = list.data?.pages.flatMap((page) => page.proposals) ?? [];
  return (
    <section className={styles.group}>
      <h2 className={styles.heading}>{estimator.groups[group.key]}</h2>
      {list.isError && items.length === 0 ? (
        <p className={styles.note} role="alert">
          {estimator.listsFailed}
        </p>
      ) : list.isPending ? (
        <Skeleton lines={2} />
      ) : items.length === 0 ? (
        <p className={styles.note}>{q === '' ? estimator.emptyGroup : estimator.noMatchesFound}</p>
      ) : (
        <ul className={styles.list}>
          {items.map((p) => (
            <li key={p.id}>
              <UiLink href={`/estimator/proposals/${p.id}`} className={styles.row}>
                <span className={styles.number}>{p.number}</span>
                <span>{p.customer.name}</span>
                <span className={styles.address}>{p.address}</span>
              </UiLink>
            </li>
          ))}
        </ul>
      )}
      {list.isError && items.length > 0 ? (
        <p className={styles.note} role="alert">
          {estimator.listsFailed}
        </p>
      ) : null}
      {list.hasNextPage ? (
        <Button variant="ghost" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {estimator.showMore}
        </Button>
      ) : null}
    </section>
  );
}

function ProposalGroups() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className={styles.groups}>
      <Field
        label={estimator.findLabel}
        help={estimator.findHint}
        type="search"
        autoComplete="off"
        maxLength={100}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      {GROUPS.map((group) => (
        <ProposalGroup key={group.key} group={group} q={q} />
      ))}
    </div>
  );
}

/** The Estimator window: start from an address, then the proposals in flight. */
export function EstimatorWindow() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<MakeTarget | null>(null);

  // The search waits until the person stops typing for a moment
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const search = useHomeSearch(query);
  const matches = search.data?.properties.slice(0, MAX_RESULTS) ?? [];
  const noMatches = search.isSuccess && query !== '' && matches.length === 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const address = text.trim();
    if (address !== '' && target === null) setTarget({ kind: 'address', address });
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{estimator.title}</h1>
      <form className={styles.form} onSubmit={onSubmit}>
        <Field
          label={estimator.addressLabel}
          help={estimator.addressHint}
          type="search"
          autoComplete="off"
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setTarget(null);
          }}
        />
        {matches.length > 0 ? (
          <section className={styles.homes}>
            <h2 className={styles.heading}>{estimator.homesTitle}</h2>
            <ul className={styles.list}>
              {matches.map((p) => (
                <li key={p.id}>
                  <Button
                    variant="ghost"
                    className={styles.result}
                    onClick={() => setTarget({ kind: 'home', propertyId: p.id, label: homeLabel(p), hasCustomer: p.customerId !== null })}
                  >
                    {homeLabel(p)}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {noMatches ? <p className={styles.note}>{estimator.noHomes}</p> : null}
      </form>
      {target !== null ? (
        <MakeProposal
          key={target.kind === 'home' ? `home:${target.propertyId}` : `address:${target.address}`}
          target={target}
        />
      ) : null}
      <ProposalGroups />
    </div>
  );
}
