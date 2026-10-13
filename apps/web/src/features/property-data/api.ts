import type { PropertyRecordResponse } from '@roofline/shared';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../api/client.ts';

export const propertyRecordKeys = {
  record: (propertyId: string) => ['properties', propertyId, 'record'] as const,
};

/** Paid providers bill each lookup, so a record is kept for the session once fetched. */
const KEEP_MS = 30 * 60 * 1000;

/**
 * `GET /api/properties/:id/record`: the home's public owner and parcel record and a street photo. Runs only when
 * `enabled` (a person opened the record), since each lookup can cost money.
 */
export function usePropertyRecord(propertyId: string, enabled: boolean) {
  return useQuery({
    queryKey: propertyRecordKeys.record(propertyId),
    queryFn: ({ signal }) =>
      apiFetch<PropertyRecordResponse>(`/api/properties/${encodeURIComponent(propertyId)}/record`, { signal }),
    enabled,
    staleTime: KEEP_MS,
    gcTime: KEEP_MS,
    retry: false,
  });
}
