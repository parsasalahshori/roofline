import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type pg from 'pg';
import { encrypt } from '@roofline/db';
import { SEED_PASSWORD } from '@roofline/db/testing';
import { auth } from '../src/copy/auth.ts';
import { readStack } from './fixtures.ts';

/*
 * Launch dress rehearsal helpers (ops/sdd/integration/dress-rehearsal.md). Used by rehearsal.spec.ts
 * (desktop) and rehearsal.phone.spec.ts (phone). Everything runs against the e2e stack with
 * FAKE_PROVIDERS; the only things done outside the UI are the ones a person cannot do from it:
 * Twilio's signed webhooks (an inbound text, an inbound call and its ConversationRelay socket),
 * turning on Front Desk without a verified forwarding test, and moving the clock to daytime.
 */

/** Words that mean an unfinished screen. Matched case-insensitively against every visited screen. */
export const COMING_SOON = /coming soon/i;

/** What went wrong in the browser during one test. */
export type BrowserTrouble = { console: string[]; pageErrors: string[]; serverErrors: string[] };

/**
 * Collects console errors, uncaught page errors and 5xx answers on every page of the context.
 * A failed resource load with a 4xx status is logged by Chromium as a console error too; those are
 * kept, but tagged, so the findings can tell them apart.
 */
export function watchBrowser(context: BrowserContext): BrowserTrouble {
  const trouble: BrowserTrouble = { console: [], pageErrors: [], serverErrors: [] };
  const attach = (page: Page) => {
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      trouble.console.push(`${page.url()} :: ${msg.text()} @ ${msg.location().url}`);
    });
    page.on('pageerror', (err) => {
      trouble.pageErrors.push(`${page.url()} :: ${err.name}: ${err.message}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 500) {
        trouble.serverErrors.push(`${response.request().method()} ${response.url()} -> ${response.status()}`);
      }
    });
  };
  context.pages().forEach(attach);
  context.on('page', attach);
  return trouble;
}

/**
 * Known product bugs found by the rehearsal (dress-rehearsal.md). A matching console line is
 * reported as an annotation naming the bug instead of failing the test, so the rest still runs.
 * Delete an entry once its bug is fixed.
 */
export const KNOWN_CONSOLE: { id: string; pattern: RegExp }[] = [
  // S1: hailFillExpression() uses decimal `match` labels; MapLibre rejects the layer (swath never drawn).
  { id: 'BUG-1 (S1) hail swath layer rejected by MapLibre', pattern: /Numeric branch labels must be integer values/ },
  // C1: the Calendar window POSTs /api/calendar/sync on every open; with no calendar connected it answers 404.
  { id: 'BUG-2 (C1) calendar sync 404 without a connection', pattern: /404 \(Not Found\) @ .*\/api\/calendar\/sync/ },
];

/** Screens whose "coming soon" lines are a known gap (path pattern -> finding id). */
export const KNOWN_COMING_SOON: { id: string; path: RegExp }[] = [
  // Empty since pass 14: GAP-1 (G1 not merged) is closed. Add { id, path } for a known unfinished screen.
];

/** Fails (softly, so the journey goes on) on any console error, page error or 5xx not already a known bug; attaches them all. */
export async function expectCleanBrowser(trouble: BrowserTrouble, testInfo: TestInfo): Promise<void> {
  await testInfo.attach('browser-trouble.json', {
    body: JSON.stringify(trouble, null, 2),
    contentType: 'application/json',
  });
  const unknown: string[] = [];
  for (const line of trouble.console) {
    const known = KNOWN_CONSOLE.find((k) => k.pattern.test(line));
    if (known) testInfo.annotations.push({ type: 'known-bug', description: `${known.id}: ${line.split('\n')[0]}` });
    else unknown.push(line);
  }
  expect.soft(trouble.pageErrors, 'uncaught page errors').toEqual([]);
  expect.soft(trouble.serverErrors, '5xx responses').toEqual([]);
  expect.soft(unknown, 'console errors').toEqual([]);
}

/** Every screen a test looked at, with whether it said "coming soon". */
export type ScreenLog = { url: string; comingSoon: string[] }[];

/**
 * Checks the visible text of the current screen for "coming soon" (soft: the journey goes on) and
 * records the screen. Call it once the screen has its content.
 */
export async function checkScreen(page: Page, log: ScreenLog): Promise<void> {
  const text = await page.locator('body').innerText();
  const hits = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => COMING_SOON.test(line));
  const path = new URL(page.url()).pathname;
  log.push({ url: path + new URL(page.url()).search, comingSoon: hits });
  const known = KNOWN_COMING_SOON.find((k) => k.path.test(path));
  if (known && hits.length > 0) {
    test.info().annotations.push({ type: 'known-gap', description: `${known.id}: ${hits.length} line(s) on ${path}` });
    return;
  }
  expect.soft(hits, `"coming soon" on ${page.url()}`).toEqual([]);
}

/** Signs in through the sign-in page (not the API), as a person would. */
export async function signInViaUi(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(auth.email, { exact: true }).fill(email);
  await page.getByLabel(auth.password, { exact: true }).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: auth.signIn, exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 15_000 });
}

/** Real place names, spread around the clock (a fixed offset is not accepted as a customer's zone). */
const PLACES = [
  'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Halifax', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/London',
  'Europe/Berlin', 'Europe/Athens', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka',
  'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

/** Puts the company and its homes where it is 10:00 to 17:00 now, so the send gate does not hold texts for quiet hours. */
export async function makeItDaytime(db: pg.Client): Promise<void> {
  const hourIn = (zone: string) =>
    Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const zone = PLACES.find((z) => hourIn(z) >= 10 && hourIn(z) <= 17) ?? 'America/Chicago';
  await db.query('update companies set timezone = $1', [zone]);
  await db.query('update properties set timezone = $1', [zone]);
}

// --- Twilio (fake) -------------------------------------------------------------------------------

/** Acme Roofing's business number for the rehearsal. */
export const ACME_NUMBER = '+14025550100';
/** The token the rehearsal signs Twilio webhooks with. */
const SUBACCOUNT_TOKEN = 'rehearsal-subaccount-token';

/**
 * The API's ENCRYPTION_KEY: from .stack.json when stack.ts wrote it there, else from the environment of the
 * running API process (Linux /proc). Null when it cannot be found.
 */
function stackEncryptionKey(): string | null {
  // Pass 14's stack.ts writes the key to .stack.json; older stacks only have it in the API's environment.
  const written = (readStack() as { encryptionKey?: string }).encryptionKey;
  if (written) return written;
  const tenantUrl = readStack().tenantUrl;
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    const vars = environ.split('\0');
    if (!vars.includes(`DATABASE_URL_TENANT=${tenantUrl}`)) continue;
    const key = vars.find((v) => v.startsWith('ENCRYPTION_KEY='));
    if (key) return key.slice('ENCRYPTION_KEY='.length);
  }
  return null;
}

/**
 * Gives Acme a voice and text number and a subaccount token (encrypted with the stack's key), and
 * turns Front Desk on for calls and texts. Returns the token to sign webhooks with. Turning Front
 * Desk on from Settings needs a verified forwarding test (a real call), so it is set here.
 */
export async function setUpFrontDesk(db: pg.Client, companyId: string): Promise<string> {
  const key = process.env.TWILIO_AUTH_TOKEN ? null : stackEncryptionKey();
  if (key === null && !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Cannot sign Twilio webhooks: no TWILIO_AUTH_TOKEN and the stack ENCRYPTION_KEY could not be read.');
  }
  await db.query(
    `insert into company_phone_numbers (company_id, e164, capabilities, provider_sid) values ($1, $2, '{sms,voice}', 'PN_REHEARSAL')
       on conflict (e164) do nothing`,
    [companyId, ACME_NUMBER],
  );
  let token: string;
  if (key !== null) {
    token = SUBACCOUNT_TOKEN;
    // The sid is set too: with a token but no sid, the texting-registration job provisions a (fake)
    // subaccount and overwrites the token within a minute.
    await db.query(
      `update texting_registrations set subaccount_sid = $3, subaccount_auth_token_encrypted = $2 where company_id = $1`,
      [companyId, encrypt(token, key), `AC${'a'.repeat(32)}`],
    );
  } else {
    token = process.env.TWILIO_AUTH_TOKEN!;
  }
  await db.query(
    `insert into company_settings (company_id, front_desk_enabled, front_desk_texts, ring_team_first_seconds)
       values ($1, true, true, 0)
       on conflict (company_id) do update set front_desk_enabled = true, front_desk_texts = true, ring_team_first_seconds = 0`,
    [companyId],
  );
  return token;
}

/** Twilio's X-Twilio-Signature: HMAC-SHA1 of the URL followed by each sorted field name and value, base64. */
export function twilioSignature(token: string, url: string, fields: Record<string, string>): string {
  const data = Object.keys(fields)
    .sort()
    .reduce((acc, name) => acc + name + fields[name], url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** POSTs a form to a /hooks/twilio route, signed as Twilio would sign it for PUBLIC_BASE_URL (the stack's base URL). */
export async function postTwilio(request: APIRequestContext, token: string, path: string, fields: Record<string, string>) {
  const url = readStack().baseUrl + path;
  return request.post(path, {
    form: fields,
    headers: { 'X-Twilio-Signature': twilioSignature(token, url, fields) },
  });
}

let sidCounter = Date.now() % 1_000_000;
function nextSid(prefix: 'SM' | 'CA'): string {
  sidCounter += 1;
  return prefix + sidCounter.toString(16).padStart(32, '0');
}

/** An inbound text from `from` to Acme's number, through the real webhook. */
export async function simulateInboundText(request: APIRequestContext, token: string, from: string, body: string): Promise<void> {
  const fields = { MessageSid: nextSid('SM'), AccountSid: `AC${'0'.repeat(32)}`, From: from, To: ACME_NUMBER, Body: body, NumMedia: '0' };
  const res = await postTwilio(request, token, '/hooks/twilio/sms', fields);
  expect(res.status(), 'inbound text webhook').toBe(200);
}

type RelayFrame = { type: string; token?: string; last?: boolean; handoffData?: string };

/**
 * An inbound call answered by Front Desk: the voice webhook, then Twilio's side of ConversationRelay
 * over the WebSocket the TwiML names (setup, one caller prompt, wait for the assistant's last text
 * token), hang up, then the `completed` status callback. Returns the assistant's words.
 */
export async function simulateInboundCall(
  request: APIRequestContext,
  token: string,
  from: string,
  said: string,
): Promise<{ assistant: string; callSid: string }> {
  const callSid = nextSid('CA');
  const voice = await postTwilio(request, token, '/hooks/twilio/voice', { CallSid: callSid, From: from, To: ACME_NUMBER });
  expect(voice.status(), `voice webhook: ${await voice.text()}`).toBe(200);
  const twiml = await voice.text();
  const url = /<ConversationRelay url="([^"]+)"/.exec(twiml)?.[1]?.replace(/&amp;/g, '&');
  const callId = /<Parameter name="callId" value="([^"]+)"/.exec(twiml)?.[1];
  expect(url, `ConversationRelay in TwiML: ${twiml}`).toBeTruthy();
  expect(callId).toBeTruthy();

  const ws = new WebSocket(url!);
  const frames: RelayFrame[] = [];
  let assistant = '';
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No assistant answer on the relay. Frames: ${JSON.stringify(frames)}`)), 20_000);
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as RelayFrame;
      frames.push(frame);
      if (frame.type === 'text') assistant += frame.token ?? '';
      if ((frame.type === 'text' && frame.last === true) || frame.type === 'end') {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.addEventListener('close', (event) => {
      clearTimeout(timer);
      if (frames.length === 0) reject(new Error(`Relay closed before any answer: ${event.code} ${event.reason}`));
      else resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Relay socket error'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('Relay socket did not open')), { once: true });
  });
  ws.send(JSON.stringify({ type: 'setup', sessionId: 'VX' + callSid.slice(2), callSid, from, to: ACME_NUMBER, direction: 'inbound', customParameters: { callId } }));
  ws.send(JSON.stringify({ type: 'prompt', voicePrompt: said, lang: 'en-US', last: true }));
  await done;
  ws.close();

  const status = await postTwilio(request, token, '/hooks/twilio/voice-status', {
    CallSid: callSid,
    From: from,
    To: ACME_NUMBER,
    CallStatus: 'completed',
    CallDuration: '42',
  });
  expect(status.status(), 'voice status webhook').toBe(204);
  return { assistant, callSid };
}
