import { eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { calls } from '../schema/index.ts';

/*
 * Call lookup for the ConversationRelay socket on the app_system pool (D1 Task 11). Only
 * apps/api/src/front-desk/relay-server.ts imports this. app_system may read only id, company_id,
 * call_sid and status of calls (Ruling BJ).
 */

export type RelayCallRow = { callId: string; companyId: string; callSid: string; status: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A call by id, or null when unknown or when the id is not a UUID (no query is made then). */
export async function relayCallById(system: Db, callId: string): Promise<RelayCallRow | null> {
  if (!UUID.test(callId)) return null;
  const [row] = await system
    .select({ callId: calls.id, companyId: calls.companyId, callSid: calls.callSid, status: calls.status })
    .from(calls)
    .where(eq(calls.id, callId))
    .limit(1);
  return row ?? null;
}
