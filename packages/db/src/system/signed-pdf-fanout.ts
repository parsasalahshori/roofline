import { asc, eq } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { proposals } from '../schema/index.ts';

/*
 * The signed-PDF sweep's fan-out. Runs on the app_system pool, which may read only id, company_id,
 * link_token_hash, status and valid_until of proposals (and nothing of proposal_signatures). It only
 * LISTS the companies that have a signed proposal; which signatures still lack their PDF is read per
 * company inside `withTenant` (signaturesWithoutPdf).
 */

/** Companies with at least one signed proposal, each once. */
export async function companiesWithSignedProposals(system: Db): Promise<string[]> {
  const rows = await system
    .selectDistinct({ companyId: proposals.companyId })
    .from(proposals)
    .where(eq(proposals.status, 'signed'))
    .orderBy(asc(proposals.companyId));
  return rows.map((r) => r.companyId);
}
