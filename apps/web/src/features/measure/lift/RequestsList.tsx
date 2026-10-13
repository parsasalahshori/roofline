import { useEffect, useState } from 'react';
import { Button, Field, Skeleton, UiLink } from '@roofline/ui';
import { measure } from '../../../copy/measure.ts';
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
            <li key={row.measurementId}>
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
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button variant="ghost" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {measure.requestsShowMore}
        </Button>
      ) : null}
    </section>
  );
}
