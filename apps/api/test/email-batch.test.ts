import { beforeEach, describe, expect, test } from "vitest";
import { emailOptOuts, type StepRow } from "@roofline/db";
import { dispatchDueMessages } from "../src/jobs/scheduler/dispatch-messages.ts";
import { unsubscribeKey } from "../src/public/unsubscribe-key.ts";
import { verifyUnsubscribeToken } from "../src/public/unsubscribe-token.ts";
import { sendEmailBatchHandler } from "../src/storm/email-batch.ts";
import { LEASE_RENEW_EVERY_MS } from "../src/tasks/runner.ts";
import { Actors, inCompany } from "./crm-helpers.ts";
import {
  addCompanyStorm,
  addEmailCustomers,
  approvedEmailBatch,
  BLANK_REASON,
  COMPANY_ADDRESS,
  DAYTIME,
  EIGHT_AM_CHICAGO,
  emailMessages,
  EMAIL_BODY,
  JUST_AFTER_EIGHT,
  JUST_BEFORE_EIGHT,
  LATE_EVENING,
  NOT_TAKEN_EMAIL,
  OFFICE_EMAIL,
  OPTED_OUT_EMAIL,
  setCompanyAddress,
} from "./email-helpers.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { rowFor } from "./sms-helpers.ts";
import { agentCtx, dbSteps, dbTask } from "./task-helpers.ts";

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  actors = new Actors(t);
  await setCompanyAddress(t, "a");
});

const idOf = (company: "a" | "b") => t.seed[company].companyId;
const stepRow = async (taskId: string): Promise<StepRow> =>
  (await dbSteps(t, "a", taskId))[0]!;
const runHandler = async (taskId: string) =>
  sendEmailBatchHandler(t.deps, agentCtx(idOf("a")), await stepRow(taskId));
const tokenOf = (text: string): string => {
  const origin = t.deps.config.APP_ORIGIN.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const match = new RegExp(
    `${origin}/u/([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)`,
  ).exec(text);
  if (!match) throw new Error("No unsubscribe link in the mail");
  return match[1]!;
};

/** Ann sends; Bea is do-not-contact; Cy has no address; Dee unsubscribed; Eli is archived. */
async function fiveCustomers() {
  const [a, b, c, d, e] = await addEmailCustomers(t, "a", [
    { firstName: "Ann", emails: ["ann@example.test"] },
    { firstName: "Bea", emails: ["bea@example.test"], doNotContact: true },
    { firstName: "Cy", emails: [] },
    { firstName: "Dee", emails: ["dee@example.test"] },
    { firstName: "Eli", emails: ["eli@example.test"], archived: true },
  ]);
  await inCompany(t, idOf("a"), (tx) =>
    tx
      .insert(emailOptOuts)
      .values({
        companyId: idOf("a"),
        email: "dee@example.test",
        source: "manual",
        at: DAYTIME,
        createdAt: DAYTIME,
        updatedAt: DAYTIME,
      }),
  );
  return { a: a!, b: b!, c: c!, d: d!, e: e! };
}

describe("send_email_batch", () => {
  test("gate counts: one sent, three blocked as contact, the customer without an address gets no row", async () => {
    const { a, b, c, d, e } = await fiveCustomers();
    const { taskId, stepId } = await approvedEmailBatch(t, actors, [
      a,
      b,
      c,
      d,
      e,
    ]);

    await t.queue.drain(t.deps);

    const step = await stepRow(taskId);
    expect(step.status).toBe("done");
    expect(step.result).toMatchObject({ sent: 1, blocked: { contact: 3 } });
    expect((step.result as { blocked: unknown }).blocked).toEqual({
      contact: 3,
    });
    expect(t.broadcast.sent).toHaveLength(1);

    const rows = await emailMessages(t, "a", stepId);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.customerId === c)).toBeUndefined();
    expect(rowFor(rows, a)).toMatchObject({
      status: "sent",
      channel: "email",
      direction: "out",
      purpose: "marketing",
      toEmail: "ann@example.test",
      subject: '1.75" hail hit Maple St',
    });
    for (const id of [b, d, e])
      expect(rowFor(rows, id)).toMatchObject({
        status: "blocked",
        blockRule: "contact",
        channel: "email",
      });
    expect((await dbTask(t, "a", taskId)).status).toBe("done");
  });

  test("opted-out: the unsubscribed address is blocked with the reason and gets no mail", async () => {
    const { a, b, c, d, e } = await fiveCustomers();
    const { stepId } = await approvedEmailBatch(t, actors, [a, b, c, d, e]);
    await t.queue.drain(t.deps);

    expect(rowFor(await emailMessages(t, "a", stepId), d)).toMatchObject({
      status: "blocked",
      blockRule: "contact",
      blockReason: OPTED_OUT_EMAIL,
      toEmail: "dee@example.test",
    });
    expect(t.broadcast.sent.map((m) => m.to)).toEqual(["ann@example.test"]);
  });

  test("dedupe on re-run: a second run sends nothing more; a second step with the same prefix is blocked", async () => {
    const { a, b, c, d, e } = await fiveCustomers();
    const { taskId, stepId } = await approvedEmailBatch(t, actors, [
      a,
      b,
      c,
      d,
      e,
    ]);
    await t.queue.drain(t.deps);
    const rowsBefore = await emailMessages(t, "a", stepId);

    const again = await runHandler(taskId);

    expect(again.status).toBe("done");
    expect(again.result).toMatchObject({ sent: 1 });
    expect(t.broadcast.sent).toHaveLength(1);
    expect(await emailMessages(t, "a", stepId)).toHaveLength(rowsBefore.length);

    const second = await approvedEmailBatch(t, actors, [a]);
    await t.queue.drain(t.deps);
    expect(rowFor(await emailMessages(t, "a", second.stepId), a)).toMatchObject(
      { status: "blocked", blockRule: "dedupe" },
    );
    expect(t.broadcast.sent).toHaveLength(1);
  });

  test("lease loss returns running and sends nothing", async () => {
    const [a, b] = await addEmailCustomers(t, "a", [
      { firstName: "Ann", emails: ["ann@example.test"] },
      { firstName: "Ben", emails: ["ben@example.test"] },
    ]);
    // Approved, so queued: no run owns it (run_seq 0), so any renewal fails.
    const { taskId } = await approvedEmailBatch(t, actors, [a!, b!]);
    const step = await stepRow(taskId);
    // The first reading of the clock starts the lease keeper; every later one is past a renewal.
    let reads = 0;
    const clock = {
      now: () =>
        new Date(
          DAYTIME.getTime() + (reads++ === 0 ? 0 : LEASE_RENEW_EVERY_MS + 1000),
        ),
    };

    const outcome = await sendEmailBatchHandler(
      { ...t.deps, clock },
      agentCtx(idOf("a")),
      step,
    );

    expect(outcome).toEqual({ status: "running", result: {} });
    expect(t.broadcast.sent).toEqual([]);
    expect(await emailMessages(t, "a", step.id)).toEqual([]);
  });

  test("scheduled emails dispatch after 8 AM local", async () => {
    t.clock.set(LATE_EVENING);
    const [a] = await addEmailCustomers(t, "a", [
      { firstName: "Ann", emails: ["ann@example.test"] },
    ]);
    const { taskId, stepId } = await approvedEmailBatch(t, actors, [a!]);

    await t.queue.drain(t.deps);

    expect(rowFor(await emailMessages(t, "a", stepId), a!)).toMatchObject({
      status: "scheduled",
      blockRule: "quiet_hours",
      scheduledFor: EIGHT_AM_CHICAGO,
    });
    expect(t.broadcast.sent).toEqual([]);
    expect((await stepRow(taskId)).status).toBe("running");

    t.clock.set(JUST_BEFORE_EIGHT);
    await dispatchDueMessages(t.deps, t.clock.now());
    expect(t.broadcast.sent).toEqual([]);
    expect(rowFor(await emailMessages(t, "a", stepId), a!).status).toBe(
      "scheduled",
    );

    t.clock.set(JUST_AFTER_EIGHT);
    await dispatchDueMessages(t.deps, t.clock.now());
    expect(rowFor(await emailMessages(t, "a", stepId), a!)).toMatchObject({
      status: "sent",
      sentAt: JUST_AFTER_EIGHT,
    });
    expect(t.broadcast.sent).toHaveLength(1);
    expect(await stepRow(taskId)).toMatchObject({
      status: "done",
      result: expect.objectContaining({ sent: 1 }),
    });
  });

  test("an opt-out between scheduling and dispatch blocks the row and sends nothing", async () => {
    t.clock.set(LATE_EVENING);
    const [a] = await addEmailCustomers(t, "a", [
      { firstName: "Ann", emails: ["ann@example.test"] },
    ]);
    const { stepId } = await approvedEmailBatch(t, actors, [a!]);
    await t.queue.drain(t.deps);
    expect(rowFor(await emailMessages(t, "a", stepId), a!).status).toBe(
      "scheduled",
    );

    await inCompany(t, idOf("a"), (tx) =>
      tx
        .insert(emailOptOuts)
        .values({
          companyId: idOf("a"),
          email: "ann@example.test",
          source: "link",
          at: LATE_EVENING,
          createdAt: LATE_EVENING,
          updatedAt: LATE_EVENING,
        }),
    );
    t.clock.set(JUST_AFTER_EIGHT);
    await dispatchDueMessages(t.deps, t.clock.now());

    expect(rowFor(await emailMessages(t, "a", stepId), a!)).toMatchObject({
      status: "blocked",
      blockRule: "contact",
    });
    expect(t.broadcast.sent).toEqual([]);
  });

  test("html and text carry the unsubscribe url, and the mail has the sender, reply-to and tag", async () => {
    const stormId = await addCompanyStorm(t, "a");
    const [a] = await addEmailCustomers(t, "a", [
      { firstName: "Ann", emails: ["Ann.Smith@Example.test"] },
    ]);
    await approvedEmailBatch(t, actors, [a!], { companyStormId: stormId });

    await t.queue.drain(t.deps);

    expect(t.broadcast.sent).toHaveLength(1);
    const mail = t.broadcast.sent[0]!;
    const claim = { companyId: idOf("a"), email: "ann.smith@example.test" };
    const textToken = tokenOf(mail.text);
    expect(tokenOf(mail.html)).toBe(textToken);
    expect(
      verifyUnsubscribeToken(unsubscribeKey(t.deps.config), textToken),
    ).toEqual(claim);
    expect(mail.unsubscribeUrl).toBe(
      `${t.deps.config.APP_ORIGIN}/u/${textToken}`,
    );
    expect(mail.from).toBe(
      `"${t.seed.a.name} via Roofline" <${t.deps.config.STORM_MAIL_FROM}>`,
    );
    expect(mail.replyTo).toBe(OFFICE_EMAIL);
    expect(mail.tag).toBe(`storm:${stormId}`);
    expect(mail.text).toContain(COMPANY_ADDRESS);
    expect(mail.text).toContain("Hi Ann,");
    expect(mail.text).toContain("yesterday");
    expect(mail.text).toContain(t.seed.a.name);
    expect(mail.subject).toBe('1.75" hail hit Maple St');
    expect(mail.subject).not.toContain("{");
    expect(mail.text).not.toContain("{");
    expect(EMAIL_BODY).toContain("{unsubscribe}");
  });

  test("a provider error marks the row failed (never resent) and the batch goes on", async () => {
    const [a, b] = await addEmailCustomers(t, "a", [
      { firstName: "Ann", emails: ["ann@example.test"] },
      { firstName: "Ben", emails: ["ben@example.test"] },
    ]);
    const { taskId, stepId } = await approvedEmailBatch(t, actors, [a!, b!]);
    t.broadcast.failNext();

    await t.queue.drain(t.deps);

    const rows = await emailMessages(t, "a", stepId);
    expect(rowFor(rows, a!)).toMatchObject({
      status: "failed",
      retryable: false,
      blockReason: NOT_TAKEN_EMAIL,
    });
    expect(rowFor(rows, b!)).toMatchObject({ status: "sent" });
    expect(t.broadcast.sent.map((m) => m.to)).toEqual(["ben@example.test"]);
    expect(await stepRow(taskId)).toMatchObject({
      status: "done",
      result: expect.objectContaining({ sent: 1, failed: 1 }),
    });
  });

  test('missing fields: no street falls back to "your street"; no hail size blocks the email', async () => {
    const [a, b] = await addEmailCustomers(t, "a", [
      { firstName: "Ann", emails: ["ann@example.test"] },
      { firstName: "Ben", emails: ["ben@example.test"] },
    ]);
    const noStreet = await approvedEmailBatch(t, actors, [a!], {
      subject: "Hail hit {hail_size}",
      fields: { [a!.toLowerCase()]: { hail_size: '1.75"' } },
    });
    await t.queue.drain(t.deps);
    expect(
      rowFor(await emailMessages(t, "a", noStreet.stepId), a!).status,
    ).toBe("sent");
    expect(t.broadcast.sent).toHaveLength(1);
    expect(t.broadcast.sent[0]!.text).toContain("your street");

    const noHail = await approvedEmailBatch(t, actors, [b!], {
      fields: { [b!.toLowerCase()]: { street: "Maple St" } },
    });
    await t.queue.drain(t.deps);
    expect(
      rowFor(await emailMessages(t, "a", noHail.stepId), b!),
    ).toMatchObject({
      status: "blocked",
      blockRule: "content",
      blockReason: BLANK_REASON,
    });
    expect(t.broadcast.sent).toHaveLength(1);
  });
});
