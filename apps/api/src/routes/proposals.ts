import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  companies,
  companySettings,
  getProposal,
  listProposals,
  type ProposalPatch,
  updateDraftProposal,
  withTenant,
} from '@roofline/db';
import { AddOnSchema, PROPOSAL_STATUSES } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { buildProposal } from '../estimator/build.ts';
import { repriceFromMeasurement } from '../estimator/reprice.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { can } from '../permissions.ts';
import { renderProposalPdf } from '../proposals/pdf.ts';
import { assertKnownFields, emailField, noNul, offsetParam, parse, UUID } from '../validate.ts';

/** The 409 for a change to a proposal that has been sent. */
export const SENT_PROPOSAL_MESSAGE = 'This proposal was sent. Make a revised proposal to change it.';

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
    wastePercent: z.number({ error: MESSAGES.checkField }).finite().min(0).max(50).optional(),
    markupPercent: z.number({ error: MESSAGES.checkField }).finite().min(0).max(100).optional(),
    addOns: z.array(AddOnSchema).max(8).optional(),
  })
  .strict();

const PatchBody = z.object({
  options: z.array(OptionPatch).max(3).optional(),
  messageBody: z.string({ error: MESSAGES.checkField }).min(1).max(640).refine(noNul).optional(),
});

const ListQuery = z.object({
  status: z.enum(PROPOSAL_STATUSES, { error: MESSAGES.checkField }).optional(),
  q: z.string({ error: MESSAGES.checkField }).trim().max(100, MESSAGES.checkField).refine(noNul, MESSAGES.checkField).optional(),
  signedOn: z.string({ error: MESSAGES.checkField }).regex(/^\d{4}-\d{2}-\d{2}$/, MESSAGES.checkField).optional(),
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
    const result = await withTenant(pools, ctx, (tx) => updateDraftProposal(tx, ctx, id, patch, clock.now()));
    if (result === 'not_draft') throw new AppError(409, SENT_PROPOSAL_MESSAGE);
    if (!result) throw new AppError(404, MESSAGES.notFound);
    res.json(result);
  });

  router.post('/:id/revise', async (req, res) => {
    const { ctx } = req;
    const id = proposalId(req.params.id);
    const current = await withTenant(pools, ctx, (tx) => getProposal(tx, ctx, id));
    if (!current) throw new AppError(404, MESSAGES.notFound);
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
      financing: settings?.apr != null && settings.months != null ? { aprBps: settings.apr, months: settings.months } : null,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="proposal-${view.number}.pdf"`);
    doc.pipe(res);
    doc.end();
  });

  // GET /:id/link and POST /:id/send arrive with E1 Task 11.

  return router;
}
