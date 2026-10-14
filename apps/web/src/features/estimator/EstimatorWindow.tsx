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
                <span className={styles.customer}>{p.customer.name}</span>
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
    <aside className={styles.groups} aria-label={estimator.proposalsTitle}>
      <h2 className={styles.heading}>{estimator.proposalsTitle}</h2>
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
    </aside>
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
      <header className="visually-hidden">
        <h1 className={styles.title}>{estimator.title}</h1>
        <p className={styles.note}>{estimator.subtitle}</p>
      </header>
      <div className={styles.layout}>
        <div className={styles.workspace}>
          <h2 className={styles.workspaceTitle}>{estimator.startTitle}</h2>
          <p className={styles.note}>{estimator.startHelp}</p>
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
            <Button type="submit" className={styles.useAddress} disabled={text.trim() === '' || target !== null}>
              {estimator.useAddress}
            </Button>
            {search.isFetching && query !== '' ? <p className={styles.note} role="status">{estimator.searching}</p> : null}
            {search.isError ? (
              <div className={styles.searchError} role="alert">
                <p className={styles.note}>{estimator.searchFailed}</p>
                <Button variant="ghost" onClick={() => void search.refetch()}>{estimator.retrySearch}</Button>
              </div>
            ) : null}
            {matches.length > 0 ? (
              <section className={styles.homes}>
                <h2 className={styles.heading}>{estimator.homesTitle}</h2>
                <ul className={styles.list}>
                  {matches.map((p) => (
                    <li key={p.id}>
                      <Button
                        variant="ghost"
                        className={styles.result}
                        aria-pressed={target?.kind === 'home' && target.propertyId === p.id}
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
          {target === null ? (
            <section className={styles.guide} aria-label={estimator.workflowTitle}>
              <h2 className={styles.heading}>{estimator.workflowTitle}</h2>
              <ol className={styles.steps}>{estimator.workflow.map((step) => <li key={step}>{step}</li>)}</ol>
              <p className={styles.note}>{estimator.workflowHelp}</p>
            </section>
          ) : null}
        </div>
        <ProposalGroups />
      </div>
    </div>
  );
}
