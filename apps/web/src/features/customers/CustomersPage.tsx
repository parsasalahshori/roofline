import type { ConsentStatus } from '@roofline/shared';
import { Avatar, Button, Chip, Icon, Listbox, Table, Tag, Td, Th, Tr, UiLink, type ListboxOption } from '@roofline/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { customers } from '../../copy/customers.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { formatPhone } from '../jobs/format.ts';
import { JobsTabs } from '../jobs/JobsTabs.tsx';
import { SearchBox } from '../jobs/SearchBox.tsx';
import { EmptyPanel, LoadError, RowsSkeleton } from '../jobs/states.tsx';
import { ConsentChip } from './ConsentChip.tsx';
import { type CustomerListItem, PAGE_SIZE, useCustomers } from './api.ts';
import styles from './CustomersPage.module.css';

/** How long the search waits after the last key before it asks the server. */
const SEARCH_DEBOUNCE_MS = 300;

/** The texting filter: '' anyone, 'ok' attested or written, 'not' every other status. */
type TextingFilter = '' | 'ok' | 'not';

const isTextingOk = (status: ConsentStatus): boolean => status === 'attested' || status === 'written';

/** The primary phone when one is marked, else the first one; '' when there is none. */
const primaryPhone = (row: CustomerListItem): string => {
  const phone = row.phones.find((candidate) => candidate.primary) ?? row.phones[0];
  return phone === undefined ? '' : formatPhone(phone.number);
};

/** Name link, the archived and do-not-contact tags; shared by the table and the phone list. */
function NameCell({ row }: { row: CustomerListItem }) {
  return (
    <span className={styles.nameCell}>
      <Avatar name={row.displayName} size={28} />
      <UiLink href={`/customers/${row.id}`} className={styles.nameLink}>
        {row.displayName}
      </UiLink>
      {row.archivedAt === null ? null : <Tag>{customers.list.archivedChip}</Tag>}
      {row.doNotContact ? (
        <Tag tone="bad" icon="alert">
          {customers.doNotContact}
        </Tag>
      ) : null}
    </span>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className={styles.tags}>
      {tags.map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
    </span>
  );
}

/**
 * The customers on one page of the list: a table on a desktop, stacked cards on a phone.
 * City and jobs count are not here: the list endpoint does not send them yet (follow-up: a list endpoint that returns them).
 */
function CustomerRows({ rows, phone }: { rows: CustomerListItem[]; phone: boolean }) {
  if (phone) {
    return (
      <ul className={styles.stack} aria-label={customers.list.tableLabel}>
        {rows.map((row) => (
          <li key={row.id} className={styles.card} data-archived={row.archivedAt !== null ? true : undefined}>
            <NameCell row={row} />
            <span className={styles.cardMeta}>
              <span className={styles.phone}>{primaryPhone(row)}</span>
              <ConsentChip status={row.smsConsent.status} />
            </span>
            <TagList tags={row.tags} />
          </li>
        ))}
      </ul>
    );
  }

  // A Tags column over blank cells reads as a broken one: it shows only while some customer in the list has a tag
  const anyTags = rows.some((row) => row.tags.length > 0);

  return (
    <div className={styles.panel}>
      <Table aria-label={customers.list.tableLabel}>
        <thead>
          <tr>
            <Th>{customers.list.columnName}</Th>
            <Th>{customers.list.columnPhone}</Th>
            <Th>{customers.list.columnTexting}</Th>
            {anyTags ? <Th>{customers.list.columnTags}</Th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id} data-archived={row.archivedAt !== null ? true : undefined}>
              <Td>
                <NameCell row={row} />
              </Td>
              <Td className={styles.phone}>{primaryPhone(row)}</Td>
              <Td>
                <ConsentChip status={row.smsConsent.status} />
              </Td>
              {anyTags ? (
                <Td>
                  <TagList tags={row.tags} />
                </Td>
              ) : null}
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/**
 * The Customers page: its head (the count, New customer and Export), the shared tabs, a search with the tag, texting
 * and archived filters, and the list with its paging.
 */
export function CustomersPage() {
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
  const tagOptions: ListboxOption[] = [{ value: '', label: customers.list.allTags }, ...tagValues.map((value) => ({ value, label: value }))];
  const textingOptions: ListboxOption<TextingFilter>[] = [
    { value: '', label: customers.list.allTexting },
    { value: 'ok', label: customers.list.textingOk },
    { value: 'not', label: customers.list.textingNot },
  ];

  const total = list.data?.total ?? 0;
  const from = offset + 1;
  const to = offset + loaded.length;
  const noSearchOrFilters = term === '' && tag === '' && texting === '' && !archived;

  const clearFilters = () => {
    clearTimeout(searchTimer.current);
    setSearchText('');
    setTerm('');
    setTag('');
    setTexting('');
    setArchived(false);
    setOffset(0);
  };

  const subtitle =
    list.data === undefined ? null : noSearchOrFilters ? customers.list.count(total) : customers.list.matches(total);

  let body: ReactNode;
  if (list.isError) {
    body = (
      <LoadError
        tag={customers.list.errorTag}
        title={customers.list.loadFailed}
        retry={customers.list.retry}
        busy={list.isFetching}
        onRetry={() => void list.refetch()}
      />
    );
  } else if (list.isPending) {
    body = (
      <div role="status" aria-label={customers.list.loading}>
        <RowsSkeleton />
      </div>
    );
  } else if (loaded.length === 0 && noSearchOrFilters) {
    body = (
      <EmptyPanel
        title={customers.list.empty}
        body={customers.list.emptyBody}
        action={
          <Button href="/customers/new" variant="primary">
            <Icon name="plus" size={16} />
            {customers.list.newCustomer}
          </Button>
        }
      />
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyPanel
        title={customers.list.noMatches}
        body={customers.list.noMatchesBody}
        action={
          <Button variant="default" onClick={clearFilters}>
            {customers.list.clearFilters}
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <CustomerRows rows={rows} phone={phone} />
        {total > PAGE_SIZE ? (
          <div className={styles.paging}>
            <Button variant="default" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              {customers.list.previous}
            </Button>
            <span className={styles.range}>{customers.list.range(from, to, total)}</span>
            <Button variant="default" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              {customers.list.next}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <AppPage
      app="customers"
      subtitle={subtitle ?? ''}
      tabs={<JobsTabs />}
      actions={
        <>
          {canExport ? (
            // A plain download link. Button passes the download attribute through to the anchor.
            <Button href="/api/export/customers.csv" variant="default" {...{ download: true }}>
              <Icon name="download" size={16} />
              {customers.list.download}
            </Button>
          ) : null}
          <Button href="/customers/new" variant="primary">
            <Icon name="plus" size={16} />
            {customers.list.newCustomer}
          </Button>
        </>
      }
    >
      <div role="group" aria-label={customers.list.filtersLabel} className={styles.bar}>
        <div className={styles.chips}>
          <Listbox variant="chip" label={customers.list.tagLabel} value={tag} options={tagOptions} onChange={setTag} />
          <Listbox
            variant="chip"
            label={customers.list.textingLabel}
            value={texting}
            options={textingOptions}
            onChange={setTexting}
          />
          <Chip
            pressed={archived}
            onClick={() => {
              setArchived(!archived);
              setOffset(0);
            }}
          >
            {customers.list.archivedFilter}
          </Chip>
        </div>
        <SearchBox
          label={customers.list.searchLabel}
          placeholder={customers.list.searchPlaceholder}
          value={searchText}
          onChange={onSearch}
          slashFocus={!phone}
          className={styles.search}
        />
      </div>
      {body}
    </AppPage>
  );
}
