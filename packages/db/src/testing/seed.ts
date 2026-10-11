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

/** One user of a company made by `seedCompany`. */
export type SeedCompanyUser = { email: string; name: string; role: Role; canApproveSpend?: boolean };

/** What `seedCompany` makes. Every user gets `password`, a verified email and an active membership. */
export type SeedCompanySpec = {
  name: string;
  slug: string;
  /** Left out: the column default (America/Chicago). */
  timezone?: string;
  /** `companies.address_state`, for example 'NE'. Left out: none. */
  state?: string;
  /** `companies.phone_e164`. Left out: none. */
  phoneE164?: string;
  users: SeedCompanyUser[];
  password: string;
};

/** One user `seedCompany` made. */
export type SeededMember = { userId: string; email: string; name: string; role: Role; password: string };

/** What `seedCompany` returns: the company and its users, in the order the spec listed them. */
export type SeededCompanyBase = {
  companyId: string;
  slug: string;
  name: string;
  phoneE164: string | null;
  users: SeededMember[];
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
 * Inserts one company with its default settings, an approved texting registration and the users the
 * spec lists, in one transaction. Each user gets the spec's password (hashed once per call, or the
 * cached hash when the password is `SEED_PASSWORD`), a verified email and an active membership.
 * Returns the company and its users in spec order. Connects as the table owner, so it works before
 * and after RLS is enabled.
 */
export async function seedCompany(ownerUrl: string, spec: SeedCompanySpec): Promise<SeededCompanyBase> {
  const passwordHash =
    spec.password === SEED_PASSWORD ? await getSeedPasswordHash() : await hashPassword(spec.password);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const db = drizzle(client);
    const now = new Date();
    return await db.transaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({
          name: spec.name,
          slug: spec.slug,
          phoneE164: spec.phoneE164 ?? null,
          ...(spec.timezone === undefined ? {} : { timezone: spec.timezone }),
          addressState: spec.state ?? null,
          status: 'trial',
          trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
        })
        .returning({ id: companies.id });
      const companyId = company!.id;
      await tx.insert(companySettings).values({ companyId });
      await tx.insert(textingRegistrations).values({ companyId, campaignStatus: 'approved', approvedAt: now });

      const members: SeededMember[] = [];
      for (const u of spec.users) {
        const [user] = await tx
          .insert(users)
          .values({ email: u.email, name: u.name, passwordHash, emailVerifiedAt: now })
          .returning({ id: users.id });
        const userId = user!.id;
        await tx.insert(memberships).values({
          companyId,
          userId,
          role: u.role,
          canApproveSpend: u.canApproveSpend ?? false,
          status: 'active',
        });
        members.push({ userId, email: u.email, name: u.name, role: u.role, password: spec.password });
      }
      return { companyId, slug: spec.slug, name: spec.name, phoneE164: spec.phoneE164 ?? null, users: members };
    });
  } finally {
    await client.end();
  }
}

/** The spec for one of the two fixed companies: the four MEMBERS in order, all in Central time, Nebraska. */
function twoCompanySpec(c: (typeof COMPANIES)[number]): SeedCompanySpec {
  return {
    name: c.name,
    slug: c.slug,
    phoneE164: c.phoneE164,
    timezone: 'America/Chicago',
    state: 'NE',
    password: SEED_PASSWORD,
    users: MEMBERS.map((m) => ({
      email: `${m.local}@${c.key}.test`,
      name: `${c.name.split(' ')[0]} ${m.label}`,
      role: m.role,
      canApproveSpend: false,
    })),
  };
}

/**
 * The F1 shape of one of the two fixed companies. `seeded.users` is in MEMBERS order (see
 * `twoCompanySpec`), so the four fixed members are read by position.
 */
function toSeededCompany(seeded: SeededCompanyBase, phoneE164: string): SeededCompany {
  const [owner, office, rep, otherRep] = seeded.users.map(
    (u): SeedUser => ({ userId: u.userId, email: u.email, password: SEED_PASSWORD }),
  );
  return {
    companyId: seeded.companyId,
    slug: seeded.slug,
    name: seeded.name,
    phoneE164,
    owner,
    office,
    rep,
    otherRep,
  };
}

/**
 * Inserts two companies (Acme Roofing, then Bolt Roofing) with four active members each: an owner,
 * an office user without spend approval, and two reps. Every user has a verified email and the
 * password `correct-horse-battery`. Each company has default settings and an approved texting
 * registration. Each company is one `seedCompany` transaction, and the two run one after the other.
 * Connects as the table owner, so it works before and after RLS is enabled.
 */
export async function seedTwoCompanies(ownerUrl: string): Promise<{ a: SeededCompany; b: SeededCompany }> {
  const [acme, bolt] = COMPANIES;
  const a = await seedCompany(ownerUrl, twoCompanySpec(acme));
  const b = await seedCompany(ownerUrl, twoCompanySpec(bolt));
  return { a: toSeededCompany(a, acme.phoneE164), b: toSeededCompany(b, bolt.phoneE164) };
}
