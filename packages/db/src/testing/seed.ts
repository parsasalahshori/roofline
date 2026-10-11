import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Role } from '@roofline/shared';
import { companies, companySettings, memberships, textingRegistrations, users } from '../schema/index.ts';

export const SEED_PASSWORD = 'correct-horse-battery' as const;

export type SeedUser = { userId: string; email: string; password: typeof SEED_PASSWORD };

export type SeededCompany = {
  companyId: string;
  slug: string;
  name: string;
  /** The company's own number, `companies.phone_e164`. */
  phoneE164: string;
  owner: SeedUser;
  office: SeedUser;
  rep: SeedUser;
  otherRep: SeedUser;
};

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 } as const;

/**
 * Password hash format: `scrypt$N$r$p$<salt base64>$<hash base64>` (64-byte key, 16-byte salt).
 * The API's own `hashPassword` (Task 6) writes and verifies the same format.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

// Hashing is deliberately slow, and every API test re-seeds, so the seed users share one hash per process.
let seedPasswordHash: Promise<string> | undefined;
function getSeedPasswordHash(): Promise<string> {
  seedPasswordHash ??= hashPassword(SEED_PASSWORD);
  return seedPasswordHash;
}

const COMPANIES = [
  { key: 'a', name: 'Acme Roofing', slug: 'acme-roofing', phoneE164: '+14025550199' },
  { key: 'b', name: 'Bolt Roofing', slug: 'bolt-roofing', phoneE164: '+14025550198' },
] as const;

const MEMBERS = [
  { member: 'owner', local: 'owner', label: 'Owner', role: 'owner' },
  { member: 'office', local: 'office', label: 'Office', role: 'office' },
  { member: 'rep', local: 'rep', label: 'Rep', role: 'rep' },
  { member: 'otherRep', local: 'rep2', label: 'Rep Two', role: 'rep' },
] as const satisfies readonly { member: string; local: string; label: string; role: Role }[];

const TRIAL_DAYS = 14;

/**
 * Inserts two companies (Acme Roofing and Bolt Roofing) with four active members each: an owner,
 * an office user without spend approval, and two reps. Every user has a verified email and the
 * password `correct-horse-battery`. Each company has default settings and an approved texting
 * registration. Connects as the table owner, so it works before and after RLS is enabled.
 */
export async function seedTwoCompanies(ownerUrl: string): Promise<{ a: SeededCompany; b: SeededCompany }> {
  const passwordHash = await getSeedPasswordHash();
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const db = drizzle(client);
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const seeded: Record<string, SeededCompany> = {};
      for (const c of COMPANIES) {
        const [company] = await tx
          .insert(companies)
          .values({
            name: c.name,
            slug: c.slug,
            phoneE164: c.phoneE164,
            timezone: 'America/Chicago',
            addressState: 'NE',
            status: 'trial',
            trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
          })
          .returning({ id: companies.id });
        const companyId = company!.id;
        await tx.insert(companySettings).values({ companyId });
        await tx.insert(textingRegistrations).values({ companyId, campaignStatus: 'approved', approvedAt: now });

        const people: Record<string, SeedUser> = {};
        for (const m of MEMBERS) {
          const email = `${m.local}@${c.key}.test`;
          const [user] = await tx
            .insert(users)
            .values({ email, name: `${c.name.split(' ')[0]} ${m.label}`, passwordHash, emailVerifiedAt: now })
            .returning({ id: users.id });
          await tx
            .insert(memberships)
            .values({ companyId, userId: user!.id, role: m.role, canApproveSpend: false, status: 'active' });
          people[m.member] = { userId: user!.id, email, password: SEED_PASSWORD };
        }
        seeded[c.key] = {
          companyId,
          slug: c.slug,
          name: c.name,
          phoneE164: c.phoneE164,
          owner: people.owner!,
          office: people.office!,
          rep: people.rep!,
          otherRep: people.otherRep!,
        };
      }
      return seeded;
    });
    return { a: result.a!, b: result.b! };
  } finally {
    await client.end();
  }
}
