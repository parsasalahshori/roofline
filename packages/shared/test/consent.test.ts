import { describe, it, expect } from 'vitest';
import { consentAttestationText, importConsent } from '../src/consent.ts';

const ex = (status: 'none' | 'express' | 'attested' | 'written' | 'revoked', doNotContact = false, optedOut = false) => ({
  status,
  doNotContact,
  optedOut,
});

describe('importConsent: new customers', () => {
  it('no phone is none, whether attested or not', () => {
    expect(importConsent(null, false, true)).toBe('none');
    expect(importConsent(null, false, false)).toBe('none');
  });
  it('a new customer with a phone and the box checked is attested', () => {
    expect(importConsent(null, true, true)).toBe('attested');
  });
  it('a new customer with a phone and the box unchecked is express', () => {
    expect(importConsent(null, true, false)).toBe('express');
  });
});

describe('importConsent: existing customers', () => {
  it('revoked stays revoked, attested or not', () => {
    expect(importConsent(ex('revoked'), true, true)).toBe('revoked');
    expect(importConsent(ex('revoked'), true, false)).toBe('revoked');
  });
  it('doNotContact keeps its status (express stays express even when attested)', () => {
    expect(importConsent({ status: 'express', doNotContact: true, optedOut: false }, true, true)).toBe('express');
    expect(importConsent({ status: 'express', doNotContact: true, optedOut: false }, true, false)).toBe('express');
  });
  it('optedOut keeps its status (none stays none)', () => {
    expect(importConsent({ status: 'none', doNotContact: false, optedOut: true }, true, true)).toBe('none');
    expect(importConsent({ status: 'none', doNotContact: false, optedOut: true }, true, false)).toBe('none');
  });
  it('written stays written', () => {
    expect(importConsent(ex('written'), true, true)).toBe('written');
    expect(importConsent(ex('written'), true, false)).toBe('written');
  });
  it('attested stays attested, even when unchecked', () => {
    expect(importConsent(ex('attested'), true, false)).toBe('attested');
    expect(importConsent(ex('attested'), true, true)).toBe('attested');
  });
  it('none becomes attested when checked, express when not', () => {
    expect(importConsent(ex('none'), true, true)).toBe('attested');
    expect(importConsent(ex('none'), true, false)).toBe('express');
  });
  it('none with a phone and the box unchecked is express', () => {
    expect(importConsent({ status: 'none', doNotContact: false, optedOut: false }, true, false)).toBe('express');
  });
  it('express becomes attested when checked, stays express when not', () => {
    expect(importConsent(ex('express'), true, true)).toBe('attested');
    expect(importConsent(ex('express'), true, false)).toBe('express');
  });
  it('hasPhone is ignored for existing customers', () => {
    expect(importConsent(ex('none'), false, true)).toBe('attested');
    expect(importConsent(ex('none'), false, false)).toBe('express');
  });
});

describe('consentAttestationText', () => {
  it('is the verbatim sentence with the company name', () => {
    expect(consentAttestationText('Acme Roofing')).toBe(
      'These customers agreed to receive text messages from Acme Roofing. I understand Acme Roofing is responsible for having their consent.',
    );
  });
});
