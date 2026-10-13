import { CLAIM_STATUSES, isTimeZone, type ClaimBoardRow, type ClaimStatus } from '@roofline/shared';
import { useEffect, useRef, useState } from 'react';
import { Banner, Button, EmptyState, Field, Skeleton, UiLink } from '@roofline/ui';
import { claims } from '../../copy/claims.ts';
import { useClaimsBoard } from '../claims/api.ts';
import { ClaimSection } from '../job/ClaimSection.tsx';
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

function ClaimCard({ row, zone, onSelect, selected }: { row: ClaimBoardRow; zone: string; onSelect(id: string): void; selected: string | null }) {
  return (
    <li className={styles.row} data-selected={selected === row.claimId}>
      <UiLink href={`/jobs/${row.jobId}`} className={styles.card}>
        <span className={styles.customer}><strong className={styles.name}>{row.customerName}</strong><span className={styles.meta}>{row.address ?? claims.noAddress}</span></span>
        <span className={styles.carrier}><span>{row.insurer ?? claims.noInsurer}</span>{row.claimNumber !== null && <span className={styles.meta}>{claims.claimNumberLine(row.claimNumber)}</span>}</span>
        <span className={styles.meta}>{claims.since(dayLabel(row.statusChangedAt, zone))}</span>
      </UiLink>
      <Button variant="ghost" className={styles.inspect} aria-label={claims.inspect(row.customerName)} aria-pressed={selected === row.claimId} onClick={() => onSelect(row.claimId)}>{claims.details}</Button>
    </li>
  );
}

function Column({ status, rows, zone, onSelect, selected }: { status: ClaimStatus; rows: ClaimBoardRow[]; zone: string; onSelect(id: string): void; selected: string | null }) {
  const headingId = `claims-column-${status}`;
  return (
    <section className={styles.column} aria-labelledby={headingId} data-status={status}>
      <h4 id={headingId} className={styles.columnHeading}>
        {claims.status[status]}
      </h4>
      {rows.length === 0 ? (
        <p className={styles.empty}>{claims.columnEmpty}</p>
      ) : (
        <ul className={styles.cards}>
          {rows.map((row) => (
            <ClaimCard key={row.claimId} row={row} zone={zone} onSelect={onSelect} selected={selected} />
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
  const [filter, setFilter] = useState<ClaimStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const term = search.trim().toLocaleLowerCase('en-US');
  const visible = rows?.filter((row) =>
    (filter === 'all' || row.status === filter) &&
    [row.customerName, row.address, row.insurer, row.claimNumber].some((value) => value?.toLocaleLowerCase('en-US').includes(term)),
  ) ?? [];
  const selectedRow = visible.find((row) => row.claimId === selected);
  const selectedClaimId = selectedRow?.claimId;
  useEffect(() => {
    if (selectedClaimId !== undefined) panel.current?.focus();
  }, [selectedClaimId]);
  function clearFilters() { setFilter('all'); setSearch(''); }


  return (
    <section className={styles.section}>
      <div className={styles.header}><h3 className={styles.heading}>{claims.boardTitle}</h3><p>{claims.boardIntro}</p></div>
      {board.isPending ? (
        <div role="status" aria-label={claims.boardLoading}>
          <Skeleton lines={4} />
        </div>
      ) : !rows ? (
        <div className={styles.error}><Banner tone="danger">{claims.boardLoadError}</Banner><Button variant="ghost" onClick={() => void board.refetch()}>{claims.retry}</Button></div>
      ) : rows.length === 0 ? (
        <EmptyState title={claims.boardEmpty} />
      ) : (
        <>
          {board.isError ? <Banner tone="warning">{claims.refreshFailed}</Banner> : null}
          <Field label={claims.search} placeholder={claims.searchPlaceholder} value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className={styles.filters} role="group" aria-label={claims.filters}>
            <Button variant="ghost" className={styles.filter} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{`${claims.all} ${rows.length}`}</Button>
            {CLAIM_STATUSES.map((status) => <Button key={status} variant="ghost" className={styles.filter} aria-pressed={filter === status} onClick={() => setFilter(status)}>{`${claims.status[status]} ${rows.filter((row) => row.status === status).length}`}</Button>)}
          </div>
          <p role="status" className={styles.resultCount}>{claims.matching(visible.length)}</p>
          {visible.length === 0 ? <EmptyState title={claims.noMatches} action={<Button variant="ghost" onClick={clearFilters}>{claims.clearFilters}</Button>} /> : (
            <div className={styles.workspace} data-inspecting={selectedRow !== undefined}>
            <div className={styles.columns}>
              {CLAIM_STATUSES.filter((status) => filter === 'all' || status === filter).map((status) => (
                <Column key={status} status={status} rows={visible.filter((row) => row.status === status)} zone={zone} onSelect={setSelected} selected={selectedRow?.claimId ?? null} />
              ))}
            </div>
            {selectedRow ? (
              <aside ref={panel} tabIndex={-1} className={styles.detailPanel} aria-label={claims.detailPanel}>
                <div className={styles.detailHeader}><strong>{selectedRow.customerName}</strong><Button href={`/jobs/${selectedRow.jobId}`} variant="ghost">{claims.openJob}</Button></div>
                <ClaimSection key={selectedRow.jobId} jobId={selectedRow.jobId} onSaved={() => void board.refetch()} />
              </aside>
            ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
