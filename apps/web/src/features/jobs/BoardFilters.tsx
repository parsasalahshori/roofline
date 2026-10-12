import { JOB_SOURCES } from '@roofline/shared';
import { Button, Field, Select, Toggle, type SelectOption } from '@roofline/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { TeamBody } from '../../api/types.ts';
import { jobs } from '../../copy/jobs.ts';
import type { BoardFilterParams } from './api.ts';
import styles from './BoardFilters.module.css';

/** How long the search waits after the last key before it writes to the URL. */
const SEARCH_DEBOUNCE_MS = 300;

const sourceOptions: SelectOption[] = [
  { value: '', label: jobs.filterSourceAll },
  ...JOB_SOURCES.map((source) => ({ value: source, label: jobs.source[source] })),
];

/** The filter the URL asks for. Keys that are not set are left out; archived is set only for 'true'. */
export function useBoardFilter(): BoardFilterParams {
  const [params] = useSearchParams();
  const filter: BoardFilterParams = {};
  const assigned = params.get('assigned');
  if (assigned !== null && assigned !== '') filter.assigned = assigned;
  const source = params.get('source');
  if (source !== null && source !== '') filter.source = source;
  const q = params.get('q');
  if (q !== null && q !== '') filter.q = q;
  if (params.get('archived') === 'true') filter.archived = true;
  return filter;
}

/** The filter bar above the board and the list: assignee, source, search, archived, and the two buttons. */
export function BoardFilters() {
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const role = me.data?.role;
  const canSeeMoney = role === 'owner' || role === 'office';
  // A rep sees the three fixed assignee choices only; the member list is for owner and office
  const team = useQuery({
    queryKey: keys.team,
    queryFn: ({ signal }) => apiFetch<TeamBody>('/api/team', { signal }),
    enabled: canSeeMoney,
  });

  const assignedValue = params.get('assigned') ?? '';
  const sourceValue = params.get('source') ?? '';
  const archived = params.get('archived') === 'true';

  const [searchText, setSearchText] = useState(params.get('q') ?? '');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  /** Writes changes to the URL, keeping every other parameter (view included). An empty value removes the key. */
  const update = (changes: Record<string, string | null>) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  const onSearch = (value: string) => {
    setSearchText(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => update({ q: value }), SEARCH_DEBOUNCE_MS);
  };

  const assigneeOptions: SelectOption[] = [
    { value: '', label: jobs.filterAll },
    { value: 'me', label: jobs.filterMine },
    { value: 'unassigned', label: jobs.filterUnassigned },
    ...(canSeeMoney && team.data !== undefined
      ? team.data.members
          .filter((member) => member.status === 'active')
          .map((member) => ({ value: member.userId, label: member.name }))
      : []),
  ];

  return (
    <div role="group" aria-label={jobs.filtersLabel} className={styles.bar}>
      <Select
        label={jobs.filterAssignee}
        value={assignedValue}
        options={assigneeOptions}
        onChange={(value) => update({ assigned: value })}
        className={styles.control}
      />
      <Select
        label={jobs.filterSource}
        value={sourceValue}
        options={sourceOptions}
        onChange={(value) => update({ source: value })}
        className={styles.control}
      />
      <Field
        label={jobs.filterSearch}
        help={jobs.filterSearchHelp}
        type="search"
        value={searchText}
        onChange={(event) => onSearch(event.currentTarget.value)}
        className={styles.control}
      />
      <Toggle checked={archived} onChange={(next) => update({ archived: next ? 'true' : null })} label={jobs.showArchived} />
      <div className={styles.actions}>
        <Button href="/jobs/new" variant="primary">
          {jobs.newJob}
        </Button>
        {canSeeMoney ? (
          <a href="/api/export/jobs.csv" download className={styles.download}>
            {jobs.downloadJobs}
          </a>
        ) : null}
      </div>
    </div>
  );
}
