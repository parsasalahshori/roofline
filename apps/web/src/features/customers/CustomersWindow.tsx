import type { ConsentStatus } from '@roofline/shared';
import { Button, EmptyState, Field, Pill, Select, Skeleton, Toggle, UiLink, type SelectOption } from '@roofline/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { customers } from '../../copy/customers.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { JobsTabs } from '../jobs/JobsTabs.tsx';
import { ConsentChip } from './ConsentChip.tsx';
import { type CustomerListItem, PAGE_SIZE, useCustomers } from './api.ts';
import styles from './CustomersWindow.module.css';

/** How long the search waits after the last key before it asks the server. */
const SEARCH_DEBOUNCE_MS = 300;

/** The texting filter: '' anyone, 'ok' attested or written, 'not' every other status. */
type TextingFilter = '' | 'ok' | 'not';

const isTextingOk = (status: ConsentStatus): boolean => status === 'attested' || status === 'written';

/** The primary phone when one is marked, else the first one; '' when there is none. */
const primaryPhone = (row: CustomerListItem): string => (row.phones.find((phone) => phone.primary) ?? row.phones[0])?.number ?? '';

/** Name link, the archived and do-not-contact chips; shared by the table and the phone list. */
function NameCell({ row }: { row: CustomerListItem }) {
  return (
    <>
      <UiLink href={`/customers/${row.id}`} className={styles.nameLink}>
        {row.displayName}
      </UiLink>
      <span className={styles.chips}>
        {row.archivedAt === null ? null : <Pill tone="neutral">{customers.list.archivedChip}</Pill>}
        {row.doNotContact ? <Pill tone="neutral">{customers.doNotContact}</Pill> : null}
      </span>
    </>
  );
}

function TagPills({ tags }: { tags: string[] }) {
  return (
    <span className={styles.chips}>
      {tags.map((tag) => (
        <Pill key={tag} tone="neutral">
          {tag}
        </Pill>
      ))}
    </span>
  );
}

/**
 * The customers on one page of the list: a table on a desktop, stacked rows on a phone.
 * City and jobs count are not here: the list endpoint does not send them yet (follow-up: a list endpoint that returns them).
 */
function CustomerRows({ rows, phone }: { rows: CustomerListItem[]; phone: boolean }) {
  if (phone) {
    return (
      <ul className={styles.stack} aria-label={customers.list.tableLabel}>
        {rows.map((row) => (
          <li key={row.id} className={styles.row} data-archived={row.archivedAt !== null ? true : undefined}>
            <NameCell row={row} />
            <div className={styles.meta}>
              <span>{primaryPhone(row)}</span>
              <ConsentChip status={row.smsConsent.status} />
            </div>
            <TagPills tags={row.tags} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <table className={styles.table} aria-label={customers.list.tableLabel}>
      <thead>
        <tr>
          <th scope="col">{customers.list.columnName}</th>
          <th scope="col">{customers.list.columnPhone}</th>
          <th scope="col">{customers.list.columnTexting}</th>
          <th scope="col">{customers.list.columnTags}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-archived={row.archivedAt !== null ? true : undefined}>
            <td>
              <NameCell row={row} />
            </td>
            <td>{primaryPhone(row)}</td>
            <td>
              <ConsentChip status={row.smsConsent.status} />
            </td>
            <td>
              <TagPills tags={row.tags} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The Customers window: the shared tabs, a search, the tag, texting and archived controls, the
 * list with its paging, and the buttons for a new customer and the CSV download.
 */
export function CustomersWindow() {
  const [params] = useSearchParams();
  const me = useMe();
  const phone = useIsPhone();
  const canExport = me.data?.role === 'owner' || me.data?.role === 'office';

  // The Edit sheet links here as /customers?q=<number> to find a duplicate, so the URL sets the first search
  const [searchText, setSearchText] = useState(() => params.get('q') ?? '');
  const [term, setTerm] = useState(() => (params.get('q') ?? '').trim());
  const [offset, setOffset] = useState(0);
  const [tag, setTag] = useState('');
  const [texting, setTexting] = useState<TextingFilter>('');
  const [archived, setArchived] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const list = useCustomers({ q: term, archived, offset });

  const onSearch = (value: string) => {
    setSearchText(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setTerm(value.trim());
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
  };

  // Follow-up: server filter. Tag and texting filter only the rows already loaded, not the whole list.
  const loaded = list.data?.customers ?? [];
  const rows = loaded.filter((row) => {
    if (tag !== '' && !row.tags.includes(tag)) return false;
    if (texting === 'ok' && !isTextingOk(row.smsConsent.status)) return false;
    if (texting === 'not' && isTextingOk(row.smsConsent.status)) return false;
    return true;
  });

  // The tags on the loaded page, sorted; the chosen tag stays an option even when this page lacks it
  const tagValues = [...new Set([...loaded.flatMap((row) => row.tags), ...(tag === '' ? [] : [tag])])].sort((a, b) =>
    a.localeCompare(b),
  );
  const tagOptions: SelectOption[] = [{ value: '', label: customers.list.allTags }, ...tagValues.map((value) => ({ value, label: value }))];
  const textingOptions: SelectOption[] = [
    { value: '', label: customers.list.allTexting },
    { value: 'ok', label: customers.list.textingOk },
    { value: 'not', label: customers.list.textingNot },
  ];

  const total = list.data?.total ?? 0;
  const from = offset + 1;
  const to = offset + loaded.length;
  const noSearchOrFilters = term === '' && tag === '' && texting === '' && !archived;

  const toolbar = (
    <div className={styles.toolbar}>
      <Field
        label={customers.list.searchLabel}
        type="search"
        placeholder={customers.list.searchPlaceholder}
        value={searchText}
        onChange={(event) => onSearch(event.currentTarget.value)}
        className={styles.search}
      />
      <div role="group" aria-label={customers.list.filtersLabel} className={styles.filters}>
        <Select
          label={customers.list.tagLabel}
          value={tag}
          options={tagOptions}
          onChange={setTag}
          className={styles.control}
        />
        <Select
          label={customers.list.textingLabel}
          value={texting}
          options={textingOptions}
          onChange={(value) => setTexting(value === 'ok' || value === 'not' ? value : '')}
          className={styles.control}
        />
        <Toggle
          checked={archived}
          onChange={(next) => {
            setArchived(next);
            setOffset(0);
          }}
          label={customers.list.showArchived}
        />
      </div>
      <div className={styles.actions}>
        <Button href="/customers/new">{customers.list.newCustomer}</Button>
        {canExport ? (
          // A plain download link. Button passes the download attribute through to the anchor.
          <Button href="/api/export/customers.csv" variant="ghost" {...{ download: true }}>
            {customers.list.download}
          </Button>
        ) : null}
      </div>
    </div>
  );

  let body: ReactNode;
  if (list.isError) {
    body = (
      <EmptyState
        title={customers.list.loadFailed}
        action={
          <Button variant="ghost" onClick={() => void list.refetch()}>
            {customers.list.retry}
          </Button>
        }
      />
    );
  } else if (list.isPending) {
    body = (
      <div role="status" aria-label={customers.list.loading} className={styles.loading}>
        <Skeleton lines={4} height="48px" />
      </div>
    );
  } else if (loaded.length === 0 && noSearchOrFilters) {
    body = <EmptyState title={customers.list.empty} />;
  } else if (rows.length === 0) {
    body = <EmptyState title={customers.list.noMatches} />;
  } else {
    body = <CustomerRows rows={rows} phone={phone} />;
  }

  return (
    <div className={styles.workspace}>
      <JobsTabs />
      {toolbar}
      {tag !== '' || texting !== '' ? <p className={styles.range}>{customers.list.pageFiltersHelp}</p> : null}
      {body}
      {!list.isPending && !list.isError && total > PAGE_SIZE ? (
        <div className={styles.paging}>
          <Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            {customers.list.previous}
          </Button>
          <span className={styles.range}>{customers.list.range(from, to, total)}</span>
          <Button variant="ghost" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            {customers.list.next}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
