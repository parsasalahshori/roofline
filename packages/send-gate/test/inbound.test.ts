import { describe, expect, test } from 'vitest';
import { classifyInbound } from '../src/index.ts';

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

  test('a megabyte of repeated keywords is other: the message must be the keyword and nothing else', () => {
    expect(classifyInbound('stop '.repeat(200_000))).toBe('other');
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
