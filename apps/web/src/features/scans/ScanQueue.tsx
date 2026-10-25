import { Icon, Segmented, Skeleton, UiLink } from '@roofline/ui';
import type { ScanQueueItem } from '@roofline/shared';
import { useSearchParams } from 'react-router';
import { scanReview } from '../../copy/scanReview.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { useScanQueue } from './api.ts';
import apple from './apple.module.css';
import { SlaChip, StatusChip } from './Chips.tsx';
import styles from './ScanQueue.module.css';
import { type QueueFilter, parseFilter, QUEUE_FILTERS } from './scanMarks.ts';
import { useNow } from './useNow.ts';

/** What a row is called: the room and the window's own name, else the address. */
export const scanTitle = (s: Pick<ScanQueueItem, 'room' | 'label' | 'address'>): string => {
  const parts = [s.room, s.label].filter((p) => p !== '');
  return parts.length > 0 ? parts.join('  ·  ') : s.address;
};

function Row({ scan, now }: { scan: ScanQueueItem; now: Date }) {
  const title = scanTitle(scan);
  // The SLA ticks on the screen: worked out from its time here, not from the answer's age
  const left = scan.expedite || scan.slaDueAt === '' || !['needs_review', 'in_review', 'junior_done'].includes(scan.status) ? null : Math.round((new Date(scan.slaDueAt).getTime() - now.getTime()) / 1000);
  const why = scan.failed.filter((code) => code !== 'no_closeups').slice(0, 2).map((code) => scanReview.failedShort[code]);
  return (
    <li>
      <UiLink href={`/scans/${scan.id}`} className={styles.row} aria-label={scanReview.rowLabel(title)}>
        <span className={styles.thumb} aria-hidden="true">
          {scan.thumbUrl ? <img src={scan.thumbUrl} alt="" loading="lazy" decoding="async" /> : null}
        </span>
        <span className={styles.text}>
          <p className={styles.rowTitle}>{title}</p>
          <p className={styles.rowSub}>{[scan.homeowner ?? scanReview.homeownerUnknown, scan.address].join('  ·  ')}</p>
          {why.length > 0 && scan.status !== 'measured' ? <p className={styles.rowWhy}>{why.join('  ·  ')}</p> : null}
        </span>
        <span className={styles.meta}>
          <StatusChip status={scan.status} />
          <SlaChip secondsLeft={left} expedite={scan.expedite} />
        </span>
        <Icon name="chev" size={16} className={styles.chev} />
      </UiLink>
    </li>
  );
}

function Loading() {
  return (
    <ul className={apple.group} role="status" aria-label={scanReview.loading}>
      {[0, 1, 2].map((i) => (
        <li key={i} className={styles.skeleton}>
          <Skeleton width="64px" height="48px" />
          <div>
            <Skeleton width="50%" height="1.1rem" />
            <Skeleton width="80%" height="0.9rem" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ScanQueue() {
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('show'));
  const query = useScanQueue(filter);
  const now = useNow(30_000);
  const counts = query.data?.counts;
  const countOf: Record<QueueFilter, number | undefined> = {
    todo: counts ? counts.needs_review + counts.in_review : undefined,
    senior: counts?.junior_done,
    done: counts ? counts.measured + counts.visit_required : undefined,
  };
  const scans = query.data?.scans ?? [];
  return (
    <AppPage app="scans" bare>
      <div className={apple.root}>
        <div className={styles.page}>
          <div className={styles.column}>
            <header className={styles.head}>
              <div>
                <h2 className={styles.title}>{scanReview.title}</h2>
                {query.data ? <p className={styles.sub}>{scanReview.count(scans.length)}</p> : null}
              </div>
            </header>
            <div className={styles.filters}>
              <Segmented
                label={scanReview.filterLabel}
                value={filter}
                onChange={(next) => setParams(next === 'todo' ? {} : { show: next }, { replace: true })}
                options={QUEUE_FILTERS.map((value) => ({ value, label: scanReview.filters[value], count: countOf[value] }))}
              />
            </div>
            {query.isPending ? (
              <Loading />
            ) : query.isError && !query.data ? (
              <div className={styles.empty} role="alert">
                <p className={styles.emptyBody}>{scanReview.loadFailed}</p>
              </div>
            ) : scans.length === 0 ? (
              <div className={apple.group}>
                <div className={styles.empty}>
                  <span className={styles.emptyIcon}>
                    <Icon name="camera" size={22} />
                  </span>
                  <p className={styles.emptyTitle}>{scanReview.emptyTitle[filter]}</p>
                  <p className={styles.emptyBody}>{scanReview.emptyBody[filter]}</p>
                </div>
              </div>
            ) : (
              <ul className={`${apple.group} ${styles.list}`} aria-label={scanReview.queueLabel}>
                {scans.map((scan) => (
                  <Row key={scan.id} scan={scan} now={now} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </AppPage>
  );
}
