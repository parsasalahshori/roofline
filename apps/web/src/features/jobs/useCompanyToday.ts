import { isTimeZone, localDate } from '@roofline/shared';
import { useCompany } from '../settings/api.ts';

/** The zone a company with no (or an unknown) zone is read in. Never the browser's. */
const FALLBACK_ZONE = 'America/Chicago';

/** The company's time zone when it is one Intl knows, the Chicago default otherwise. Never the browser's. */
export function useCompanyZone(): string {
  const zone = useCompany().data?.timezone;
  return zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_ZONE;
}

/** Today's calendar day (YYYY-MM-DD) in the company's time zone: what "today" means for a next step. */
export function useCompanyToday(): string {
  const zone = useCompanyZone();
  return localDate(new Date(), zone);
}
