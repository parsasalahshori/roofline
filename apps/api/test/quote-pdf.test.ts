import type { Stream } from "node:stream";
import { beforeEach, describe, expect, test } from "vitest";
import { defaultScope } from "@roofline/shared";
import {
  Actors,
  addressFor,
  type CompanyKey,
  mustCreate,
  NO_UUID,
  NOT_FOUND,
} from "./crm-helpers.ts";
import { makeTestApp, type SuperAgent, type TestApp } from "./helpers.ts";

/** DB-backed (Testcontainers): CI only. The text of the PDF is checked in quote-pdf-render.test.ts. */

const NOW = new Date("2026-10-12T15:00:00.000Z");
const PDF_TYPE = /application\/pdf/;
const PDF_FILE = 'attachment; filename="Q-0001-roofing-estimate.pdf"';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

const A = () => t.seed.a.companyId;

/** v1's default roof, as a measurement. */
const MEASUREMENT = {
  source: "manual",
  areaSqFt: defaultScope.areaSqFt,
  areaType: defaultScope.areaType,
  pitch: defaultScope.pitch,
  notes: null,
};

/** A customer, a house and a job for them, made by the owner of `company`; `extra` is added to the job. */
async function jobWith(
  n: number,
  extra: Record<string, unknown> = {},
  company: CompanyKey = "a",
) {
  const owner = await who.as("owner", company);
  const customer = await mustCreate(owner, "/api/customers", {
    displayName: `PDF Customer ${n}`,
  });
  const property = await mustCreate(owner, "/api/properties", {
    customerId: customer.id,
    ...addressFor(n),
  });
  const job = await mustCreate(owner, "/api/jobs", {
    customerId: customer.id,
    propertyId: property.id,
    ...extra,
  });
  return { customer, property, job };
}

/** Creates a quote on a job as `agent`; the body is v1's default roof. */
const postQuote = (agent: SuperAgent, jobId: string) =>
  agent.post(`/api/jobs/${jobId}/quotes`).send({ measurement: MEASUREMENT });

/** Creates a quote and returns its 201 body; fails the test on any other status. */
async function quoteOn(jobId: string, company: CompanyKey = "a") {
  const res = await postQuote(await who.as("owner", company), jobId);
  if (res.status !== 201)
    throw new Error(
      `quote create failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  return res.body as { id: string; number: string };
}

/**
 * Reads a binary response body into a Buffer. Without this superagent does not buffer
 * application/pdf, so `res.body` would be an empty object.
 */
const binaryParser = (
  res: Stream,
  callback: (err: Error | null, body: Buffer) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("error", (err: Error) => callback(err, Buffer.alloc(0)));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

/** GET the PDF of a quote as `agent`, with the body read as bytes. */
const getPdf = (agent: SuperAgent, quoteId: string) =>
  agent.get(`/api/quotes/${quoteId}/pdf`).buffer(true).parse(binaryParser);

describe("GET /api/quotes/:id/pdf", () => {
  test("the owner gets a draft as a PDF attachment named after the quote number", async () => {
    const { job } = await jobWith(1);
    const quote = await quoteOn(job.id);
    expect(quote.number).toBe("Q-0001");

    const res = await getPdf(await who.as("owner"), quote.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(PDF_TYPE);
    expect(res.headers["content-disposition"]).toBe(PDF_FILE);

    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
  });

  test("a final quote also returns a PDF", async () => {
    const { job } = await jobWith(2);
    const quote = await quoteOn(job.id);
    const owner = await who.as("owner");
    const finalized = await owner.post(`/api/quotes/${quote.id}/finalize`);
    expect(finalized.status).toBe(200);

    const res = await getPdf(owner, quote.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(PDF_TYPE);
    expect(res.headers["content-disposition"]).toBe(PDF_FILE);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
  });

  test("the assigned rep gets the PDF; a rep without the job gets 404", async () => {
    const repId = who.user("rep").userId;
    const { job } = await jobWith(3, {
      stage: "inspection",
      assignedUserId: repId,
      valueCents: 100,
    });
    const quote = await quoteOn(job.id);

    const rep = await who.as("rep");
    const assigned = await getPdf(rep, quote.id);
    expect(assigned.status).toBe(200);
    expect(assigned.headers["content-type"]).toMatch(PDF_TYPE);
    expect((assigned.body as Buffer).subarray(0, 5).toString("latin1")).toBe(
      "%PDF-",
    );

    const other = await who.as("otherRep");
    const hidden = await other.get(`/api/quotes/${quote.id}/pdf`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: NOT_FOUND });
  });

  test("company B's owner gets 404 for company A's quote", async () => {
    const { job } = await jobWith(4);
    const quote = await quoteOn(job.id);

    const intruder = await who.as("owner", "b");
    const res = await intruder.get(`/api/quotes/${quote.id}/pdf`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
    expect(A()).not.toBe(t.seed.b.companyId);
  });

  test("a malformed id and the all-zero id are a plain 404", async () => {
    const owner = await who.as("owner");
    for (const bad of ["not-a-uuid", NO_UUID]) {
      const res = await owner.get(`/api/quotes/${bad}/pdf`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: NOT_FOUND });
    }
  });
});
