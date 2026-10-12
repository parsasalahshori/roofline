import { describe, expect, it } from 'vitest';
import { claimsGuard } from '../src/claims-guard.ts';

describe('claimsGuard refuses', () => {
  const refused: Array<[string, string[]]> = [
    ['The roof will cost $12,000.', ['price']],
    ['Your insurance will cover the whole roof.', ['coverage']],
    ['You have hail damage.', ['damage']],
    ["We'll cover your deductible.", ['deductible']],
    ['Deductible waived!', ['deductible']],
    ['No out of pocket cost with your claim.', ['deductible']],
    ['Free roof if your insurance approves.', ['deductible']],
    ['Your upgrade is paid for by insurance.', ['deductible']],
    ["We'll call your insurance for you.", ['insurer_contact']],
    ['We will talk to the adjuster for you.', ['insurer_contact']],
    ["We'll negotiate with your insurer.", ['insurer_contact']],
    ['We can handle the insurance company on your behalf.', ['insurer_contact']],
    ["We'll handle your insurance claim for you.", ['insurer_contact']],
    ["I'll phone your insurer tomorrow.", ['insurer_contact']],
    ['Our team can reach out to the adjuster.', ['insurer_contact']],
  ];
  for (const [text, hits] of refused) {
    it(text, () => {
      expect(claimsGuard(text)).toEqual({ ok: false, hits });
    });
  }
});

describe('claimsGuard allows', () => {
  const allowed = [
    'Have you had a chance to call your insurance company yet?',
    'Once you contact your insurer, send us the claim number.',
    'Please talk to your adjuster about the date.',
    'We work with insurance claims every day.',
    'We can pick up the permit on your behalf.',
    'Did you get a chance to file your claim? Reply with the claim number and insurer.',
    'When is the adjuster coming out?',
    'How did the adjuster visit go?',
    'Hi Sam, just checking in on your roof inspection tomorrow at 9.',
    'Can you send us the date the adjuster is coming?',
    'What is the name of your insurance company?',
    'Thanks for your time yesterday.',
    'Your install is moved to Friday because of rain.',
  ];
  for (const text of allowed) {
    it(text, () => {
      expect(claimsGuard(text)).toEqual({ ok: true, hits: [] });
    });
  }
});

describe('claimsGuard hits', () => {
  it('are in first-found order', () => {
    const r = claimsGuard("The roof will cost $12,000. We'll cover your deductible.");
    expect(r.hits).toEqual(['price', 'deductible']);
  });
  it('are de-duplicated', () => {
    expect(claimsGuard('It will cost $5,000. Or maybe $6,000.').hits).toEqual(['price']);
  });
});
