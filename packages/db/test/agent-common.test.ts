import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, test } from "vitest";
import { createPools } from "../src/pools.ts";
import {
  AGENT_VALUE_DEFAULTS,
  agentCompanyFacts,
  firstWord,
  hasAgentTaskBetween,
  primaryTextingPhone,
  readAgentValues,
  settingsRowId,
} from "../src/repos/agent-common.ts";
import { insertTask } from "../src/repos/tasks.ts";
import { type TenantContext, withTenant } from "../src/tenant.ts";
import {
  resetDb,
  type SeededCompany,
  seedTwoCompanies,
} from "../src/testing/index.ts";

const urls = inject("dbUrls");
const pools = createPools({ tenant: urls.tenant, system: urls.system });

let seed: { a: SeededCompany; b: SeededCompany };

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

function ctxFor(c: SeededCompany): TenantContext {
  return {
    companyId: c.companyId,
    userId: null,
    role: "owner",
    canApproveSpend: true,
  };
}

async function ownerSql(text: string, params: unknown[]) {
  const client = new pg.Client({ connectionString: urls.owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

describe("primaryTextingPhone", () => {
  test("trims the number", () => {
    expect(primaryTextingPhone([{ e164: " +15551230000 " }])).toBe(
      "+15551230000",
    );
  });

  test("prefers the primary over the first", () => {
    expect(
      primaryTextingPhone([
        { e164: "+15551230001" },
        { e164: "+15551230002", primary: true },
      ]),
    ).toBe("+15551230002");
  });

  test("skips a blank number", () => {
    expect(
      primaryTextingPhone([
        { e164: "  ", primary: true },
        { e164: "+15551230003" },
      ]),
    ).toBe("+15551230003");
  });

  test("is null when the chosen number is a landline, even with a second mobile", () => {
    expect(
      primaryTextingPhone([
        { e164: "+15551230004", primary: true, label: " Landline " },
        { e164: "+15551230005", label: "mobile" },
      ]),
    ).toBeNull();
  });

  test("is null for no phones and for only landlines", () => {
    expect(primaryTextingPhone([])).toBeNull();
    expect(
      primaryTextingPhone([{ e164: "+15551230006", label: "landline" }]),
    ).toBeNull();
  });
});

describe("firstWord", () => {
  test("takes the first word of a trimmed name", () => {
    expect(firstWord(" Ann Lee ")).toBe("Ann");
  });

  test("is null for empty, undefined and null", () => {
    expect(firstWord("")).toBeNull();
    expect(firstWord(undefined)).toBeNull();
    expect(firstWord(null)).toBeNull();
  });
});

describe("hasAgentTaskBetween", () => {
  const from = new Date("2026-10-13T00:00:00Z");
  const to = new Date("2026-10-14T00:00:00Z");
  const inside = new Date("2026-10-13T12:00:00Z");

  async function make(
    c: SeededCompany,
    agent: "scheduler" | "claims",
    kind: string,
    at: Date,
  ) {
    const ctx = ctxFor(c);
    await withTenant(pools, ctx, (tx) =>
      insertTask(tx, ctx, { agent, kind, title: "T", steps: [] }, at),
    );
  }

  async function has(
    c: SeededCompany,
    agent: "scheduler" | "claims",
    kind: string,
  ) {
    const ctx = ctxFor(c);
    return withTenant(pools, ctx, (tx) =>
      hasAgentTaskBetween(tx, ctx, { agent, kind, from, to }),
    );
  }

  test("is true for a task created inside the window", async () => {
    await make(seed.a, "scheduler", "reminders", inside);
    expect(await has(seed.a, "scheduler", "reminders")).toBe(true);
  });

  test("includes from and excludes to", async () => {
    await make(seed.a, "scheduler", "reminders", from);
    expect(await has(seed.a, "scheduler", "reminders")).toBe(true);
    await resetDb(urls.owner);
    seed = await seedTwoCompanies(urls.owner);
    await make(seed.a, "scheduler", "reminders", to);
    expect(await has(seed.a, "scheduler", "reminders")).toBe(false);
  });

  test("is false for another agent, kind or company", async () => {
    await make(seed.a, "scheduler", "reminders", inside);
    expect(await has(seed.a, "claims", "reminders")).toBe(false);
    expect(await has(seed.a, "scheduler", "weather_moves")).toBe(false);
    expect(await has(seed.b, "scheduler", "reminders")).toBe(false);
  });
});

describe("agentCompanyFacts", () => {
  test("returns the status, name and time zone", async () => {
    const ctx = ctxFor(seed.a);
    const facts = await withTenant(pools, ctx, (tx) =>
      agentCompanyFacts(tx, ctx),
    );
    expect(facts).not.toBeNull();
    expect(typeof facts!.timeZone).toBe("string");
    expect(typeof facts!.name).toBe("string");
    expect(typeof facts!.status).toBe("string");
  });
});

describe("readAgentValues", () => {
  test("returns the schema defaults when there is no settings row", async () => {
    await ownerSql("delete from company_settings where company_id = $1", [
      seed.a.companyId,
    ]);
    const ctx = ctxFor(seed.a);
    const values = await withTenant(pools, ctx, (tx) =>
      readAgentValues(tx, ctx),
    );
    expect(values).toEqual(AGENT_VALUE_DEFAULTS);
    expect(values).toEqual({
      claimsNudgeDays: [3, 5, 7],
      weatherRainPct: 60,
      weatherGustMph: 25,
      reminderHour: 15,
      followupDays: [3, 4],
      leadFollowupDays: 2,
      reviewLink: null,
      reviewDelayDays: 3,
      followupReviews: true,
      followupLeads: true,
      followupProposals: true,
    });
  });

  test("reads a changed column and defaults the rest", async () => {
    await ownerSql(
      "update company_settings set weather_gust_mph = 40 where company_id = $1",
      [seed.a.companyId],
    );
    const ctx = ctxFor(seed.a);
    const values = await withTenant(pools, ctx, (tx) =>
      readAgentValues(tx, ctx),
    );
    expect(values).toEqual({ ...AGENT_VALUE_DEFAULTS, weatherGustMph: 40 });
  });

  test("settingsRowId makes the missing row and returns the same id after", async () => {
    await ownerSql("delete from company_settings where company_id = $1", [
      seed.a.companyId,
    ]);
    const ctx = ctxFor(seed.a);
    const first = await withTenant(pools, ctx, (tx) => settingsRowId(tx, ctx));
    const second = await withTenant(pools, ctx, (tx) => settingsRowId(tx, ctx));
    expect(second).toBe(first);
  });
});
