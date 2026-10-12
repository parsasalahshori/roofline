import { useEffect, useState, type FormEvent } from 'react';
import type { ProposalStatus, ProposalView } from '@roofline/shared';
import { Button, Field, Skeleton, UiLink } from '@roofline/ui';
import type { PropertyRecord } from '../create/api.ts';
import { estimator } from '../../copy/estimator.ts';
import { useHomeSearch, useProposals } from './api.ts';
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
];

function homeLabel(p: PropertyRecord): string {
  return `${p.addressLine}, ${p.city}, ${p.state} ${p.zip}`;
}

function ProposalGroups() {
  const list = useProposals({});
  if (list.isError) {
    return (
      <p className={styles.note} role="alert">
        {estimator.listsFailed}
      </p>
    );
  }
  if (list.isPending || list.data === undefined) {
    return <Skeleton lines={3} />;
  }
  const all: ProposalView[] = list.data.proposals;
  return (
    <div className={styles.groups}>
      {GROUPS.map((group) => {
        const items = all.filter((p) => group.statuses.includes(p.status));
        return (
          <section key={group.key} className={styles.group}>
            <h2 className={styles.heading}>{estimator.groups[group.key]}</h2>
            {items.length === 0 ? (
              <p className={styles.note}>{estimator.emptyGroup}</p>
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
          </section>
        );
      })}
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
