import { createHash } from 'node:crypto';
import { getClaimPacketFacts, storeFile, withTenant } from '@roofline/db';
import { stepTypes } from '@roofline/shared';
import { ObjectStoreUnavailableError } from '../providers/object-store.ts';
import { pdfToBuffer } from '../proposals/pdf.ts';
import type { StepHandler, StepOutcome } from '../tasks/runner.ts';
import { renderClaimPacketPdf } from './packet-pdf.ts';

const UNREADABLE = 'This step could not be read.';
const NO_STORAGE = "File storage isn't set up.";
const NO_CLAIM = 'We could not find that claim.';

const failed = (errorPlain: string): StepOutcome => ({ status: 'failed', result: { built: 0 }, errorPlain });

/**
 * Builds the claim packet PDF for one job and stores it as a new `claim_packet` file (a rerun stores
 * a second version; the newest wins). The facts are re-read at run time. Nothing is sent to anyone.
 */
export const buildClaimPacketStep: StepHandler = async (deps, ctx, step) => {
  const payload = stepTypes.build_claim_packet.payload.safeParse(step.payload);
  if (!payload.success) return { status: 'needs_attention', result: { built: 0 }, errorPlain: UNREADABLE };
  if (!deps.objectStore.configured) return failed(NO_STORAGE);

  const { jobId } = payload.data as { jobId: string };
  const facts = await withTenant(deps.pools, ctx, (tx) => getClaimPacketFacts(tx, ctx, jobId));
  if (facts === null) return failed(NO_CLAIM);

  const mapImage = facts.propertyCenter === null ? null : await deps.staticMap.image({ center: facts.propertyCenter });
  const bytes = await pdfToBuffer(renderClaimPacketPdf({ facts, mapImage }));

  const now = deps.clock.now();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const key = `claim-packets/${facts.claimId}/${stamp}-${step.id.slice(0, 8)}.pdf`;
  try {
    await deps.objectStore.put(key, bytes, 'application/pdf');
  } catch (err) {
    if (err instanceof ObjectStoreUnavailableError) return failed(NO_STORAGE);
    throw err;
  }
  await withTenant(deps.pools, ctx, (tx) =>
    storeFile(
      tx,
      ctx,
      {
        kind: 'claim_packet',
        objectKey: key,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        contentType: 'application/pdf',
      },
      now,
    ),
  );
  return { status: 'done', result: { built: 1 } };
};
