import type { Carrier } from '@roofline/shared';

/** Call forwarding words. The step sentences and dial codes come from forwardingSteps() in the shared package. */
export const forwarding = {
  title: 'Send your calls to Front Desk',
  carriers: {
    verizon: 'Verizon',
    att: 'AT&T',
    tmobile: 'T-Mobile',
    other_gsm: 'Another cell phone company',
    landline: 'A landline',
    ringcentral: 'RingCentral',
    google_voice: 'Google Voice',
    ooma: 'Ooma',
    spectrum: 'Spectrum',
    comcast: 'Comcast',
    grasshopper: 'Grasshopper',
    other: 'Something else',
  } satisfies Record<Carrier, string>,
  modes: {
    all: 'Forward every call',
    no_answer: 'Forward calls I miss',
  },
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  dialIntro: 'Dial this on your phone, then press call.',
  stepsIntro: 'Follow these steps in your phone account.',
} as const;
