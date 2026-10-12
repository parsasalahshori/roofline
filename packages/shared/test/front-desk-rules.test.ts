import { describe, expect, test } from 'vitest';
import {
  ASK_PERSON_INTENTS,
  matchCaller,
  ROUTER_INTENTS,
  shouldTextBack,
  shouldTransfer,
  transferPlan,
  TURN_LIMIT_END_MINUTES,
  TURN_LIMIT_OFFER_TURNS,
  turnLimit,
  verifyCaller,
  type TransferReason,
} from '../src/front-desk-rules.ts';

type TransferIn = Parameters<typeof shouldTransfer>[0];
const base: TransferIn = {
  intent: 'quote',
  urgent: false,
  mood: 'calm',
  askedForPersonCount: 0,
  taskInProgress: false,
  failedUnderstanding: 0,
};

describe('shouldTransfer', () => {
  const rows: [string, Partial<TransferIn>, TransferReason | null][] = [
    ['nothing special', {}, null],
    ['leak', { intent: 'leak' }, 'leak'],
    ['active_leak', { intent: 'active_leak' }, 'leak'],
    ['danger', { intent: 'danger' }, 'danger'],
    ['injury', { intent: 'injury' }, 'danger'],
    ['fire', { intent: 'fire' }, 'danger'],
    ['angry', { mood: 'angry' }, 'angry'],
    ['upset alone', { mood: 'upset' }, null],
    ['trade_caller', { intent: 'trade_caller' }, 'trade_caller'],
    ['adjuster', { intent: 'adjuster' }, 'trade_caller'],
    ['inspector', { intent: 'inspector' }, 'trade_caller'],
    ['supplier', { intent: 'supplier' }, 'trade_caller'],
    ['model_failure', { intent: 'model_failure' }, 'model_failure'],
    ['asked once no task', { intent: 'ask_for_person', askedForPersonCount: 1 }, 'asked'],
    ['asked once with task', { intent: 'ask_for_person', askedForPersonCount: 1, taskInProgress: true }, null],
    ['asked twice with task', { intent: 'ask_for_person', askedForPersonCount: 2, taskInProgress: true }, 'asked'],
    ['transfer intent once', { intent: 'transfer', askedForPersonCount: 1 }, 'asked'],
    ['human intent once', { intent: 'human', askedForPersonCount: 1 }, 'asked'],
    ['count alone once', { askedForPersonCount: 1 }, 'asked'],
    ['count alone once with task', { askedForPersonCount: 1, taskInProgress: true }, null],
    ['count alone twice with task', { askedForPersonCount: 2, taskInProgress: true }, 'asked'],
    ['failed 2', { failedUnderstanding: 2 }, null],
    ['failed 3', { failedUnderstanding: 3 }, 'not_understood'],
    ['failed 5', { failedUnderstanding: 5 }, 'not_understood'],
    ['leak beats angry', { intent: 'leak', mood: 'angry' }, 'leak'],
    ['danger beats leak-less angry', { intent: 'danger', mood: 'angry' }, 'danger'],
    ['angry beats trade_caller', { intent: 'trade_caller', mood: 'angry' }, 'angry'],
    ['angry beats asked', { mood: 'angry', askedForPersonCount: 1 }, 'angry'],
    ['asked beats not_understood', { askedForPersonCount: 1, failedUnderstanding: 3 }, 'asked'],
    ['urgent flag alone', { urgent: true }, null],
  ];
  test.each(rows)('%s', (_n, over, want) => {
    expect(shouldTransfer({ ...base, ...over })).toBe(want);
  });
});

describe('transferPlan', () => {
  const a = { userId: 'u1', phone: '+15555550101' };
  const b = { userId: 'u2', phone: '+15555550102' };
  type PlanIn = Parameters<typeof transferPlan>[0];
  const rows: [string, PlanIn, 'ring_all' | 'ring_each' | 'message', typeof a[]][] = [
    ['work hours ring_all order kept', { reason: 'asked', urgent: false, inWorkHours: true, onCall: [b, a] }, 'ring_all', [b, a]],
    ['after hours urgent ring_each', { reason: 'asked', urgent: true, inWorkHours: false, onCall: [a, b] }, 'ring_each', [a, b]],
    ['after hours leak ring_each', { reason: 'leak', urgent: false, inWorkHours: false, onCall: [a, b] }, 'ring_each', [a, b]],
    ['after hours danger ring_each', { reason: 'danger', urgent: false, inWorkHours: false, onCall: [b, a] }, 'ring_each', [b, a]],
    ['after hours not urgent message', { reason: 'asked', urgent: false, inWorkHours: false, onCall: [a, b] }, 'message', []],
    ['empty onCall work hours', { reason: 'asked', urgent: false, inWorkHours: true, onCall: [] }, 'message', []],
    ['empty onCall urgent after hours', { reason: 'danger', urgent: true, inWorkHours: false, onCall: [] }, 'message', []],
  ];
  test.each(rows)('%s', (_n, input, mode, targets) => {
    const plan = transferPlan(input);
    expect(plan.mode).toBe(mode);
    expect(plan.targets).toEqual(targets);
    expect(plan.timeoutSeconds).toBe(20);
  });
  test('copies the array', () => {
    const onCall = [a, b];
    const plan = transferPlan({ reason: 'asked', urgent: false, inWorkHours: true, onCall });
    expect(plan.targets).not.toBe(onCall);
  });
});

describe('shouldTextBack', () => {
  type TbIn = Parameters<typeof shouldTextBack>[0];
  const tb: TbIn = {
    callerTurns: 3,
    secondsInCall: 120,
    status: 'completed',
    lineType: 'mobile',
    spam: false,
    textedBackLast24h: false,
    enabled: true,
  };
  const rows: [string, Partial<TbIn>, boolean][] = [
    ['normal completed call', {}, false],
    ['disabled', { enabled: false, status: 'failed' }, false],
    ['spam', { spam: true, status: 'failed' }, false],
    ['texted in last 24h', { textedBackLast24h: true, status: 'failed' }, false],
    ['landline', { lineType: 'landline', status: 'failed' }, false],
    ['voip', { lineType: 'voip', status: 'failed' }, false],
    ['unknown line', { lineType: 'unknown', status: 'failed' }, false],
    ['failed with turns', { status: 'failed' }, true],
    ['zero turns', { callerTurns: 0 }, true],
    ['15 seconds', { callerTurns: 1, secondsInCall: 15 }, true],
    ['16 seconds one turn', { callerTurns: 1, secondsInCall: 16 }, false],
    ['busy long', { status: 'busy' }, false],
    ['busy zero turns', { status: 'busy', callerTurns: 0, secondsInCall: 0 }, true],
    ['no_answer short', { status: 'no_answer', secondsInCall: 5 }, true],
    ['no_answer long with turns', { status: 'no_answer' }, false],
    ['landline zero turns', { lineType: 'landline', callerTurns: 0 }, false],
  ];
  test.each(rows)('%s', (_n, over, want) => {
    expect(shouldTextBack({ ...tb, ...over })).toBe(want);
  });
});

describe('turnLimit', () => {
  const rows: [number, number, 'ok' | 'offer_person' | 'end'][] = [
    [0, 0, 'ok'],
    [39, 24.9, 'ok'],
    [40, 5, 'offer_person'],
    [25, 25, 'offer_person'],
    [10, 29.9, 'offer_person'],
    [10, 30, 'end'],
    [100, 10, 'offer_person'],
    [100, 31, 'end'],
  ];
  test.each(rows)('turns %d minutes %d', (turns, minutes, want) => {
    expect(turnLimit({ turns, minutes })).toBe(want);
  });

  test('the exported constants drive the limits', () => {
    expect(turnLimit({ turns: TURN_LIMIT_OFFER_TURNS, minutes: 0 })).toBe('offer_person');
    expect(turnLimit({ turns: 0, minutes: TURN_LIMIT_END_MINUTES })).toBe('end');
  });
});

describe('matchCaller', () => {
  const m1 = { customerId: 'c1', firstName: 'Ana', lastName: 'Lopez', streets: ['412 Elm St'] };
  test('no matches', () => expect(matchCaller([])).toBe('unknown'));
  test('one match', () => expect(matchCaller([m1])).toBe('matched'));
  test('same customer twice', () => expect(matchCaller([m1, { ...m1, streets: ['9 Oak Ave'] }])).toBe('matched'));
  test('two customers is ambiguous', () =>
    expect(matchCaller([m1, { ...m1, customerId: 'c2', firstName: 'Ben' }])).toBe('unknown'));
});

describe('verifyCaller', () => {
  const c = { lastName: 'Lopez', streets: ['412 Elm St', '9 Oak Avenue'] };
  const rows: [string, { lastName: string; streets: string[] }, { name: string; street: string }, boolean][] = [
    ['full name, exact street', c, { name: 'Maria Lopez', street: '412 Elm St' }, true],
    ['lowercase last name', c, { name: 'lopez', street: '412 elm st' }, true],
    ['Ms. Lopez punctuation', c, { name: 'Ms. Lopez', street: '412 Elm St.' }, true],
    ['Elm vs Elm St', c, { name: 'Lopez', street: 'Elm' }, true],
    ['elm street vs Elm St', c, { name: 'Lopez', street: 'elm street' }, true],
    ['number optional', c, { name: 'Lopez', street: 'Elm St' }, true],
    ['right number', c, { name: 'Lopez', street: '412 Elm' }, true],
    ['wrong number', c, { name: 'Lopez', street: '413 Elm St' }, false],
    ['second street, avenue vs ave', c, { name: 'Lopez', street: '9 oak ave' }, true],
    ['Main vs Maple', { lastName: 'Lopez', streets: ['5 Maple St'] }, { name: 'Lopez', street: 'Main' }, false],
    ['partial last name', c, { name: 'Lop', street: 'Elm' }, false],
    ['extended last name', c, { name: 'Lopezz', street: 'Elm' }, false],
    ['wrong last name', c, { name: 'Garcia', street: 'Elm' }, false],
    ['empty name', c, { name: '', street: 'Elm' }, false],
    ['empty street', c, { name: 'Lopez', street: '' }, false],
    ['whitespace inputs', c, { name: '  ', street: '   ' }, false],
    ['no stored streets', { lastName: 'Lopez', streets: [] }, { name: 'Lopez', street: 'Elm' }, false],
    ['directional optional', { lastName: 'Lopez', streets: ['12 N Elm Street'] }, { name: 'Lopez', street: 'Elm' }, true],
    ['directional in said only', { lastName: 'Lopez', streets: ['12 Elm St'] }, { name: 'Lopez', street: 'north elm street' }, true],
    ['extra street word fails', c, { name: 'Lopez', street: 'Elm Grove' }, false],
    ['punctuated name', { lastName: "O'Brien", streets: ['1 Elm St'] }, { name: 'Pat OBrien', street: 'Elm' }, true],
    ['street that is only a suffix', c, { name: 'Lopez', street: 'street' }, false],
  ];
  test.each(rows)('%s', (_n, card, said, want) => {
    expect(verifyCaller(card, said)).toBe(want);
  });
});

describe('router intents', () => {
  test('ROUTER_INTENTS contains every intent shouldTransfer keys on', () => {
    for (const i of ['leak', 'active_leak', 'danger', 'injury', 'fire', 'trade_caller', 'adjuster', 'inspector', 'supplier', 'ask_for_person', 'transfer', 'human', 'not_understood', 'spam', 'sales_pitch']) {
      expect(ROUTER_INTENTS as readonly string[]).toContain(i);
    }
  });

  test('ROUTER_INTENTS contains every intent the scenarios, engine and smoke use', () => {
    for (const i of ['emergency', 'insurance_question', 'pricing', 'prompt_injection', 'recording_objection']) {
      expect(ROUTER_INTENTS as readonly string[]).toContain(i);
    }
    expect(ROUTER_INTENTS.some((i) => /record/i.test(i))).toBe(true);
  });

  test('ASK_PERSON_INTENTS is ask_for_person, transfer, human', () => {
    expect([...ASK_PERSON_INTENTS].sort()).toEqual(['ask_for_person', 'human', 'transfer']);
  });
});
