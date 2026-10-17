import { useSearchParams } from 'react-router';
import type { BoardFilterParams } from './api.ts';

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

/** True when anything narrows the board: an assignee, a source or a search (the archived view is a view, not a filter). */
export function isNarrowed(filter: BoardFilterParams): boolean {
  return filter.assigned !== undefined || filter.source !== undefined || filter.q !== undefined;
}

/** Board or list, as the URL says (`?view=list`). A phone is always the list; the caller decides that. */
export function useJobsView(): 'board' | 'list' {
  const [params] = useSearchParams();
  return params.get('view') === 'list' ? 'list' : 'board';
}
