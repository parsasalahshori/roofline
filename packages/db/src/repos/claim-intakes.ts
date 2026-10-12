import { and, asc, eq } from 'drizzle-orm';
import { claimIntakes } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

export type ClaimIntakeRow = typeof claimIntakes.$inferSelect;

export type ClaimIntakeInput = {
  jobId: string | null;
  conversationId: string | null;
  insurer: string;
  claimNumber: string | null;
  dateOfLoss: string | null;
  description: string;
  adjusterVisitAt: Date | null;
  takenBy: 'front_desk' | 'user';
};

export async function findClaimIntake(
  tx: Tx,
  ctx: TenantContext,
  key: { conversationId: string; insurer: string; description: string },
): Promise<{ id: string; jobId: string | null } | null> {
  const [existing] = await tx
    .select({ id: claimIntakes.id, jobId: claimIntakes.jobId })
    .from(claimIntakes)
    .where(
      and(
        eq(claimIntakes.companyId, ctx.companyId),
        eq(claimIntakes.conversationId, key.conversationId),
        eq(claimIntakes.insurer, key.insurer),
        eq(claimIntakes.description, key.description),
      ),
    )
    .limit(1);
  return existing ?? null;
}

/**
 * Stores a claim intake. Idempotent per conversation: a row with the same company, conversation, insurer and
 * description is returned instead of a second one (`created` is then false).
 */
export async function insertClaimIntake(
  tx: Tx,
  ctx: TenantContext,
  input: ClaimIntakeInput,
): Promise<{ id: string; jobId: string | null; created: boolean }> {
  if (input.conversationId !== null) {
    const existing = await findClaimIntake(tx, ctx, {
      conversationId: input.conversationId,
      insurer: input.insurer,
      description: input.description,
    });
    if (existing) return { id: existing.id, jobId: existing.jobId, created: false };
  }
  const [row] = await tx
    .insert(claimIntakes)
    .values({
      companyId: ctx.companyId,
      jobId: input.jobId,
      conversationId: input.conversationId,
      insurer: input.insurer,
      claimNumber: input.claimNumber,
      dateOfLoss: input.dateOfLoss,
      description: input.description,
      adjusterVisitAt: input.adjusterVisitAt,
      takenBy: input.takenBy,
    })
    .returning({ id: claimIntakes.id });
  return { id: row!.id, jobId: input.jobId, created: true };
}

export async function listClaimIntakesForJob(tx: Tx, ctx: TenantContext, jobId: string): Promise<ClaimIntakeRow[]> {
  return tx
    .select()
    .from(claimIntakes)
    .where(and(eq(claimIntakes.companyId, ctx.companyId), eq(claimIntakes.jobId, jobId)))
    .orderBy(asc(claimIntakes.createdAt), asc(claimIntakes.id));
}
