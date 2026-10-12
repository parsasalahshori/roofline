import { describe, expect, it } from 'vitest';
import { fillProposalText, linkFor, PROPOSAL_TEXT_TEMPLATE } from '../src/estimator/send-proposal.ts';

describe('linkFor', () => {
  it('builds the proposal link from the base URL and the token', () => {
    expect(linkFor({ PROPOSAL_LINK_BASE_URL: 'https://app.roofline.example' }, 'abc_DEF-123')).toBe(
      'https://app.roofline.example/p/abc_DEF-123',
    );
  });
});

describe('fillProposalText', () => {
  const vars = { firstName: 'Dana', company: 'Elm Roofing', address: '12 Oak St, Dallas, TX 75201', link: 'https://x.example/p/tok' };

  it('fills the first name, company, address and link of the default template', () => {
    expect(fillProposalText(PROPOSAL_TEXT_TEMPLATE, vars)).toBe(
      "Hi Dana, it's Elm Roofing. Here's your roof proposal for 12 Oak St, Dallas, TX 75201: https://x.example/p/tok Reply STOP to opt out.",
    );
  });

  it('says there when the customer has no first name', () => {
    expect(fillProposalText('Hi {first_name}, {link}', { ...vars, firstName: null })).toBe('Hi there, https://x.example/p/tok');
  });

  it('never reads a filled value as a token again', () => {
    expect(fillProposalText('{first_name} at {address} {link}', { ...vars, firstName: '{link}', address: '{company}' })).toBe(
      '{link} at {company} https://x.example/p/tok',
    );
  });

  it('leaves tokens it does not fill as written', () => {
    expect(fillProposalText('{Link} {other} {link}', vars)).toBe('{Link} {other} https://x.example/p/tok');
  });

  it('the default template keeps the link token', () => {
    expect(PROPOSAL_TEXT_TEMPLATE).toContain('{link}');
  });
});
