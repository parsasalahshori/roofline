/* eslint-disable @typescript-eslint/no-unused-vars -- placeholder: its parameters are used when the real body lands */
import type { CalendarConnectionRow, TenantContext } from '@roofline/db';
import type { AppDeps } from '../app.ts';

/** Pulls every due calendar connection's changes (C1 Task 14). Placeholder: does nothing. */
export async function pullCalendars(_deps: AppDeps, _now: Date): Promise<void> {}

/** Pulls one connection's changes now (C1 Task 14 fills this; C1 Task 12's `POST /api/calendar/sync` calls it). Placeholder: does nothing. */
export async function pullConnection(_deps: AppDeps, _ctx: TenantContext, _conn: CalendarConnectionRow): Promise<void> {}
