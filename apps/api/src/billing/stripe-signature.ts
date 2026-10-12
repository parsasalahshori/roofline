import { createHmac, timingSafeEqual } from 'node:crypto';

export class StripeSignatureError extends Error {}

export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

type ParsedHeader = { t: number; v1: string[] };

function parseHeader(header: string): ParsedHeader {
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) throw new StripeSignatureError('Malformed timestamp');
      t = Number(value);
    } else if (key === 'v1') {
      v1.push(value);
    }
  }
  if (t === undefined || !Number.isSafeInteger(t)) {
    throw new StripeSignatureError('Missing timestamp');
  }
  if (v1.length === 0) throw new StripeSignatureError('Missing signature');
  return { t, v1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  now: Date,
  toleranceSec = 300,
): StripeEvent {
  if (!header) throw new StripeSignatureError('Missing signature header');
  const { t, v1 } = parseHeader(header);

  if (Math.abs(now.getTime() / 1000 - t) > toleranceSec) {
    throw new StripeSignatureError('Timestamp outside tolerance');
  }

  const payload = rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest();

  const matched = v1.some((candidate) => {
    const given = Buffer.from(candidate, 'hex');
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  });
  if (!matched) throw new StripeSignatureError('No matching signature');

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new StripeSignatureError('Body is not JSON');
  }
  if (!isRecord(parsed)) throw new StripeSignatureError('Body is not an event');
  const { id, type, created, data } = parsed;
  if (typeof id !== 'string' || typeof type !== 'string' || typeof created !== 'number') {
    throw new StripeSignatureError('Event is missing fields');
  }
  if (!isRecord(data) || !isRecord(data.object)) {
    throw new StripeSignatureError('Event data is missing an object');
  }
  return { id, type, created, data: { object: data.object } };
}
