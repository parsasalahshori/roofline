import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { JOB_STAGE_LABELS, localDate } from "@roofline/shared";
import { companies, customers, jobs, properties } from "../schema/index.ts";
import type { TenantContext, Tx } from "../tenant.ts";
import { CONSENT_LABELS } from "./customers.ts";

/** The header row of the customers CSV, in column order. */
export const CUSTOMER_EXPORT_HEADERS = [
  "Name",
  "First name",
  "Last name",
  "Phone",
  "Other phones",
  "Email",
  "Other emails",
  "Address",
  "City",
  "State",
  "ZIP",
  "Texting",
  "Do not contact",
  "Tags",
  "Source",
  "Created",
  "Archived",
];

/** The header row of the jobs CSV, in column order. */
export const JOB_EXPORT_HEADERS = [
  "Customer",
  "Address",
  "City",
  "State",
  "ZIP",
  "Stage",
  "Value",
  "Rep",
  "Source",
  "Lost reason",
  "Next step",
  "Next step date",
  "Stage since",
  "Created",
  "Archived",
];

type CsvValue = string | number | boolean | null;
type CsvRow = CsvValue[];

const DEFAULT_ZONE = "America/Chicago";

/** Text for a nullable column: null becomes an empty cell. */
function text(value: string | null | undefined): string {
  return value ?? "";
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** Dollars with two decimals, or an empty cell when the job has no value. */
function dollars(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

/** The company's zone, read once per export. */
async function companyZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  return row?.timezone ?? DEFAULT_ZONE;
}

/** Every member's name by user id, read once per export. `company_members` is the only way the tenant role sees names. */
async function memberNames(tx: Tx): Promise<Map<string, string>> {
  const result = await tx.execute(
    sql`select user_id, name from company_members`,
  );
  const names = new Map<string, string>();
  for (const row of result.rows) {
    names.set(row.user_id as string, row.name as string);
  }
  return names;
}

/**
 * Customers for the CSV, one row per customer in the header order. Archived customers are included.
 * Pages by id (keyset) so a long export never holds the whole table. Consent evidence is never selected.
 * Address columns come from the customer's oldest live property, or are empty when there is none.
 */
export async function* customerExportRows(
  tx: Tx,
  ctx: TenantContext,
  batch = 1000,
): AsyncGenerator<CsvRow> {
  const zone = await companyZone(tx, ctx);
  let lastId: string | null = null;
  for (;;) {
    const page = await tx
      .select({
        id: customers.id,
        displayName: customers.displayName,
        firstName: customers.firstName,
        lastName: customers.lastName,
        phones: customers.phones,
        emails: customers.emails,
        smsConsentStatus: customers.smsConsentStatus,
        doNotContact: customers.doNotContact,
        tags: customers.tags,
        source: customers.source,
        createdAt: customers.createdAt,
        archivedAt: customers.archivedAt,
      })
      .from(customers)
      .where(lastId === null ? undefined : gt(customers.id, lastId))
      .orderBy(asc(customers.id))
      .limit(batch);
    if (page.length === 0) return;

    const addresses = new Map<
      string,
      { addressLine: string; city: string; state: string; zip: string }
    >();
    const propertyRows = await tx
      .select({
        customerId: properties.customerId,
        addressLine: properties.addressLine,
        city: properties.city,
        state: properties.state,
        zip: properties.zip,
      })
      .from(properties)
      .where(
        and(
          inArray(
            properties.customerId,
            page.map((row) => row.id),
          ),
          isNull(properties.archivedAt),
        ),
      )
      .orderBy(asc(properties.createdAt), asc(properties.id));
    for (const row of propertyRows) {
      if (row.customerId !== null && !addresses.has(row.customerId)) {
        addresses.set(row.customerId, row);
      }
    }

    for (const row of page) {
      const primaryIndex = Math.max(
        0,
        row.phones.findIndex((phone) => phone.primary === true),
      );
      const primaryPhone = row.phones[primaryIndex]?.e164 ?? "";
      const otherPhones = row.phones
        .filter((_, index) => index !== primaryIndex)
        .map((phone) => phone.e164);
      const primaryEmail = row.emails[0] ?? "";
      const otherEmails = row.emails.slice(1);
      const address = addresses.get(row.id);

      yield [
        row.displayName,
        text(row.firstName),
        text(row.lastName),
        primaryPhone,
        otherPhones.join("; "),
        primaryEmail,
        otherEmails.join("; "),
        text(address?.addressLine),
        text(address?.city),
        text(address?.state),
        text(address?.zip),
        CONSENT_LABELS[row.smsConsentStatus],
        yesNo(row.doNotContact),
        row.tags.join("; "),
        row.source,
        localDate(row.createdAt, zone),
        yesNo(row.archivedAt !== null),
      ];
    }

    if (page.length < batch) return;
    lastId = page[page.length - 1]!.id;
  }
}

/**
 * Jobs for the CSV, one row per job in the header order. Archived jobs (and jobs of archived customers)
 * are included. Pages by id (keyset). The rep is the assigned member's name, or empty.
 */
export async function* jobExportRows(
  tx: Tx,
  ctx: TenantContext,
  batch = 1000,
): AsyncGenerator<CsvRow> {
  const zone = await companyZone(tx, ctx);
  const names = await memberNames(tx);
  let lastId: string | null = null;
  for (;;) {
    const page = await tx
      .select({
        id: jobs.id,
        customerName: customers.displayName,
        addressLine: properties.addressLine,
        city: properties.city,
        state: properties.state,
        zip: properties.zip,
        stage: jobs.stage,
        valueCents: jobs.valueCents,
        assignedUserId: jobs.assignedUserId,
        source: jobs.source,
        lostReason: jobs.lostReason,
        nextStep: jobs.nextStep,
        nextStepOn: jobs.nextStepOn,
        stageChangedAt: jobs.stageChangedAt,
        createdAt: jobs.createdAt,
        archivedAt: jobs.archivedAt,
      })
      .from(jobs)
      .innerJoin(customers, eq(jobs.customerId, customers.id))
      .leftJoin(properties, eq(jobs.propertyId, properties.id))
      .where(lastId === null ? undefined : gt(jobs.id, lastId))
      .orderBy(asc(jobs.id))
      .limit(batch);
    if (page.length === 0) return;

    for (const row of page) {
      yield [
        row.customerName,
        text(row.addressLine),
        text(row.city),
        text(row.state),
        text(row.zip),
        JOB_STAGE_LABELS[row.stage],
        dollars(row.valueCents),
        row.assignedUserId ? (names.get(row.assignedUserId) ?? "") : "",
        row.source,
        text(row.lostReason),
        text(row.nextStep),
        text(row.nextStepOn),
        localDate(row.stageChangedAt, zone),
        localDate(row.createdAt, zone),
        yesNo(row.archivedAt !== null),
      ];
    }

    if (page.length < batch) return;
    lastId = page[page.length - 1]!.id;
  }
}
