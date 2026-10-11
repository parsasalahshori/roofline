import { describe, expect, test } from 'vitest';
import { classifyInbound, looksLikeOptOut, readInbound } from '../src/index.ts';

describe('the brief', () => {
  test.each(['STOP', 'Stop.', '  stop  ', 'Stop texting me!', "don't text me", 'UNSUBSCRIBE'])('%s → stop', (b) =>
    expect(classifyInbound(b)).toBe('stop'),
  );

  test.each([
    'Can you stop by Thursday?',
    'stop the leak please',
    'Is the crew going to stop at 5?',
    'end of day works',
  ])('%s → other', (b) => expect(classifyInbound(b)).toBe('other'));

  test('help', () => expect(classifyInbound('HELP')).toBe('help'));
  test('start', () => expect(classifyInbound('Start')).toBe('start'));
});

describe('every keyword and phrase', () => {
  const STOP = [
    'stop',
    'stopall',
    'unsubscribe',
    'cancel',
    'end',
    'quit',
    'revoke',
    'optout',
    'opt out',
    'stop texting me',
    'stop messaging me',
    'stop texting',
    'please stop',
    'please stop texting me',
    'unsubscribe me',
    'remove me',
    'take me off your list',
    'do not text me',
    'dont text me',
    'opt me out',
  ];

  test.each(STOP)('%s → stop', (b) => expect(classifyInbound(b)).toBe('stop'));
  test.each(STOP)('%s, shouted with punctuation → stop', (b) =>
    expect(classifyInbound(`  ${b.toUpperCase()}!!! `)).toBe('stop'),
  );

  test.each(['help', 'info'])('%s → help', (b) => expect(classifyInbound(b)).toBe('help'));
  test.each(['start', 'unstop', 'yes start'])('%s → start', (b) => expect(classifyInbound(b)).toBe('start'));
});

describe('whole message only, never "contains"', () => {
  test.each([
    'please do not stop texting me',
    'stop texting me about gutters',
    'stop now',
    'stop!!! and call me',
    'yes stop',
    'help me with the quote',
    'I need help',
    'where do I start',
    'start monday',
    'can you cancel the Thursday visit',
    'cancel my appointment',
    'unsubscribe from nothing, just call me',
    'quit it',
    'the end',
    'info about the warranty',
    'remove me from the Thursday schedule',
    'opt out of the extra coat',
    'stopping by at 5',
    'stops',
    'stoppp',
    'unstoppable',
  ])('%s → other', (b) => expect(classifyInbound(b)).toBe('other'));
});

describe('normalizing', () => {
  test('ignores case', () => {
    expect(classifyInbound('sToP')).toBe('stop');
    expect(classifyInbound('hElP')).toBe('help');
    expect(classifyInbound('STaRT')).toBe('start');
  });

  test('ignores leading and trailing whitespace, including tabs and newlines', () => {
    expect(classifyInbound('\n\t stop \r\n')).toBe('stop');
    expect(classifyInbound(' \n help')).toBe('help');
  });

  test('collapses runs of whitespace between words', () => {
    expect(classifyInbound('stop    texting\t\tme')).toBe('stop');
    expect(classifyInbound('please\nstop')).toBe('stop');
    expect(classifyInbound('yes   start')).toBe('start');
  });

  test('treats a no-break space like a space', () => {
    expect(classifyInbound('stop texting me')).toBe('stop');
  });

  test('strips punctuation, digits and emoji', () => {
    expect(classifyInbound('S.T.O.P.')).toBe('stop');
    expect(classifyInbound('"stop"')).toBe('stop');
    expect(classifyInbound('opt-out')).toBe('stop');
    expect(classifyInbound('STOP 🙏')).toBe('stop');
    expect(classifyInbound('Help?!')).toBe('help');
    expect(classifyInbound('start...')).toBe('start');
  });

  test('a word split by punctuation that leaves spaces behind is still two words', () => {
    // "stop - texting me" strips to "stop  texting me", which collapses to a real phrase.
    expect(classifyInbound('stop - texting me')).toBe('stop');
  });

  test('"don\'t text me" with a straight apostrophe', () => {
    expect(classifyInbound("don't text me")).toBe('stop');
    expect(classifyInbound("DON'T TEXT ME.")).toBe('stop');
  });

  test('"don’t text me" with a curly apostrophe (U+2019) is the same as a straight one', () => {
    expect(classifyInbound('don’t text me')).toBe('stop');
    expect(classifyInbound('Don’t text me!')).toBe('stop');
    expect(classifyInbound('don’t text me')).toBe(classifyInbound("don't text me"));
  });

  test('other apostrophe and quote characters are stripped too', () => {
    expect(classifyInbound('don‘t text me')).toBe('stop'); // U+2018
    expect(classifyInbound('don`t text me')).toBe('stop');
    expect(classifyInbound('donʼt text me')).toBe('stop'); // U+02BC modifier letter apostrophe
  });
});

describe('only a-z count as letters', () => {
  test('an accented letter is stripped like punctuation, so STÖP is "stp"', () => {
    expect(classifyInbound('STÖP')).toBe('other');
    expect(classifyInbound('stöp')).toBe('other');
    expect(classifyInbound('Hélp')).toBe('other');
    expect(classifyInbound('stárt')).toBe('other');
  });

  test('letters from other scripts are stripped', () => {
    expect(classifyInbound('停止')).toBe('other');
    expect(classifyInbound('СТОП')).toBe('other'); // Cyrillic
    expect(classifyInbound('ѕtop')).toBe('other'); // Cyrillic dze in place of the s: "top"
  });

  test('a non-ASCII letter that lowercases to ASCII is still stripped, not folded in', () => {
    // KELVIN SIGN (U+212A) lowercases to "k"; "İ" (U+0130) to "i" plus a combining dot. Neither
    // may turn into the ASCII letter: they strip, like every other non-ASCII character.
    expect(classifyInbound('taKe me off your list')).toBe('other'); // "tae me off your list"
    expect(classifyInbound('İnfo')).toBe('other'); // "nfo"
    expect(classifyInbound('unsubscrİbe')).toBe('other'); // "unsubscrbe"
  });

  test('a stripped non-ASCII character does not glue two words together', () => {
    expect(classifyInbound('stopétexting me')).toBe('other'); // "stoptexting me"
  });
});

describe('degenerate input', () => {
  test('an empty body is other', () => {
    expect(classifyInbound('')).toBe('other');
  });

  test('a whitespace-only body is other', () => {
    expect(classifyInbound('   ')).toBe('other');
    expect(classifyInbound('\n\t\r  ')).toBe('other');
  });

  test('a body of nothing but punctuation, digits or emoji is other', () => {
    expect(classifyInbound('!!!')).toBe('other');
    expect(classifyInbound('12345')).toBe('other');
    expect(classifyInbound('👍')).toBe('other');
  });

  test('a body that is not a string is other, not a crash', () => {
    for (const bad of [undefined, null, 42, {}, ['stop']]) {
      expect(classifyInbound(bad as unknown as string)).toBe('other');
    }
  });
});

describe('very long bodies', () => {
  test('a megabyte of ordinary text is other', () => {
    expect(classifyInbound('the crew will stop by at five. '.repeat(40_000))).toBe('other');
  });

  test('a megabyte of one keyword repeated is that keyword: repeats of the same word collapse (R22)', () => {
    expect(classifyInbound('stop '.repeat(200_000))).toBe('stop');
  });

  test('a megabyte of a keyword and another word, repeated, is other: the message must be the keyword and nothing else', () => {
    expect(classifyInbound('stop now '.repeat(100_000))).toBe('other');
  });

  test('a megabyte of whitespace is other', () => {
    expect(classifyInbound(' '.repeat(1_000_000))).toBe('other');
    expect(classifyInbound(' \t\n'.repeat(300_000) + 'x')).toBe('other');
  });

  test('a megabyte of punctuation and non-ASCII is other', () => {
    expect(classifyInbound('!?.,;:éñ'.repeat(150_000))).toBe('other');
  });

  test('a long run of one letter does not hang', () => {
    expect(classifyInbound('s'.repeat(1_000_000))).toBe('other');
    expect(classifyInbound('a '.repeat(500_000) + '!')).toBe('other');
  });

  test('a keyword padded with a lot of whitespace is still the keyword', () => {
    // Opt-outs are honored: padding does not turn STOP into a different message.
    expect(classifyInbound(' '.repeat(100_000) + 'STOP' + ' '.repeat(100_000))).toBe('stop');
  });
});

// ---------------------------------------------------------------------------------------------
// R22: wider opt-out wording, NFKC, repeated words, strict START, looksLikeOptOut

describe('more ways of saying stop (R22)', () => {
  const MORE_STOP = [
    'stop all',
    'stop please',
    'stop texting me please',
    'please stop texting',
    'please stop messaging me',
    'unsubscribe please',
    'unsubscribe me please',
    'please remove me',
    'remove me from the list',
    'take me off the list',
    'take me off of your list',
    'dont text me again',
    'do not contact me',
    'dont contact me',
    'dont message me',
    'quit texting me',
    'stop it',
    'stop sending',
    'no more texts',
  ];

  test.each(MORE_STOP)('%s → stop', (b) => expect(classifyInbound(b)).toBe('stop'));
  test.each(MORE_STOP)('%s, shouted with punctuation → stop', (b) =>
    expect(classifyInbound(`  ${b.toUpperCase()}!!! `)).toBe('stop'),
  );

  test('the apostrophe forms people actually type', () => {
    expect(classifyInbound("Don't text me again.")).toBe('stop');
    expect(classifyInbound('Don’t contact me')).toBe('stop');
    expect(classifyInbound("don't message me!")).toBe('stop');
    expect(classifyInbound('Stop, please.')).toBe('stop');
    expect(classifyInbound('No more texts!!')).toBe('stop');
  });

  test('still the whole message only: a new phrase inside a longer message is other', () => {
    expect(classifyInbound('stop it with the hammering at 6am')).toBe('other');
    expect(classifyInbound('please remove me from Thursday and add me to Friday')).toBe('other');
    expect(classifyInbound('no more texts after 9pm please')).toBe('other');
    expect(classifyInbound('stop sending the crew so early')).toBe('other');
  });
});

describe('NFKC: compatibility forms of the letters count (R22)', () => {
  test('fullwidth letters fold to ASCII', () => {
    expect(classifyInbound('ＳＴＯＰ')).toBe('stop');
    expect(classifyInbound('ｓｔｏｐ')).toBe('stop');
    expect(classifyInbound('ＵＮＳＵＢＳＣＲＩＢＥ')).toBe('stop');
    expect(classifyInbound('ｓｔｏｐ ｔｅｘｔｉｎｇ ｍｅ')).toBe('stop');
    expect(classifyInbound('ＨＥＬＰ')).toBe('help');
  });

  test('mathematical letters, ligatures and the long s fold too', () => {
    expect(classifyInbound('𝐒𝐓𝐎𝐏')).toBe('stop'); // mathematical bold
    expect(classifyInbound('𝘴𝘵𝘰𝘱')).toBe('stop'); // mathematical sans-serif italic
    expect(classifyInbound('ﬆop')).toBe('stop'); // U+FB06 LATIN SMALL LIGATURE ST
    expect(classifyInbound('ſtop')).toBe('stop'); // U+017F LATIN SMALL LETTER LONG S
  });

  test('a fullwidth space and punctuation are spaces and punctuation', () => {
    expect(classifyInbound('ｓｔｏｐ　ｔｅｘｔｉｎｇ　ｍｅ！')).toBe('stop');
  });

  test('the Kelvin sign and U+0130 still strip instead of becoming k and i', () => {
    // NFKC alone turns U+212A into "K"; it is dropped before NFKC runs, as the strip always did.
    expect(classifyInbound('ta\u212Ae me off the list')).toBe('other'); // "tae me off the list"
    expect(classifyInbound('\u212Aelvin')).toBe('other');
    expect(classifyInbound('\u0130nfo')).toBe('other'); // "nfo"
    expect(classifyInbound('unsubscr\u0130be please')).toBe('other');
  });

  test('accented letters are still not their base letter', () => {
    expect(classifyInbound('ＳＴÖＰ')).toBe('other');
    expect(classifyInbound('stöp')).toBe('other');
  });

  test('NFKC never loses a STOP the plain reading finds', () => {
    // "™" folds to the letters TM and an "o" plus a combining diaeresis composes to "ö"; read
    // either way the message is still a STOP, because the plain reading (no folding) is a STOP.
    expect(classifyInbound('STOP™')).toBe('stop');
    expect(classifyInbound('stöp')).toBe('stop');
    expect(classifyInbound('STOP ℹ')).toBe('stop');
  });

  test('NFKC never makes a START: consent comes back only from a START that reads as START without folding', () => {
    expect(classifyInbound('ＳＴＡＲＴ')).toBe('other');
    expect(classifyInbound('𝐒𝐓𝐀𝐑𝐓')).toBe('other');
    expect(classifyInbound('ＵＮＳＴＯＰ')).toBe('other');
    expect(classifyInbound('ſtart')).toBe('other');
  });
});

describe('repeated words collapse (R22)', () => {
  test.each([
    ['stop stop stop', 'stop'],
    ['STOP STOP', 'stop'],
    ['Stop. Stop! Stop!!', 'stop'],
    ['cancel cancel', 'stop'],
    ['unsubscribe unsubscribe unsubscribe', 'stop'],
    ['please please stop', 'stop'],
    ['stop texting texting me', 'stop'],
    ['ＳＴＯＰ ＳＴＯＰ', 'stop'],
    ['help help', 'help'],
    ['start start', 'start'],
    ['yes yes start', 'start'],
  ])('%s → %s', (b, kind) => expect(classifyInbound(b)).toBe(kind));

  test('only neighbours collapse: words repeated with something between them do not', () => {
    expect(classifyInbound('stop now stop')).toBe('other');
    expect(classifyInbound('stop me stop')).toBe('other');
  });

  test('a repeated word inside a longer message is still a longer message', () => {
    expect(classifyInbound('stop stop the leak')).toBe('other');
  });
});

describe('START is strict: any digit anywhere makes it other (R22)', () => {
  test.each(['Start 9', 'START 2', 'start2', '9 start', 'yes start 1', 'unstop 4', 'Start #1', 'start 10am'])('%s → other', (b) =>
    expect(classifyInbound(b)).toBe('other'),
  );

  test('digits of any script count, in the message as sent', () => {
    expect(classifyInbound('Start ９')).toBe('other'); // fullwidth nine
    expect(classifyInbound('start ٣')).toBe('other'); // Arabic-Indic three
    expect(classifyInbound('start ²')).toBe('other'); // superscript two
    expect(classifyInbound('start ①')).toBe('other'); // circled one
  });

  test('STOP and HELP with digits are still STOP and HELP', () => {
    expect(classifyInbound('Stop 2')).toBe('stop');
    expect(classifyInbound('STOP 9')).toBe('stop');
    expect(classifyInbound('3 stop')).toBe('stop');
    expect(classifyInbound('stop texting me 2')).toBe('stop');
    expect(classifyInbound('help 1')).toBe('help');
  });

  test('START with no digits is still START', () => {
    expect(classifyInbound('START!')).toBe('start');
    expect(classifyInbound('Start 🙏')).toBe('start');
    expect(classifyInbound('yes, start')).toBe('start');
  });
});

describe('looksLikeOptOut: flags a message for a person to check (R22)', () => {
  test.each([
    'Can you stop by Thursday?',
    'stop texting me about gutters',
    'STOP!!! and call me',
    'how do I unsubscribe from these',
    'remove me from the Thursday schedule',
    'please remove me',
    'opt out of the extra coat',
    'I want to opt-out',
    'OPTOUT pls',
    'ＳＴＯＰ now',
    'stop',
    'Stop. Now.',
  ])('%s → true', (b) => expect(looksLikeOptOut(b)).toBe(true));

  test.each([
    'unstoppable',
    'can you remove meat from the order',
    'remover',
    'optional extras',
    'opt in',
    'the roof looks great',
    '',
    '   ',
  ])('%s → false', (b) => expect(looksLikeOptOut(b)).toBe(false));

  test('the Kelvin sign and U+0130 cannot build one of the words', () => {
    expect(looksLikeOptOut('unsubscr\u0130be')).toBe(false);
  });

  test('a body that is not a string is false, not a crash', () => {
    for (const bad of [undefined, null, 42, {}, ['stop']]) {
      expect(looksLikeOptOut(bad as unknown as string)).toBe(false);
    }
  });

  test('a megabyte of text is linear: a word at the far end is still found', () => {
    expect(looksLikeOptOut('the crew will come by at five. '.repeat(40_000) + 'stop')).toBe(true);
    expect(looksLikeOptOut('the crew will come by at five. '.repeat(40_000))).toBe(false);
  });
});

describe('readInbound: the kind and the keyword as matched, for the opt-out record', () => {
  test.each([
    ['STOP', 'stop', 'stop'],
    ["  Don't text me AGAIN!! ", 'stop', 'dont text me again'],
    ['STOP STOP STOP', 'stop', 'stop'],
    ['ＳＴＯＰ', 'stop', 'stop'],
    ['STOP™', 'stop', 'stop'],
    ['Opt-Out', 'stop', 'optout'],
    ['Help?', 'help', 'help'],
    ['yes, start', 'start', 'yes start'],
  ])('%s → %s, "%s"', (body, kind, keyword) => expect(readInbound(body)).toEqual({ kind, keyword }));

  test('anything else has no keyword', () => {
    expect(readInbound('Can you stop by Thursday?')).toEqual({ kind: 'other', keyword: null });
    expect(readInbound('Start 9')).toEqual({ kind: 'other', keyword: null });
    expect(readInbound(undefined as unknown as string)).toEqual({ kind: 'other', keyword: null });
  });

  test('classifyInbound is readInbound\'s kind', () => {
    for (const body of ['STOP', 'help', 'start', 'Start 9', 'ＳＴＡＲＴ', 'hello']) {
      expect(classifyInbound(body)).toBe(readInbound(body).kind);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1 (I2): polite opt-outs, and a wider flag

describe('courtesy words around a STOP phrase (I2a)', () => {
  test.each([
    'Please take me off your list',
    'no more texts please',
    'quit texting me please',
    'opt me out please',
    'dont contact me again',
    'dont text me anymore',
    "please don't text me anymore",
    'cancel please',
    'stop thanks',
    'Unsubscribe, thank you!',
    'pls stop',
    'plz remove me thx',
    'please please stop thanks thank you',
    'remove me please thanks',
    'stop again',
    'STOP!! Thank you.',
  ])('%s → stop', (b) => expect(classifyInbound(b)).toBe('stop'));

  test('the keyword kept is the whole message as normalized, courtesy words and all', () => {
    expect(readInbound('Please take me off your list')).toEqual({ kind: 'stop', keyword: 'please take me off your list' });
    expect(readInbound('stop thanks')).toEqual({ kind: 'stop', keyword: 'stop thanks' });
  });

  test('courtesy words alone are not a STOP', () => {
    for (const b of ['please', 'thanks', 'thank you', 'please thanks', 'again', 'anymore', 'pls thx']) {
      expect(classifyInbound(b)).toBe('other');
    }
  });

  test('only at the ends: a courtesy word in the middle still makes a longer message', () => {
    expect(classifyInbound('stop please texting')).toBe('other');
    expect(classifyInbound('remove please me')).toBe('other');
  });

  test('never for START or HELP: they must still be the bare keyword', () => {
    expect(classifyInbound('please start')).toBe('other');
    expect(classifyInbound('start please')).toBe('other');
    expect(classifyInbound('start again')).toBe('other');
    expect(classifyInbound('unstop thanks')).toBe('other');
    expect(classifyInbound('help please')).toBe('other');
  });

  test('a long run of courtesy words is linear', () => {
    expect(classifyInbound('please pls '.repeat(100_000) + 'stop' + ' thanks thx'.repeat(100_000))).toBe('stop');
    expect(classifyInbound('please pls '.repeat(100_000))).toBe('other');
  });
});

describe('the reviewer\'s probes: each is a STOP, or flagged for a person (I2)', () => {
  test.each([
    'Please take me off your list',
    'no more texts please',
    'quit texting me please',
    'opt me out please',
    'dont contact me again',
    'never text me again',
    'dont text me anymore',
    "please don't text me anymore",
    'Revoke consent',
    'I want to cancel these texts',
    'cancel please',
    'end texts',
    'remove my number from your list',
    'take me off this list',
    'no more messages',
    'delete me',
  ])('%s', (b) => {
    const kind = classifyInbound(b);
    expect(kind === 'stop' || (kind === 'other' && looksLikeOptOut(b))).toBe(true);
  });

  test.each(['start the job Monday', 'stop by tomorrow', 'cancel my 9am', 'end of the month works', 'please remove the old shingles'])(
    'over-match probe %s is neither STOP nor START',
    (b) => expect(classifyInbound(b)).toBe('other'),
  );
});

describe('looksLikeOptOut, widened (I2b)', () => {
  test.each([
    // each word and phrase, as written
    'please stop', 'how do I unsubscribe', 'I quit', 'end', 'revoke it', 'cancel', 'optout',
    'can I opt out', 'remove me', 'remove my number', 'take me off', 'dont text me', 'do not contact me',
    'never message me', 'no more texts', 'no more messages', 'leave me alone', 'delete me',
    // inflected
    'the gutters stopped leaking', 'stopping by at 5', 'stops', 'I unsubscribed last week', 'quitting texts',
    'ending this', 'I revoked that', 'cancelled', 'canceling the texts', 'I opted out', 'removed me',
    'removing my numbers', 'taking me off', 'stop texting me', 'you keep messaging me', 'contacted me twice',
    'no more text', 'leaving me alone', 'deleted me',
    // others
    'cancel my appointment', 'Revoke consent', 'ＤＥＬＥＴＥ ＭＥ',
  ])('%s → true', (b) => expect(looksLikeOptOut(b)).toBe(true));

  test.each([
    'unstoppable', 'that is quite a storm', 'see you this weekend', 'please send the quote', 'we attend Sunday',
    'endorse', 'the textbook', 'in that context', 'remove meat', 'remover', 'cancellation fee', 'opt in',
    'take a look', 'contact us', 'leave the ladder', 'delete the photo', 'more texts', 'the roof looks great',
  ])('%s → false: stems are words, not substrings', (b) => expect(looksLikeOptOut(b)).toBe(false));
});
