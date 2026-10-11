import { eq } from 'drizzle-orm';
import { activities, auditLog, customers, jobs, properties, withTenant, type Tx } from '@roofline/db';
import type { SeedUser } from '@roofline/db/testing';
import { loginAs, type SuperAgent, type TestApp } from './helpers.ts';

/** Shared by the properties, jobs, rep-visibility and isolation tests. */

export const NO_UUID = '00000000-0000-4000-8000-000000000000';
export const NOT_FOUND = "We couldn't find that.";

export type Who = 'owner' | 'office' | 'rep' | 'otherRep';
export type CompanyKey = 'a' | 'b';

/** One signed-in agent per member per test (a login is slow: it hashes a password). */
export class Actors {
  private readonly logins = new Map<string, Promise<SuperAgent>>();

  constructor(private readonly t: TestApp) {}

  as(who: Who, company: CompanyKey = 'a'): Promise<SuperAgent> {
    const key = `${company}:${who}`;
    let agent = this.logins.get(key);
    if (!agent) {
      agent = loginAs(this.t.app, this.t.seed[company][who]);
      this.logins.set(key, agent);
    }
    return agent;
  }

  user(who: Who, company: CompanyKey = 'a'): SeedUser {
    return this.t.seed[company][who];
  }
}

/** A system-role context for looking at the tenant tables directly. */
export function inCompany<T>(t: TestApp, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(t.deps.pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);
}

export type Created = { id: string } & Record<string, unknown>;

/** POSTs a body and returns the 201 response body; fails the test with the response when it is not a 201. */
export async function mustCreate(agent: SuperAgent, path: string, body: Record<string, unknown>): Promise<Created> {
  const res = await agent.post(path).send(body);
  if (res.status !== 201) throw new Error(`POST ${path} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Created;
}

/** A street address that is different for each `n`. */
export const addressFor = (n: number) => ({
  addressLine: `${100 + n} Oak St`,
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
});

export const dbJob = (t: TestApp, companyId: string, id: string) =>
  inCompany(t, companyId, async (tx) => (await tx.select().from(jobs).where(eq(jobs.id, id)))[0]!);

export const dbProperty = (t: TestApp, companyId: string, id: string) =>
  inCompany(t, companyId, async (tx) => (await tx.select().from(properties).where(eq(properties.id, id)))[0]!);

export const dbCustomer = (t: TestApp, companyId: string, id: string) =>
  inCompany(t, companyId, async (tx) => (await tx.select().from(customers).where(eq(customers.id, id)))[0]!);

export const dbActivities = (t: TestApp, companyId: string, subjectId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(activities).where(eq(activities.subjectId, subjectId)));

export const dbAudit = (t: TestApp, companyId: string, action: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)));

/** `[kind, summary]` pairs of a subject's timeline, sorted so the order of same-instant lines does not matter. */
export async function timeline(t: TestApp, companyId: string, subjectId: string): Promise<[string, string][]> {
  const rows = await dbActivities(t, companyId, subjectId);
  return rows.map((r): [string, string] => [r.kind, r.summary]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}
