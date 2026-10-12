import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  addProposalEvent,
  companies,
  companySettings,
  decrypt,
  getProposal,
  getProposalLinkToken,
  listProposals,
  type ProposalPatch,
  proposalJobAssignee,
  UnknownProposalOptionError,
  updateDraftProposal,
  withTenant,
} from '@roofline/db';
import { AddOnSchema, PROPOSAL_STATUSES } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { buildProposal } from '../estimator/build.ts';
import { draftProposalSend, linkFor } from '../estimator/send-proposal.ts';
import { repriceFromMeasurement } from '../estimator/reprice.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can } from '../permissions.ts';
import { pdfToBuffer, renderProposalPdf } from '../proposals/pdf.ts';
import { assertKnownFields, emailField, noNul, offsetParam, parse, UUID } from '../validate.ts';

/** The 409 for a change to a proposal that has been sent. */
export const SENT_PROPOSAL_MESSAGE = 'This proposal was sent. Make a revised proposal to change it.';
/** The 409 for a revision of a signed proposal (Ruling EJ); checked again inside the re-price transaction (B9). */
export { SIGNED_PROPOSAL_MESSAGE } from '../estimator/reprice.ts';
/** The 409 for a link asked for before the proposal was sent (its token is minted at send). */
const NOT_SENT_YET_MESSAGE = 'Send the proposal first, then you can copy its link.';

const lowercase = (v: string): string => v.toLowerCase();
const uuid = z.string({ error: MESSAGES.checkField }).refine((v) => UUID.test(v), MESSAGES.checkField).transform(lowercase);

const CreateBody = z.object({
  measurementId: uuid,
  jobId: uuid.optional(),
  customer: z
    .object({
      name: z.string({ error: MESSAGES.checkField }).trim().min(1, MESSAGES.checkField).max(120, MESSAGES.checkField).refine(noNul, MESSAGES.checkField),
      phone: z.string({ error: MESSAGES.checkField }).trim().max(40, MESSAGES.checkField).refine(noNul, MESSAGES.checkField),
      email: emailField.optional(),
      askedByText: z.boolean({ error: MESSAGES.checkField }),
    })
    .strict()
    .optional(),
});

const OptionPatch = z
  .object({
    id: uuid,
    enabled: z.boolean({ error: MESSAGES.checkField }).optional(),
    name: z.string({ error: MESSAGES.checkField }).trim().min(1, MESSAGES.checkField).max(60, MESSAGES.checkField).refine(noNul, MESSAGES.checkField).optional(),
    material: z.enum(['architectural', 'premium', 'metal'], { error: MESSAGES.checkField }).optional(),
    wastePercent: z.number({ error: MESSAGES.checkField }).finite(MESSAGES.checkField).min(0, MESSAGES.checkField).max(50, MESSAGES.checkField).optional(),
    markupPercent: z.number({ error: MESSAGES.checkField }).finite(MESSAGES.checkField).min(0, MESSAGES.checkField).max(100, MESSAGES.checkField).optional(),
    addOns: z.array(AddOnSchema, { error: MESSAGES.checkField }).max(8, MESSAGES.checkField).optional(),
  })
  .strict();

const PatchBody = z.object({
  options: z.array(OptionPatch, { error: MESSAGES.checkField }).max(3, MESSAGES.checkField).optional(),
  messageBody: z.string({ error: MESSAGES.checkField }).min(1, MESSAGES.checkField).max(640, MESSAGES.checkField).refine(noNul, MESSAGES.checkField).optional(),
});

const ListQuery = z.object({
  status: z.enum(PROPOSAL_STATUSES, { error: MESSAGES.checkField }).optional(),
  q: z.string({ error: MESSAGES.checkField }).trim().max(100, MESSAGES.checkField).refine(noNul, MESSAGES.checkField).optional(),
  signedOn: z.string({ error: MESSAGES.checkField }).regex(/^\d{4}-\d{2}-\d{2}$/, MESSAGES.checkField).optional(),
  jobId: uuid.optional(),
  offset: offsetParam,
});

/** `/api/proposals`: build, list, open, edit a draft, revise and download the PDF. Reps see only proposals on jobs they can see (the repository scopes). */
export function proposalRoutes(deps: AppDeps): Router {
  const { pools, clock } = deps;
  const router = Router();

  const proposalId = (raw: unknown): string => {
    const id = (typeof raw === 'string' ? raw : '').toLowerCase();
    if (!UUID.test(id)) throw new AppError(404, MESSAGES.notFound);
    return id;
  };

  router.post('/', async (req, res) => {
    const { ctx } = req;
    const body = parse(CreateBody, assertKnownFields(req.body, ['measurementId', 'jobId', 'customer'], { allowEmpty: true }));
    const customer = body.customer;
    const view = await buildProposal(deps, ctx, {
      measurementId: body.measurementId,
      ...(body.jobId !== undefined && { jobId: body.jobId }),
      ...(customer !== undefined && {
        customer: { name: customer.name, phone: customer.phone, ...(customer.email !== undefined && { email: customer.email }), askedByText: customer.askedByText },
      }),
    });
    res.status(201).json(view);
  });

  router.get('/', async (req, res) => {
    const { ctx } = req;
    const query = parse(ListQuery, req.query);
    const result = await withTenant(pools, ctx, (tx) =>
      listProposals(tx, ctx, {
        ...(query.status !== undefined && { status: query.status }),
        ...(query.q !== undefined && query.q !== '' && { q: query.q }),
        ...(query.signedOn !== undefined && { signedOn: query.signedOn }),
        ...(query.jobId !== undefined && { jobId: query.jobId }),
        ...(query.offset !== undefined && { offset: query.offset }),
      }),
    );
    res.json({ proposals: result.proposals, total: result.total });
  });

  router.get('/:id', async (req, res) => {
    const { ctx } = req;
    const id = proposalId(req.params.id);
    const view = await withTenant(pools, ctx, (tx) => getProposal(tx, ctx, id));
    if (!view) throw new AppError(404, MESSAGES.notFound);
    res.json(view);
  });

  router.patch('/:id', async (req, res) => {
    const { ctx } = req;
    const id = proposalId(req.params.id);
    const body = parse(PatchBody, assertKnownFields(req.body, ['options', 'messageBody']));
    const patch: ProposalPatch = {
      ...(body.messageBody !== undefined && { messageBody: body.messageBody }),
      ...(body.options !== undefined && {
        options: body.options.map((o) => ({
          id: o.id,
          ...(o.enabled !== undefined && { enabled: o.enabled }),
          ...(o.name !== undefined && { name: o.name }),
          ...(o.material !== undefined && { material: o.material }),
          ...(o.wastePercent !== undefined && { wastePercent: o.wastePercent }),
          ...(o.markupPercent !== undefined && { markupPercent: o.markupPercent }),
          ...(o.addOns !== undefined && { addOns: o.addOns }),
        })),
      }),
    };
    const result = await withTenant(pools, ctx, (tx) => updateDraftProposal(tx, ctx, id, patch, clock.now())).catch((err: unknown) => {
      if (err instanceof UnknownProposalOptionError) throw new AppError(400, MESSAGES.checkField, `options.${err.index}.id`);
      throw err;
    });
    if (result === 'not_draft') throw new AppError(409, SENT_PROPOSAL_MESSAGE);
    if (!result) throw new AppError(404, MESSAGES.notFound);
    res.json(result);
  });

  router.post('/:id/revise', async (req, res) => {
    const { ctx } = req;
    const id = proposalId(req.params.id);
    const current = await withTenant(pools, ctx, (tx) => getProposal(tx, ctx, id));
    if (!current) throw new AppError(404, MESSAGES.notFound);
    // The status (signed, replaced; a 'ready' one becomes replaced) is decided inside the re-price, with the row locked.
    const result = await repriceFromMeasurement(deps, ctx, id, current.measurementId);
    res.status(201).json(result.proposal);
  });

  router.get('/:id/pdf', async (req, res) => {
    const { ctx } = req;
    const id = proposalId(req.params.id);
    const loaded = await withTenant(pools, ctx, async (tx) => {
      const view = await getProposal(tx, ctx, id);
      if (!view) return null;
      const [company] = await tx.select({ name: companies.name, phone: companies.phoneE164 }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
      const [settings] = await tx
        .select({ apr: companySettings.financingAprBps, months: companySettings.financingTermMonths })
        .from(companySettings)
        .where(eq(companySettings.companyId, ctx.companyId))
        .limit(1);
      return { view, company, settings };
    });
    if (!loaded) throw new AppError(404, MESSAGES.notFound);
    const { view, company, settings } = loaded;
    const doc = renderProposalPdf({
      audience: can(ctx, 'view_money_totals') ? 'internal' : 'homeowner',
      company: { name: company?.name ?? '', phone: company?.phone ?? null },
      proposal: view,
      estimateClause: null,
      financing: settings?.apr != null && settings.months != null ? { aprBps: settings.apr, months: settings.months } : null,
    });
    // Rendered in full before any header goes out, so a failure is a plain 500, never a cut-off download.
    const pdf = await pdfToBuffer(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="proposal-${view.number}.pdf"`);
    res.send(pdf);
  });

  // The Estimator's send: one approval of this text sends it. Owner and office may ask for it, and so may
  // the rep who is assigned the job; a rep on any other job gets the forbidden message.
  router.post('/:id/send', async (req, res) => {
    const { ctx } = req;
    const id = proposalId(req.params.id);
    const found = await withTenant(pools, ctx, (tx) => proposalJobAssignee(tx, ctx, id));
    if (!found) throw new AppError(404, MESSAGES.notFound);
    const mayAsk = can(ctx, 'approve_message') || (ctx.role === 'rep' && found.assignedUserId === ctx.userId);
    if (!mayAsk) throw new AppError(403, MESSAGES.roleCannot);
    const { taskId } = await draftProposalSend(deps, ctx, id);
    res.status(201).json({ taskId });
  });

  // The link to copy (Ruling ES): anyone who can see the proposal's job, reps included (the link is already in
  // the texts on the job's timeline). The repository scopes reps to their jobs. The token is decrypted for this
  // reply and never logged.
  router.get('/:id/link', async (req, res) => {
    const { ctx } = req;
    const id = proposalId(req.params.id);
    const url = await withTenant(pools, ctx, async (tx) => {
      const encrypted = await getProposalLinkToken(tx, ctx, id);
      if (encrypted === null) return null;
      if (encrypted.length === 0) throw new AppError(409, NOT_SENT_YET_MESSAGE);
      const token = decrypt(encrypted, deps.config.ENCRYPTION_KEY);
      await addProposalEvent(tx, ctx, { proposalId: id, kind: 'link_copied', at: clock.now() });
      return linkFor(deps.config, token);
    });
    if (url === null) throw new AppError(404, MESSAGES.notFound);
    res.json({ url });
  });

  return router;
}
