/* eslint-disable @typescript-eslint/no-unused-vars -- placeholder: its parameters are used when the real body lands */
import type { Config } from '../config.ts';
import type { CalendarApi } from './calendar.ts';

/** The Microsoft Graph calendar adapter; a later task builds it. Null until then. */
export function microsoftCalendarFor(_config: Config): CalendarApi | null {
  return null;
}
