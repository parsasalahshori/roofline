import { HOME_STREET } from './script-helpers.ts';
import type { Scenario } from './types.ts';

export const jobVerified: Scenario = {
  id: 'job-verified',
  title: 'A customer is verified by name and street, then told where their job stands',
  covers: 'job question (verified)',
  persona:
    "Nina Park, an existing customer at 412 Oak St, Omaha. She phones from the number on her account and asks where her job stands. When asked to confirm who she is she says her full name and street.",
  callerLines: ["Hi, where is my job at the moment? I'm Nina Park on 412 Oak Street.", 'Okay, thank you, goodbye.'],
  seed: { caller: 'known' },
  scripted: [
    {
      route: { intent: 'job_status' },
      answer: [
        { kind: 'text', text: 'Your job is in the inspection stage.' },
        { kind: 'tool', name: 'verify_caller', input: { name: 'Nina Park', street: HOME_STREET } },
        { kind: 'tool', name: 'lookup_my_jobs', input: {} },
      ],
    },
    { route: {}, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
  ],
  must: {
    tools: ['verify_caller', 'lookup_my_jobs'],
    ending: 'end',
    endingReasons: ['goodbye'],
    outcome: 'job_question',
    guardHits: 'none',
    spoken: [/inspection/i],
  },
  mustNot: { phrases: [], tools: ['transfer_to_person'] },
  toneRubric: ['Gives the status in one or two plain sentences, not a data dump.'],
};
