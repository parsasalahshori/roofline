import { sql } from 'drizzle-orm';
import type { ProposalStatus } from '@roofline/shared';
import type { Db } from '../pools.ts';

/*
 * Resolves a homeowner link to its proposal. Runs on the app_system pool, which may SELECT only
 * id, company_id, link_token_hash, status and valid_until of proposals: nothing else is read here.
 * The match is the unique index on link_token_hash; the token itself is never compared in code.
 */
export async function resolveProposalToken(
  system: Db,
  tokenHash: Buffer,
): Promise<{ companyId: string; proposalId: string; status: ProposalStatus; validUntil: string } | null> {
  const result = await system.execute(
    sql`select id, company_id, status, valid_until::text as valid_until from proposals where link_token_hash = ${tokenHash} limit 1`,
  );
  const row = result.rows[0] as { id: string; company_id: string; status: ProposalStatus; valid_until: string } | undefined;
  if (!row) return null;
  return { companyId: row.company_id, proposalId: row.id, status: row.status, validUntil: String(row.valid_until).slice(0, 10) };
}
