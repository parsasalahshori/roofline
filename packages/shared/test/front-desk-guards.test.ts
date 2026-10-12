import { describe, expect, test } from 'vitest';
import {
  COVERAGE_GUARD_REPLACEMENT,
  DAMAGE_GUARD_REPLACEMENT,
  guardSentence,
  PRICE_GUARD_REPLACEMENT,
  priceGuardReplacement,
  SentenceBuffer,
  type GuardHit,
} from '../src/front-desk.ts';

const ctx = { repName: null };

const blocked: Array<[string, GuardHit]> = [
  ['It will be $12,000.', 'price'],
  ['That runs $5 a foot.', 'price'],
  ['It is twelve grand.', 'price'],
  ['It should be about 400 a square.', 'price'],
  ['Roughly 450 per square.', 'price'],
  ['It is about 450/sq.', 'price'],
  ['It will cost about the same as a car.', 'price'],
  ['It costs around ten thousand.', 'price'],
  ['Your estimate is on the way.', 'price'],
  ['Probably 12k or so.', 'price'],
  ['Maybe 5K.', 'price'],
  ['Maybe five k.', 'price'],
  ['It is two thousand dollars.', 'price'],
  ['Fifteen hundred dollars.', 'price'],
  ['More like twenty five hundred.', 'price'],
  ['Twenty-five hundred, give or take.', 'price'],
  ['Ten thousand for the whole thing.', 'price'],
  ['It is a few hundred bucks.', 'price'],
  ['That is 3 dollars a shingle.', 'price'],
  ['A couple thousand.', 'price'],
  ['About 8 thousand total.', 'price'],
  ['IT WILL BE $9,500.', 'price'],
  ['Insurance will pay for it.', 'coverage'],
  ['Your insurance should cover that.', 'coverage'],
  ["Insurance'll cover the whole thing.", 'coverage'],
  ['The insurance company is going to pay for the roof.', 'coverage'],
  ['Insurance covers hail.', 'coverage'],
  ["You're covered.", 'coverage'],
  ["It's covered.", 'coverage'],
  ['Your claim is covered under your policy.', 'coverage'],
  ["You'll get a new roof.", 'coverage'],
  ['You will get a new roof out of this.', 'coverage'],
  ["They'll replace your roof.", 'coverage'],
  ['We guarantee the claim goes through.', 'coverage'],
  ['That is guaranteed.', 'coverage'],
  ['Insurance WILL PAY.', 'coverage'],
  ['Your roof is definitely damaged.', 'damage'],
  ['Your roof is damaged.', 'damage'],
  ['Your roof is probably damaged.', 'damage'],
  ['Your roof is badly damaged.', 'damage'],
  ['Your roof has hail damage.', 'damage'],
  ['Your roof has wind damage.', 'damage'],
  ['You have hail damage.', 'damage'],
  ['You have damage.', 'damage'],
  ["It's damaged.", 'damage'],
  ['YOUR ROOF HAS STORM DAMAGE.', 'damage'],
  ['Cost is around 8,500.', 'price'],
  ['It costs 8500.', 'price'],
  ['We charge 95 for the visit.', 'price'],
  ['The price is nine ninety nine.', 'price'],
  ['It will run you a thousand.', 'price'],
  ['A hundred and fifty.', 'price'],
  ['It is a hundred.', 'price'],
  ['Insurance will not cover that.', 'coverage'],
  ['Your insurance should handle that.', 'coverage'],
  ['They will pay for it.', 'coverage'],
  ['Your policy will take care of it.', 'coverage'],
  ["Insurance won't pay for that.", 'coverage'],
  ['The roof is damaged.', 'damage'],
  ['Your shingles are damaged.', 'damage'],
  ['There is damage.', 'damage'],
  ["There's hail damage on the north side.", 'damage'],
  ["It'll be covered.", 'coverage'],
  ['It’ll be covered.', 'coverage'],
  ['You will be covered.', 'coverage'],
  ["They'll cover it all.", 'coverage'],
  ['They will cover the cost.', 'coverage'],
  ['The roof has hail damage.', 'damage'],
];

const allowed: string[] = [
  "We've been in business 20 years.",
  'We can come at 2 pm.',
  'It has 3 layers.',
  'Call us at 555-0144.',
  'I have a slot on the 14th.',
  'It takes two hours.',
  'It takes two days.',
  'Did you notice any damage?',
  'The inspection will tell us.',
  'Tell me what happened.',
  'We can help you with the claim.',
  'I can take your claim details.',
  'What is your address?',
  'Is Tuesday at 9 a.m. okay?',
  'Thanks a thousand times.',
  'Our estimator is Maria.',
  'How many stories is the house?',
  'Do you have damage inside the house?',
  'If you have damage, tell me where.',
  'Did your roof get hit by the storm?',
  'Can you tell me about the leak?',
  'I will send a text with the details.',
  'We are open from 8 to 5.',
  'Let me check the schedule.',
  'Is this the best number to reach you?',
  'You have an appointment on Friday.',
  'Someone will call you back shortly.',
  'Does your insurance company know yet?',
  'We work with 4 crews.',
  'Your appointment is in two weeks.',
  'The inspection is free.',
  'We have openings at 3 p.m.',
  'Thanks a million.',
  'There is no charge for an inspection on the 14th.',
  'You will get a written quote in two days.',
  'The inspection runs about one hour.',
  'I am a hundred percent sure.',
  'We have done over a hundred roofs this year.',
  'The cost tends to vary.',
  'It will cost you nothing.',
  'Do you have insurance on the home?',
  'We can help you file the claim.',
  'We can help you file the claim with insurance and handle the paperwork.',
  'If your roof is damaged we will inspect it.',
  'Do you think the roof is damaged?',
  'If there is damage, we will find it.',
  "They'll cover the roof with a tarp tonight.",
  'If the roof has hail damage, we will find it.',
  'If your roof has hail damage, we will find it.',
];

describe('guardSentence blocked', () => {
  test.each(blocked)('%s -> %s', (sentence, hit) => {
    const r = guardSentence(sentence, ctx);
    expect(r.hits).toContain(hit);
    expect(r.text).not.toBe(sentence);
  });
});

describe('guardSentence allowed', () => {
  test.each(allowed)('%s', (sentence) => {
    expect(guardSentence(sentence, ctx)).toEqual({ text: sentence, hits: [] });
  });
});

describe('guardSentence replacements', () => {
  test.each([
    ['It will be $12,000.', null, "I can't give prices on the phone, but our estimator will go over that at the inspection."],
    ['It will be $12,000.', 'Maria', "I can't give prices on the phone, but Maria will go over that at the inspection."],
    ['Insurance will pay for it.', null, COVERAGE_GUARD_REPLACEMENT],
    ['Your roof is definitely damaged.', null, DAMAGE_GUARD_REPLACEMENT],
  ] as const)('%s with rep %s', (sentence, repName, expected) => {
    expect(guardSentence(sentence, { repName }).text).toBe(expected);
  });

  test('replacement sentences never trip a guard', () => {
    for (const r of [
      PRICE_GUARD_REPLACEMENT,
      priceGuardReplacement('Mike Cost-Smith'),
      COVERAGE_GUARD_REPLACEMENT,
      DAMAGE_GUARD_REPLACEMENT,
    ]) {
      expect(guardSentence(r, { repName: 'Mike' }).hits).toEqual([]);
    }
  });

  test('exact coverage and damage text', () => {
    expect(COVERAGE_GUARD_REPLACEMENT).toBe(
      'Whether insurance covers it is up to your insurance company; we can help you with the claim.',
    );
    expect(DAMAGE_GUARD_REPLACEMENT).toBe('The inspection will tell us.');
    expect(priceGuardReplacement('Maria')).toContain('Maria will go over that at the inspection.');
  });

  test('two hits list both once, in order, replacements joined', () => {
    const r = guardSentence('Your roof is damaged and insurance will pay $12,000.', { repName: 'Maria' });
    expect(r.hits).toEqual(['price', 'coverage', 'damage']);
    expect(r.text).toBe(
      `${priceGuardReplacement('Maria')} ${COVERAGE_GUARD_REPLACEMENT} ${DAMAGE_GUARD_REPLACEMENT}`,
    );
  });

  test('repeated hits of one kind appear once', () => {
    const r = guardSentence('$5 or $6 dollars, twelve grand.', ctx);
    expect(r.hits).toEqual(['price']);
  });

  test('table size', () => {
    expect(blocked.length).toBeGreaterThanOrEqual(25);
    expect(allowed.length).toBeGreaterThanOrEqual(25);
    expect(blocked.length + allowed.length).toBeGreaterThanOrEqual(60);
  });
});

function pushAll(tokens: string[]): string[] {
  const b = new SentenceBuffer();
  const out: string[] = [];
  for (const t of tokens) out.push(...b.push(t));
  out.push(...b.flush());
  return out;
}

describe('SentenceBuffer', () => {
  test('three sentences across tokens', () => {
    const b = new SentenceBuffer();
    const out: string[] = [];
    for (const t of ['Hello', ' there.', ' How are', ' you today?', ' Great', ' to hear!', ' Bye']) {
      out.push(...b.push(t));
    }
    expect(out).toEqual(['Hello there.', 'How are you today?', 'Great to hear!']);
    expect(b.flush()).toEqual(['Bye']);
  });

  test('trailing terminator is held until the next token', () => {
    const b = new SentenceBuffer();
    expect(b.push('One sentence.')).toEqual([]);
    expect(b.push(' Next')).toEqual(['One sentence.']);
    expect(b.flush()).toEqual(['Next']);
  });

  test.each([
    'Dr. Smith lives on Elm St. near us.',
    'Come by at 9 a.m. tomorrow.',
    'Come by at 5 p.m. today.',
    'It is 3.5 inches.',
    'That is $2.50 a piece.',
    'Mr. and Mrs. Lee are at 12 Main Ave. today.',
    'Ms. Park lives on Oak Rd. nearby.',
    'It is us vs. them.',
    'Call about No. 5 please.',
  ])('does not split: %s', (text) => {
    expect(pushAll([text])).toEqual([text]);
    expect(pushAll(text.split(/(?<= )/))).toEqual([text]);
  });

  test('question and exclamation split', () => {
    expect(pushAll(['Is that right? Yes! Okay.'])).toEqual(['Is that right?', 'Yes!', 'Okay.']);
  });

  test('ellipsis is a single terminator', () => {
    expect(pushAll(['Well... maybe. Sure.'])).toEqual(['Well...', 'maybe.', 'Sure.']);
  });

  test('closing quotes stay with the sentence', () => {
    expect(pushAll(['She said "go." Then left.'])).toEqual(['She said "go."', 'Then left.']);
  });

  test('flush releases trailing text and empties', () => {
    const b = new SentenceBuffer();
    expect(b.push('No end here')).toEqual([]);
    expect(b.flush()).toEqual(['No end here']);
    expect(b.flush()).toEqual([]);
  });

  test('flush on empty', () => {
    expect(new SentenceBuffer().flush()).toEqual([]);
  });

  test('long comma separated text splits at a comma within 140', () => {
    const text = Array.from({ length: 20 }, (_, i) => `item${i}`).join(', ');
    expect(text.length).toBeGreaterThan(140);
    const b = new SentenceBuffer();
    const first = b.push(text);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0]!.length).toBeLessThanOrEqual(140);
    expect(first[0]!.endsWith(',')).toBe(true);
    const all = [...first, ...b.flush()];
    for (const p of all) expect(p.length).toBeLessThanOrEqual(140);
    expect(all.join(' ')).toBe(text);
  });

  test('long text without commas splits at a space', () => {
    const text = Array.from({ length: 60 }, () => 'word').join(' ');
    const out = pushAll([text]);
    expect(out.length).toBeGreaterThan(1);
    for (const p of out) expect(p.length).toBeLessThanOrEqual(140);
    expect(out.join(' ')).toBe(text);
  });

  test('token by token equals whole string', () => {
    const text = 'Hi, this is Roofline. Dr. Smith will call at 9 a.m. tomorrow? Great! It is 3.5 inches... fine. Bye';
    const whole = pushAll([text]);
    expect(pushAll(text.split(''))).toEqual(whole);
    expect(pushAll(text.split(/(?<= )/))).toEqual(whole);
  });

  test('concatenated output preserves the text', () => {
    const text = 'First one. Second one? Third, with a comma! Fourth without end';
    expect(pushAll(text.split(' ').map((w, i) => (i ? ` ${w}` : w))).join(' ')).toBe(text);
  });
});
