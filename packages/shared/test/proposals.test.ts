import { expect, test } from 'vitest';
import {
  CONSENT_TEXT_V1,
  ESTIMATE_CLAUSE_V1,
  canonicalJson,
  isUsStateCode,
  parseSignedDocument,
  signedDocument,
  US_STATE_CODES,
  type PublicProposalView,
} from '../src/proposals.ts';

function sampleView(overrides: Partial<PublicProposalView> = {}): PublicProposalView {
  return {
    companyName: 'Acme Roofing',
    companyPhone: null,
    accentColor: null,
    logoUrl: null,
    firstName: 'Dana',
    address: '12 Oak St',
    validUntil: '2026-11-12',
    status: 'open',
    basis: 'estimate',
    options: [
      {
        id: 'o1',
        tier: 'good',
        name: 'Good',
        highlights: ['Architectural shingles'],
        inclusions: ['Tear-off', 'Underlayment'],
        totalCents: 1190000,
        monthlyEstimateCents: 9900,
        financingTerms: { aprBps: 0, months: 12 },
      },
      {
        id: 'o2',
        tier: 'better',
        name: 'Better',
        highlights: ['Impact-rated shingles'],
        inclusions: ['Tear-off', 'Underlayment', 'Ridge vent'],
        totalCents: 1425000,
        monthlyEstimateCents: null,
        financingTerms: null,
      },
    ],
    signed: null,
    estimateClause: true,
    ...overrides,
  };
}

test('canonicalJson sorts keys recursively and keeps array order', () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
});

test('canonicalJson is independent of key insertion order', () => {
  const first: Record<string, unknown> = {};
  first.x = 1;
  first.y = { p: 'q', m: true };
  const second: Record<string, unknown> = {};
  second.y = { m: true, p: 'q' };
  second.x = 1;
  expect(canonicalJson(first)).toBe(canonicalJson(second));
  expect(canonicalJson(first)).toBe('{"x":1,"y":{"m":true,"p":"q"}}');
});

test('canonicalJson drops undefined properties and nulls undefined array items', () => {
  expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  expect(canonicalJson([{ a: undefined, z: 'k' }])).toBe('[{"z":"k"}]');
  expect(canonicalJson(undefined)).toBe('null');
});

test('canonicalJson writes numbers, strings, booleans and null as JSON', () => {
  expect(canonicalJson([1.5, 0, -2])).toBe('[1.5,0,-2]');
  expect(canonicalJson({ s: 'a"b', t: true, f: false, n: null })).toBe('{"f":false,"n":null,"s":"a\\"b","t":true}');
});

test('signedDocument changes when the chosen option total changes', () => {
  const before = canonicalJson(signedDocument(sampleView(), 'o1', false));
  const changed = sampleView();
  changed.options[0].totalCents = 1190100;
  expect(canonicalJson(signedDocument(changed, 'o1', false))).not.toBe(before);
});

test('signedDocument differs with the estimate clause on and off and includes the clause text when on', () => {
  const on = signedDocument(sampleView(), 'o1', true);
  const off = signedDocument(sampleView(), 'o1', false);
  expect(canonicalJson(on)).not.toBe(canonicalJson(off));
  expect(canonicalJson(on)).toContain(ESTIMATE_CLAUSE_V1);
  expect(canonicalJson(off)).not.toContain(ESTIMATE_CLAUSE_V1);
});

test('signedDocument does not depend on status, first name or signed state', () => {
  const base = canonicalJson(signedDocument(sampleView(), 'o2', true));
  const changed = sampleView({
    status: 'signed',
    firstName: 'Someone Else',
    signed: { optionId: 'o2', name: 'Dana', at: '2026-10-12T10:00:00.000Z', pdfReady: false },
  });
  expect(canonicalJson(signedDocument(changed, 'o2', true))).toBe(base);
});

test('signedDocument only includes the chosen option and the company, address, validity and basis', () => {
  const doc = signedDocument(sampleView(), 'o2', false) as Record<string, unknown>;
  expect(Object.keys(doc).sort()).toEqual(['address', 'basis', 'clause', 'company', 'option', 'validUntil']);
  expect(doc).toMatchObject({
    company: { name: 'Acme Roofing', phone: null },
    address: '12 Oak St',
    validUntil: '2026-11-12',
    basis: 'estimate',
    clause: null,
    option: { id: 'o2', tier: 'better', totalCents: 1425000 },
  });
});

test('signedDocument throws for an unknown option id', () => {
  expect(() => signedDocument(sampleView(), 'missing', false)).toThrow('Unknown option.');
});

test('consent and estimate clause text match the brief exactly', () => {
  expect(CONSENT_TEXT_V1).toBe(
    'I agree to sign electronically and to receive this agreement electronically. I can ask for a paper copy.',
  );
  expect(ESTIMATE_CLAUSE_V1).toBe(
    "This price is based on an estimate of your roof's size. If the measured size differs, we'll show you the updated price and ask you to confirm before work starts.",
  );
});

test('US state codes: the 50 states and DC, no territories (C-M4)', () => {
  expect(US_STATE_CODES).toHaveLength(51);
  expect(isUsStateCode('NE')).toBe(true);
  expect(isUsStateCode(' dc ')).toBe(true);
  for (const code of ['PR', 'GU', 'VI', 'AS', 'MP', 'Nebraska', '', 'N']) expect(isUsStateCode(code)).toBe(false);
});

test('parseSignedDocument reads back a stored signed document with the same hash text, and refuses anything else', () => {
  const doc = signedDocument(sampleView(), 'o1', true);
  // Stored as jsonb and read back: the canonical text, and so the hash, is unchanged.
  const stored = JSON.parse(JSON.stringify(doc)) as unknown;
  const parsed = parseSignedDocument(stored);
  expect(parsed).not.toBeNull();
  expect(canonicalJson(parsed)).toBe(canonicalJson(doc));
  expect(parsed?.option.financingTerms).toEqual({ aprBps: 0, months: 12 });
  expect(parsed?.clause).toBe(ESTIMATE_CLAUSE_V1);
  expect(parseSignedDocument(undefined)).toBeNull();
  expect(parseSignedDocument({ optionId: 'o1' })).toBeNull();
  expect(parseSignedDocument({ ...doc, option: { ...doc.option, totalCents: 'lots' } })).toBeNull();
});

test('signedDocument ignores the brand colour and the logo: what is signed is what the company says, not how the page looks', () => {
  const plain = signedDocument(sampleView(), 'o1', true);
  const branded = signedDocument(sampleView({ accentColor: '#ED3A2B', logoUrl: 'https://cdn.example.test/logo.png' }), 'o1', true);
  expect(branded).toEqual(plain);
  expect(canonicalJson(branded)).toBe(canonicalJson(plain));
  expect(JSON.stringify(branded)).not.toMatch(/ED3A2B|logo/i);
});
