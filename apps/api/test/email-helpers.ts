import { asc, eq } from "drizzle-orm";
import pg from "pg";
import { expect, inject } from "vitest";
import { companies, customers, messages, properties } from "@roofline/db";
import { insertOmahaStorm } from "@roofline/db/testing";
import type { StepType } from "@roofline/shared";
import { type Actors, type CompanyKey, inCompany } from "./crm-helpers.ts";
import type { TestApp } from "./helpers.ts";
import { dbSteps, newTask, seenOf } from "./task-helpers.ts";

/** Shared by the email-batch tests (S1 Task 12). */

/** 10:00 on a Tuesday in Chicago: inside everyone's sending hours. */
export { DAYTIME } from "./sms-helpers.ts";
/** Wednesday 14 October 2026, 21:30 in Chicago (CDT): past the 21:00 quiet-hours start, so an email waits. */
export const LATE_EVENING = new Date("2026-10-15T02:30:00.000Z");
/** The 08:00 Chicago (CDT) send time of an email held at LATE_EVENING. */
export const EIGHT_AM_CHICAGO = new Date("2026-10-15T13:00:00.000Z");
/** Thursday 15 October 2026, 08:01 in Chicago: just after the held emails are due. */
export const JUST_AFTER_EIGHT = new Date("2026-10-15T13:01:00.000Z");
/** The minute before they are due. */
export const JUST_BEFORE_EIGHT = new Date("2026-10-15T12:59:00.000Z");
/** The storm the emails talk about hit on this convective day: "yesterday" at DAYTIME. */
export const STORM_DAY = "2026-10-12";

export const COMPANY_ADDRESS = "1 Main St, Chicago, IL 60601";
export const OFFICE_EMAIL = "office@acme.test";
export const OPTED_OUT_EMAIL = "They unsubscribed from emails.";
export const NOT_TAKEN_EMAIL = "The email service didn't take this message.";
export const BLANK_REASON = "This message still has a blank to fill in.";

export const EMAIL_SUBJECT = "{hail_size} hail hit {street}";
export const EMAIL_BODY = [
  "Hi {first_name},",
  "",
  "{company} saw {day}'s storm drop {hail_size} hail near {street}. We offer free roof checks.",
  "",
  "{company_address}",
  "Unsubscribe: {unsubscribe}",
].join("\n");

export type EmailCustomer = {
  firstName: string;
  emails: string[];
  doNotContact?: boolean;
  archived?: boolean;
  timezone?: string | null;
};

let addressCounter = 0;

/** Inserts the customers (each with a home in a time zone, America/Chicago unless told otherwise) and returns their ids in order. */
export async function addEmailCustomers(
  t: TestApp,
  company: CompanyKey,
  list: readonly EmailCustomer[],
): Promise<string[]> {
  const companyId = t.seed[company].companyId;
  const now = t.clock.now();
  return inCompany(t, companyId, async (tx) => {
    const ids: string[] = [];
    for (const c of list) {
      const [row] = await tx
        .insert(customers)
        .values({
          companyId,
          displayName: `${c.firstName} Customer`,
          firstName: c.firstName,
          emails: c.emails,
          doNotContact: c.doNotContact ?? false,
          archivedAt: c.archived === true ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: customers.id });
      const customerId = row!.id;
      ids.push(customerId);
      const n = (addressCounter += 1);
      await tx.insert(properties).values({
        companyId,
        customerId,
        addressLine: `${n} Elm St`,
        city: "Chicago",
        state: "IL",
        zip: "60601",
        addressKey: `${n} elm st|60601`,
        timezone: c.timezone === undefined ? "America/Chicago" : c.timezone,
        createdAt: now,
        updatedAt: now,
      });
    }
    return ids;
  });
}

/** The company's postal address and office email, as the email gate needs them. */
export async function setCompanyAddress(
  t: TestApp,
  company: CompanyKey = "a",
): Promise<void> {
  const companyId = t.seed[company].companyId;
  await inCompany(t, companyId, (tx) =>
    tx
      .update(companies)
      .set({
        addressStreet: "1 Main St",
        addressCity: "Chicago",
        addressState: "IL",
        addressZip: "60601",
        email: OFFICE_EMAIL,
      })
      .where(eq(companies.id, companyId)),
  );
}

/** A real storm and the company's row for it (the day label and the mail tag come from it). Returns the company_storms id. */
export async function addCompanyStorm(
  t: TestApp,
  company: CompanyKey = "a",
  convectiveDay: string = STORM_DAY,
): Promise<string> {
  const owner = new pg.Pool({ connectionString: inject("dbUrls").owner });
  try {
    const q = async (text: string, values?: unknown[]) =>
      (await owner.query(text, values)).rows;
    const stormId = await insertOmahaStorm(q, convectiveDay);
    const rows = await q(
      "insert into company_storms (company_id, storm_id, max_in) values ($1, $2, $3) returning id",
      [t.seed[company].companyId, stormId, 1.75],
    );
    return rows[0]!.id as string;
  } finally {
    await owner.end();
  }
}

/** The per-recipient fields of the payload: hail size and street for each customer. */
export const fieldsFor = (
  customerIds: readonly string[],
): Record<string, Record<string, string>> =>
  Object.fromEntries(
    customerIds.map((id) => [
      id.toLowerCase(),
      { hail_size: '1.75"', street: "Maple St" },
    ]),
  );

/** A `send_email_batch` step for these customers. Overrides replace payload keys (undefined removes one). */
export function emailStep(
  customerIds: string[],
  overrides: Record<string, unknown> = {},
) {
  const payload: Record<string, unknown> = {
    purpose: "marketing",
    subject: EMAIL_SUBJECT,
    body: EMAIL_BODY,
    customerIds,
    fields: fieldsFor(customerIds),
    dedupePrefix: "storm:elm",
    ...overrides,
  };
  for (const key of Object.keys(payload))
    if (payload[key] === undefined) delete payload[key];
  return { type: "send_email_batch" as StepType, payload };
}

/** Makes a one-step `send_email_batch` task for these customers and has the owner approve it. The step is then queued. */
export async function approvedEmailBatch(
  t: TestApp,
  actors: Actors,
  customerIds: string[],
  overrides: Record<string, unknown> = {},
  company: CompanyKey = "a",
): Promise<{ taskId: string; stepId: string }> {
  const { taskId } = await newTask(t, company, {
    steps: [emailStep(customerIds, overrides)],
  });
  const steps = await dbSteps(t, company, taskId);
  const res = await (await actors.as("owner", company))
    .post(`/api/approvals/${taskId}/approve`)
    .send(seenOf(steps));
  expect(res.status).toBe(200);
  return { taskId, stepId: steps[0]!.id };
}

/** Every email message row of a step. */
export const emailMessages = (
  t: TestApp,
  company: CompanyKey,
  stepId: string,
) =>
  inCompany(t, t.seed[company].companyId, (tx) =>
    tx
      .select()
      .from(messages)
      .where(eq(messages.stepId, stepId))
      .orderBy(asc(messages.createdAt), asc(messages.id)),
  );
