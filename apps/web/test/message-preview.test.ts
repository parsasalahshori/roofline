import { describe, expect, it } from 'vitest';
import { messageParts, type MessageWords } from '../src/features/proposals/messagePreview.ts';

const WORDS: MessageWords = { firstName: 'Dana', company: 'Summit Ridge Roofing', address: '12 Oak St' };
const TEMPLATE = 'Hi {first_name}, this is {company}. Your proposal for {address} is ready: {link} Reply STOP to opt out.';

/** The parts as one string, the link as the marker the server's text carries in its place. */
const flat = (template: string, words = WORDS) => messageParts(template, words).map((part) => (part.link ? '<link>' : part.text)).join('');

describe('messageParts: the proposal text as the customer reads it', () => {
  it('fills the first name, the company and the address, and leaves the link as a part of its own', () => {
    expect(messageParts(TEMPLATE, WORDS)).toEqual([
      { link: false, text: 'Hi Dana, this is Summit Ridge Roofing. Your proposal for 12 Oak St is ready: ' },
      { link: true },
      { link: false, text: 'Reply STOP to opt out.' },
    ]);
  });

  it('says "there" for a blank first name, as the text does when it goes out', () => {
    expect(flat('Hi {first_name}', { ...WORDS, firstName: null })).toBe('Hi there');
    expect(flat('Hi {first_name}', { ...WORDS, firstName: '   ' })).toBe('Hi there');
  });

  it('keeps a word that has nothing to fill it, and any other {word}, as written', () => {
    expect(flat('{company} {nope}', { ...WORDS, company: '' })).toBe('{company} {nope}');
    expect(flat('{FIRST_NAME}')).toBe('{FIRST_NAME}');
  });

  it('reads a filled value once: a name that looks like a word is not filled again', () => {
    expect(flat('Hi {first_name}', { ...WORDS, firstName: '{company}' })).toBe('Hi {company}');
  });

  it('has no link part when the text has no {link}, and no empty part when the text ends on it', () => {
    expect(messageParts('Hi {first_name}', WORDS)).toEqual([{ link: false, text: 'Hi Dana' }]);
    expect(messageParts('See {link}', WORDS)).toEqual([{ link: false, text: 'See ' }, { link: true }]);
    expect(messageParts('', WORDS)).toEqual([]);
  });

  it('reads as the text the server sends (apps/api fillProposalText), apart from the link it makes at send time', () => {
    // The screen puts a break where the space after the link was
    expect(flat(TEMPLATE)).toBe('Hi Dana, this is Summit Ridge Roofing. Your proposal for 12 Oak St is ready: <link>Reply STOP to opt out.');
  });
});
