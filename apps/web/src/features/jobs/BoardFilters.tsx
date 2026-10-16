import { JOB_SOURCES } from '@roofline/shared';
import { Listbox, Segmented, type ListboxOption } from '@roofline/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { TeamBody } from '../../api/types.ts';
import { jobs } from '../../copy/jobs.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { useJobsView } from './filter.ts';
import { SearchBox } from './SearchBox.tsx';
import styles from './BoardFilters.module.css';

/** How long the search waits after the last key before it writes to the URL. */
const SEARCH_DEBOUNCE_MS = 300;

const sourceOptions: ListboxOption[] = [
  { value: '', label: jobs.filterSourceAll },
  ...JOB_SOURCES.map((source) => ({ value: source, label: jobs.source[source] })),
];

const viewOptions = [
  { value: 'board', label: jobs.views.board },
  { value: 'list', label: jobs.views.list },
] as const;

/**
 * The bar above the board and the list: Board / List, the Assigned and Source chips, and the search. Everything is in the
 * URL. On a phone the list is the only view, so the switch goes and the chips share one row that scrolls sideways.
 */
export function BoardFilters() {
  const [params, setParams] = useSearchParams();
  const phone = useIsPhone();
  const view = useJobsView();
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

  const assigneeOptions: ListboxOption[] = [
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
      <div className={styles.chips}>
        {phone ? null : (
          <Segmented
            label={jobs.viewLabel}
            value={view}
            options={viewOptions}
            onChange={(next) => update({ view: next === 'list' ? 'list' : null })}
            size="sm"
            className={styles.views}
          />
        )}
        <Listbox
          variant="chip"
          label={jobs.filterAssignee}
          value={assignedValue}
          options={assigneeOptions}
          onChange={(value) => update({ assigned: value })}
        />
        <Listbox
          variant="chip"
          label={jobs.filterSource}
          value={sourceValue}
          options={sourceOptions}
          onChange={(value) => update({ source: value })}
        />
      </div>
      <SearchBox
        label={jobs.filterSearch}
        placeholder={jobs.filterSearchPlaceholder}
        value={searchText}
        onChange={onSearch}
        slashFocus={!phone}
        className={styles.search}
      />
    </div>
  );
}
