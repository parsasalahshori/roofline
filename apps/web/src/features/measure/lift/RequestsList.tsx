import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Banner, Button, Field, Icon, Skeleton, Tag, UiLink, type IconName, type TagTone } from '@roofline/ui';
import { ApiError } from '../../../api/client.ts';
import { measure } from '../../../copy/measure.ts';
import { useMeasure, usePrefetchMeasure } from '../../estimator/api.ts';
import { looksCompleteAddress } from '../address.ts';
import type { MeasureHandoff } from '../handoff.ts';
import { useRequestRows, type RequestStatus } from './requests.ts';
import styles from './RequestsList.module.css';

/** How long the person has to stop typing before the search runs. */
const DEBOUNCE_MS = 250;
/** A typed address that stays put this much longer starts loading its roof before Measure is pressed. */
const PREFETCH_MS = 400;
/** Measuring that takes longer than this is loading a new area: say so, and roughly how long. */
const SLOW_MS = 3000;

/** Each request's status as a tag: its word, with a glyph, so the colour is never the only signal. */
const STATUS_TAG: Record<RequestStatus, { tone: TagTone; icon: IconName }> = {
  new_lead: { tone: 'info', icon: 'inbox' },
  inspection: { tone: 'warn', icon: 'clock' },
  estimate_sent: { tone: 'neutral', icon: 'msg' },
  signed: { tone: 'ok', icon: 'check' },
};

/** The left column: measurement requests (proposals and their measurements), searchable, the open one highlighted. */
export function RequestsList({ selectedId, onPick }: { selectedId: string; onPick?: () => void }) {
  const [params, setParams] = useSearchParams();
  // `?measure=<address>` (the shell search's "Measure roof"): measure that address straight away
  const [asked] = useState(() => params.get('measure')?.trim() ?? '');
  const [text, setText] = useState(asked);
  const [q, setQ] = useState(asked);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const { list, rows, total } = useRequestRows(q);
  const navigate = useNavigate();
  const create = useMeasure();
  const prefetch = usePrefetchMeasure();
  const prefetched = useRef(new Set<string>());
  // Nothing in the list matches what was typed: offer to look the address up and measure it
  const offerNew = q !== '' && q === text.trim() && list.isSuccess && rows.length === 0 && !list.hasNextPage;
  // The address in the URL leaves it once measured (or refused), so going back does not measure it again
  const dropAsked = () =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('measure');
        return next;
      },
      { replace: true },
    );
  const measureAddress = (address: string) => {
    // Measure does the prefetch's work itself
    prefetched.current.add(address);
    create.mutate(
      { address },
      {
        // The person asked to measure: the scan plays as soon as the roof opens
        onSuccess: (created) => void navigate(`/estimator/measure/${created.id}`, { state: { autoScan: true } satisfies MeasureHandoff }),
        onError: () => {
          if (params.has('measure')) dropAsked();
        },
      },
    );
  };
  const measureNew = () => measureAddress(q);
  const newFailed = create.error instanceof ApiError && create.error.message !== '' ? create.error.message : measure.measureNewFailed;

  // The address the window opened with is measured once
  const startedAsked = useRef(false);
  useEffect(() => {
    if (asked === '' || startedAsked.current) return;
    startedAsked.current = true;
    measureAddress(asked);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the address the window opened with
  }, [asked]);

  // A whole address typed and left alone starts loading its area and pitch before Measure is pressed
  const prefetchAddress = offerNew && !create.isPending && looksCompleteAddress(q) ? q : '';
  const prefetchRef = useRef(prefetch.mutate);
  useEffect(() => {
    prefetchRef.current = prefetch.mutate;
  });
  useEffect(() => {
    if (prefetchAddress === '' || prefetched.current.has(prefetchAddress)) return;
    const timer = setTimeout(() => {
      prefetched.current.add(prefetchAddress);
      prefetchRef.current({ address: prefetchAddress });
    }, PREFETCH_MS);
    return () => clearTimeout(timer);
  }, [prefetchAddress]);

  // A first measurement in a new area loads its outlines (about 30 seconds): after a few seconds, say so
  const [slowSince, setSlowSince] = useState<number | null>(null);
  const pendingSince = create.isPending ? create.submittedAt : null;
  useEffect(() => {
    if (pendingSince === null) return;
    const timer = setTimeout(() => setSlowSince(pendingSince), SLOW_MS);
    return () => clearTimeout(timer);
  }, [pendingSince]);
  const slow = pendingSince !== null && slowSince === pendingSince;

  return (
    <section className={styles.root} aria-labelledby="measure-requests-title">
      <div className={styles.top}>
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
        <Icon name="search" size={16} className={styles.glass} />
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
      </div>
      <div className={styles.scroll}>
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
                <Tag className={styles.chip} tone={STATUS_TAG[row.status].tone} icon={STATUS_TAG[row.status].icon} data-status={row.status}>
                  {measure.status[row.status]}
                </Tag>
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
      {offerNew || create.isPending ? (
        <div className={styles.newRoof}>
          <p className={styles.note}>{measure.measureNewHint}</p>
          <Button className={styles.newRoofButton} busy={create.isPending} disabled={create.isPending} onClick={measureNew}>
            {create.isPending ? measure.measureNewBusy : measure.measureNew(q)}
          </Button>
          {create.isPending && slow ? (
            <p className={styles.note} role="status">
              {measure.measureNewSlow}
            </p>
          ) : null}
          {create.isError ? (
            <div role="alert">
              <Banner tone="danger">{newFailed}</Banner>
            </div>
          ) : null}
        </div>
      ) : null}
      {list.hasNextPage ? (
        <Button variant="default" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {measure.requestsShowMore}
        </Button>
      ) : null}
      </div>
    </section>
  );
}
