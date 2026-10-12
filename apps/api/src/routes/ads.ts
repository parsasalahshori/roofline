import { Router } from 'express';
import { z } from 'zod';
import { listAdAccounts, withTenant } from '@roofline/db';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { requireCapability } from '../permissions.ts';
import {
  BAD_GOOGLE_ID,
  BAD_META_ID,
  checkAdAccount,
  connectGoogleAccount,
  connectMetaAccount,
  normalizeGoogleCustomerId,
  normalizeMetaAdAccountId,
  revokeAdAccount,
} from '../storm/ad-accounts.ts';
import { parse, UUID } from '../validate.ts';

const GoogleBody = z.object({ customerId: z.string({ error: BAD_GOOGLE_ID }) });
const MetaBody = z.object({ adAccountId: z.string({ error: BAD_META_ID }) });

/** Linking the company's Google and Meta ad accounts. Reads are open to every member; changes are the owner's. */
export function adsRoutes(deps: AppDeps): Router {
  const router = Router();
  const ownerOnly = requireCapability('company_admin');

  function idParam(raw: unknown): string {
    if (typeof raw !== 'string' || !UUID.test(raw)) throw new AppError(404, MESSAGES.notFound);
    return raw;
  }

  router.get('/accounts', async (req, res) => {
    const { ctx } = req;
    const accounts = await withTenant(deps.pools, ctx, (tx) => listAdAccounts(tx, ctx));
    res.json({ accounts, managerId: deps.adsGoogle.managerId, businessId: deps.adsMeta.businessId });
  });

  router.post('/accounts/google', ownerOnly, async (req, res) => {
    const body = parse(GoogleBody, req.body);
    const customerId = normalizeGoogleCustomerId(body.customerId);
    if (customerId === null) throw new AppError(400, BAD_GOOGLE_ID, 'customerId');
    const result = await connectGoogleAccount(deps, req.ctx, customerId, deps.clock.now());
    res.status(201).json({ account: result.account, instructions: result.instructions });
  });

  router.post('/accounts/meta', ownerOnly, async (req, res) => {
    const body = parse(MetaBody, req.body);
    const adAccountId = normalizeMetaAdAccountId(body.adAccountId);
    if (adAccountId === null) throw new AppError(400, BAD_META_ID, 'adAccountId');
    const result = await connectMetaAccount(deps, req.ctx, adAccountId, deps.clock.now());
    res.status(201).json({ account: result.account });
  });

  router.post('/accounts/:id/check', ownerOnly, async (req, res) => {
    const account = await checkAdAccount(deps, req.ctx, idParam(req.params.id), deps.clock.now());
    res.json({ account });
  });

  router.delete('/accounts/:id', ownerOnly, async (req, res) => {
    const account = await revokeAdAccount(deps, req.ctx, idParam(req.params.id), deps.clock.now());
    res.json({ account });
  });

  return router;
}
