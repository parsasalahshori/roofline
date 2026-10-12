import { Router } from 'express';
import { audit, withTenant } from '@roofline/db';
import { saveSubmission } from '@roofline/db/system';
import { type BrandInfo, BrandInfoSchema } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { hasPaymentMethod } from '../billing/guards.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import { policyUrls } from '../public/policy-urls.ts';
import { loadTextingCompany, textingView } from './texting/view.ts';

/** Refused until the company has a card on file (texting registration has a carrier fee). */
export const TEXTING_NEEDS_CARD = 'Add a card first. Texting registration has a carrier fee.';

/** A second submit while the registration is already with the carriers. */
export const TEXTING_ALREADY_WAITING = 'Your registration is already with the phone carriers.';

/** The EIN as the audit log keeps it: only the last four digits. `12-3456789` becomes `**-***6789`. */
function maskEin(ein: string): string {
  const digits = ein.replace(/\D/g, '');
  return `**-***${digits.slice(-4)}`;
}

/** True for a body that is a plain object (not an array, not null). Anything else counts as no fields. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `/api/texting`: the texting registration screen. Any member reads it (`GET /`); only the
 * company's admin submits it (`POST /registration`). A submit needs a confirmed email and a card.
 * The brand is then saved, audited, and queued for the `texting-registration` job, which sends it
 * to the carriers. The job is sent only after the saving has committed.
 */
export function textingRoutes(deps: AppDeps): Router {
  const { pools, clock, jobs, config } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await textingView(deps, req.ctx, req.session));
  });

  router.post('/registration', requireCapability('company_admin'), async (req, res) => {
    const { ctx, session } = req;
    const now = clock.now();

    // The 403s come first, so an office user or an unconfirmed owner is refused whatever the body says.
    if (!session.emailVerified) throw new AppError(403, MESSAGES.verifyEmailFirst);
    const company = await loadTextingCompany(pools, ctx);
    if (!hasPaymentMethod({ stripeSubscriptionId: company.stripeSubscriptionId, status: company.status })) {
      throw new AppError(403, TEXTING_NEEDS_CARD);
    }

    const body = isPlainObject(req.body) ? req.body : {};
    let brandInput: unknown = body.brand;
    // "Use the hosted pages" fills an empty website with the full URL of the company's privacy page,
    // not its origin: the company host answers 404 on / and vetting needs a 200 page that shows the
    // legal name, address and privacy text.
    if (body.useHostedPolicyPages === true && isPlainObject(brandInput)) {
      const website = typeof brandInput.website === 'string' ? brandInput.website.trim() : '';
      if (website === '') {
        brandInput = { ...brandInput, website: policyUrls(config, company.slug).privacy };
      }
    }

    const checked = BrandInfoSchema.safeParse(brandInput);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      const first = issue?.path[0];
      const field = first === undefined ? 'brand' : `brand.${String(first)}`;
      throw new AppError(400, issue?.message ?? MESSAGES.checkField, field);
    }
    const brand: BrandInfo = checked.data;

    const outcome = await saveSubmission(pools.system, ctx.companyId, brand, now);
    if (outcome === 'already_waiting') throw new AppError(409, TEXTING_ALREADY_WAITING);

    await withTenant(pools, ctx, (tx) =>
      audit(tx, ctx, {
        action: 'texting.registration_submitted',
        targetType: 'texting_registration',
        targetId: ctx.companyId,
        after: { brand: { ...brand, ein: maskEin(brand.ein) } },
        ip: req.ip ?? null,
        at: now,
      }),
    );

    await jobs.send('texting-registration', { companyId: ctx.companyId }, { singletonKey: ctx.companyId });

    res.status(202).json(await textingView(deps, ctx, session));
  });

  return router;
}
