import { isTimeZone, localDate } from '@roofline/shared';
import { useCompany } from '../settings/api.ts';

/** The zone a company with no (or an unknown) zone is read in. Never the browser's. */
const FALLBACK_ZONE = 'America/Chicago';

/** Today's calendar day (YYYY-MM-DD) in the company's time zone: what "today" means for a next step. */
export function useCompanyToday(): string {
  const company = useCompany();
  const zone = company.data?.timezone;
  return localDate(new Date(), zone !== undefined && isTimeZone(zone) ? zone : FALLBACK_ZONE);
}
