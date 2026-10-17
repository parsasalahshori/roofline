import { CLAIM_STATUSES, isTimeZone, type ClaimBoardRow, type ClaimStatus } from '@roofline/shared';
import { Banner, EmptyState, Panel, Skeleton, UiLink } from '@roofline/ui';
import { claims } from '../../copy/claims.ts';
import { useClaimsBoard } from '../claims/api.ts';
import { useCompany } from '../settings/api.ts';
import styles from './ClaimsBoard.module.css';

const FALLBACK_ZONE = 'America/Chicago';

/** The company's zone when it is one Intl knows, the Chicago default otherwise. Never the browser's. */
function useCompanyZone(): string {
  const company = useCompany();
  const zone = company.data?.timezone;
  return zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_ZONE;
}

function dayLabel(iso: string, zone: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: zone });
}

function ClaimCard({ row, zone }: { row: ClaimBoardRow; zone: string }) {
  return (
    <li>
      <UiLink href={`/jobs/${row.jobId}`} className={styles.card}>
        <strong className={styles.name}>{row.customerName}</strong>
        <span className={styles.meta}>{row.address ?? claims.noAddress}</span>
        <span className={styles.meta}>{row.insurer ?? claims.noInsurer}</span>
        {row.claimNumber !== null && <span className={styles.number}>{claims.claimNumberLine(row.claimNumber)}</span>}
        <span className={styles.meta}>{claims.since(dayLabel(row.statusChangedAt, zone))}</span>
      </UiLink>
    </li>
  );
}

function Column({ status, rows, zone }: { status: ClaimStatus; rows: ClaimBoardRow[]; zone: string }) {
  const headingId = `claims-column-${status}`;
  return (
    <section className={styles.column} aria-labelledby={headingId} data-status={status}>
      <div className={styles.columnHead}>
        <h3 id={headingId} className={styles.columnHeading}>
          {claims.status[status]}
        </h3>
        <span className={styles.count}>{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>{claims.columnEmpty}</p>
      ) : (
        <ul className={styles.cards}>
          {rows.map((row) => (
            <ClaimCard key={row.claimId} row={row} zone={zone} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every claim on one board, a column per status, each card opening its job. */
export function ClaimsBoard() {
  const board = useClaimsBoard();
  const zone = useCompanyZone();
  const rows = board.data;
  // The empty state brings its own room; the panel's padding on top of it made the box tall for one line
  const empty = !board.isPending && !board.isError && rows !== undefined && rows.length === 0;

  return (
    <Panel title={claims.boardTitle} padded={!empty}>
      {board.isPending ? (
        <div role="status" aria-label={claims.boardLoading}>
          <Skeleton lines={4} />
        </div>
      ) : board.isError || !rows ? (
        <Banner tone="danger">{claims.boardLoadError}</Banner>
      ) : rows.length === 0 ? (
        <EmptyState title={claims.boardEmpty} />
      ) : (
        <div className={styles.columns}>
          {CLAIM_STATUSES.map((status) => (
            <Column key={status} status={status} rows={rows.filter((row) => row.status === status)} zone={zone} />
          ))}
        </div>
      )}
    </Panel>
  );
}
