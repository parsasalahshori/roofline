import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Banner, Button, Field, Skeleton, UiLink } from '@roofline/ui';
import { ApiError } from '../../../api/client.ts';
import { measure } from '../../../copy/measure.ts';
import { useMeasure } from '../../estimator/api.ts';
import { useRequestRows } from './requests.ts';
import styles from './RequestsList.module.css';

/** How long the person has to stop typing before the search runs. */
const DEBOUNCE_MS = 250;

/** The left column: measurement requests (proposals and their measurements), searchable, the open one highlighted. */
export function RequestsList({ selectedId, onPick }: { selectedId: string; onPick?: () => void }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const { list, rows, total } = useRequestRows(q);
  const navigate = useNavigate();
  const create = useMeasure();
  // Nothing in the list matches what was typed: offer to look the address up and measure it
  const offerNew = q !== '' && q === text.trim() && list.isSuccess && rows.length === 0 && !list.hasNextPage;
  const measureNew = () =>
    create.mutate(
      { address: q },
      { onSuccess: (created) => void navigate(`/estimator/measure/${created.id}`) },
    );
  const newFailed = create.error instanceof ApiError && create.error.message !== '' ? create.error.message : measure.measureNewFailed;

  return (
    <section className={styles.root} aria-labelledby="measure-requests-title">
      <header className={styles.head}>
        <h2 id="measure-requests-title" className={styles.title}>
          {measure.requestsTitle}
        </h2>
        {list.isSuccess ? (
          <span className={styles.count} aria-label={measure.requestsCount(total)}>
            {total}
          </span>
        ) : null}
      </header>
      <p className={styles.subtitle}>{measure.requestsSubtitle}</p>
      <div className={styles.search}>
        <svg className={styles.glass} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.5 10.5 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <Field
          label={measure.requestsSearch}
          labelHidden
          placeholder={measure.requestsSearch}
          type="search"
          autoComplete="off"
          maxLength={100}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </div>
      {list.isError && rows.length === 0 ? (
        <p className={styles.note} role="alert">
          {measure.requestsFailed}
        </p>
      ) : list.isPending ? (
        <Skeleton lines={4} />
      ) : rows.length === 0 ? (
        <p className={styles.note}>{q === '' ? measure.requestsEmpty : measure.requestsNoMatches}</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.measurementId} className={styles.item}>
              <UiLink
                href={`/estimator/measure/${row.measurementId}`}
                className={styles.row}
                aria-current={row.measurementId === selectedId ? 'true' : undefined}
                data-selected={row.measurementId === selectedId ? 'true' : undefined}
                onClick={onPick}
              >
                <span className={styles.name}>{row.name}</span>
                <span className={styles.address}>{row.address}</span>
                {row.material !== null ? <span className={styles.material}>{row.material}</span> : null}
                <span className={styles.chip} data-status={row.status}>
                  {measure.status[row.status]}
                </span>
                {row.squares !== null ? <span className={styles.squares}>{measure.squaresShort(row.squares)}</span> : null}
              </UiLink>
              {row.status === 'estimate_sent' || row.status === 'signed' ? (
                <UiLink
                  href={`/estimator/proposals/${row.proposalId}`}
                  className={styles.proposal}
                  aria-label={measure.proposalLinkLabel(row.name)}
                  onClick={onPick}
                >
                  {measure.proposalLink}
                </UiLink>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {offerNew ? (
        <div className={styles.newRoof}>
          <p className={styles.note}>{measure.measureNewHint}</p>
          <Button className={styles.newRoofButton} busy={create.isPending} disabled={create.isPending} onClick={measureNew}>
            {create.isPending ? measure.measureNewBusy : measure.measureNew(q)}
          </Button>
          {create.isError ? (
            <div role="alert">
              <Banner tone="danger">{newFailed}</Banner>
            </div>
          ) : null}
        </div>
      ) : null}
      {list.hasNextPage ? (
        <Button variant="ghost" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {measure.requestsShowMore}
        </Button>
      ) : null}
    </section>
  );
}
