export const CARRIERS = [
  'verizon',
  'att',
  'tmobile',
  'other_gsm',
  'landline',
  'ringcentral',
  'google_voice',
  'ooma',
  'spectrum',
  'comcast',
  'grasshopper',
  'other',
] as const;

export type Carrier = (typeof CARRIERS)[number];

export type ForwardingSteps = {
  kind: 'dial' | 'steps';
  on: string[];
  off: string[];
};

// E.164 (+15551234567) to the 10-digit national number (5551234567).
// Non-digits are stripped; an 11-digit number starting with 1 loses the 1.
function tenDigits(roofline: string): string {
  const digits = roofline.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function formatNumber(ten: string): string {
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6, 10)}`;
}

const STEPS: Record<
  Exclude<Carrier, 'verizon' | 'att' | 'tmobile' | 'other_gsm' | 'landline'>,
  (num: string, mode: 'all' | 'no_answer') => { on: string[]; off: string[] }
> = {
  ringcentral: (num, mode) => ({
    on: [
      'Sign in to the RingCentral admin portal.',
      'Go to Phone System, then Call Handling & Forwarding.',
      mode === 'all'
        ? `Turn on forwarding for all calls and set the number to ${num}.`
        : `Turn on forwarding for unanswered calls and set the number to ${num}.`,
      'Save the changes.',
    ],
    off: [
      'Sign in to the RingCentral admin portal.',
      'Go to Phone System, then Call Handling & Forwarding.',
      'Turn off call forwarding and save.',
    ],
  }),
  google_voice: (num, mode) => ({
    on: [
      'Open Google Voice and go to Settings.',
      'Open the Calls section.',
      mode === 'all'
        ? `Under Forward calls to linked numbers, add ${num} and turn it on for all calls.`
        : `Under Forward calls to linked numbers, add ${num} and turn it on for unanswered calls.`,
      'Save the changes.',
    ],
    off: [
      'Open Google Voice and go to Settings.',
      'Open the Calls section.',
      'Turn off the linked number for forwarding.',
    ],
  }),
  ooma: (num, mode) => ({
    on: [
      'Sign in to the Ooma Office portal or the Ooma app.',
      'Open Call forwarding.',
      mode === 'all'
        ? `Turn on forwarding for all calls and enter ${num}.`
        : `Turn on forwarding for unanswered calls and enter ${num}.`,
      'Save the changes.',
    ],
    off: [
      'Sign in to the Ooma Office portal or the Ooma app.',
      'Open Call forwarding.',
      'Turn off call forwarding and save.',
    ],
  }),
  spectrum: (num, mode) => ({
    on: [
      'Sign in to the Spectrum Business voice portal.',
      'Open Call forwarding.',
      mode === 'all'
        ? `Turn on forwarding for all calls and enter ${num}.`
        : `Turn on forwarding for unanswered calls and enter ${num}.`,
      'Save the changes.',
    ],
    off: [
      'Sign in to the Spectrum Business voice portal.',
      'Open Call forwarding.',
      'Turn off call forwarding and save.',
    ],
  }),
  comcast: (num, mode) => ({
    on: [
      'Sign in to the Comcast Business voice admin portal.',
      'Open Call forwarding.',
      mode === 'all'
        ? `Turn on forwarding for all calls and enter ${num}.`
        : `Turn on forwarding for unanswered calls and enter ${num}.`,
      'Save the changes.',
    ],
    off: [
      'Sign in to the Comcast Business voice admin portal.',
      'Open Call forwarding.',
      'Turn off call forwarding and save.',
    ],
  }),
  grasshopper: (num, mode) => ({
    on: [
      'Open the Grasshopper app or website and go to Settings.',
      'Open call forwarding for your extension.',
      mode === 'all'
        ? `Turn on forwarding for all calls and enter ${num}.`
        : `Turn on forwarding for unanswered calls and enter ${num}.`,
      'Save the changes.',
    ],
    off: [
      'Open the Grasshopper app or website and go to Settings.',
      'Open call forwarding for your extension.',
      'Turn off call forwarding and save.',
    ],
  }),
  other: (num, mode) => ({
    on: [
      'Look for Call forwarding in your phone system.',
      mode === 'all'
        ? `Turn on forwarding for all calls and enter ${num}.`
        : `Turn on forwarding for unanswered calls and enter ${num}.`,
      'Save the changes.',
    ],
    off: [
      'Look for Call forwarding in your phone system.',
      'Turn off call forwarding and save.',
    ],
  }),
};

/**
 * Call-forwarding setup for a carrier, per spec section 12.
 * Mobile GSM and landline carriers get dialable codes (kind 'dial');
 * VoIP and business phone systems get plain-English steps (kind 'steps').
 */
export function forwardingSteps(
  carrier: Carrier,
  mode: 'all' | 'no_answer',
  roofline: string,
): ForwardingSteps {
  const ten = tenDigits(roofline);
  const num = formatNumber(ten);

  switch (carrier) {
    case 'verizon':
      return {
        kind: 'dial',
        on: [mode === 'all' ? `*72${ten}` : `*71${ten}`],
        off: ['*73'],
      };
    case 'att':
    case 'tmobile':
    case 'other_gsm':
      return {
        kind: 'dial',
        on: [mode === 'all' ? `**21*${ten}#` : `**61*${ten}#`],
        off: [mode === 'all' ? '##21#' : '##61#'],
      };
    case 'landline':
      return {
        kind: 'dial',
        on: [`*72${ten}`],
        off: ['*73'],
      };
    default: {
      const steps = STEPS[carrier](num, mode);
      return { kind: 'steps', on: steps.on, off: steps.off };
    }
  }
}
