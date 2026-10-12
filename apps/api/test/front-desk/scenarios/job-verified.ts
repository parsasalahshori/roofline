import { HOME_STREET } from './script-helpers.ts';
import { PRICE_PHRASES, type PriorTool, type Scenario } from './types.ts';

/** The status line, said only once lookup_my_jobs has succeeded and reported the stage (so CI cannot pass on a guess). */
function statusAfterLookup(prior: readonly PriorTool[]) {
  const looked = prior.find((p) => p.name === 'lookup_my_jobs' && p.ok && /inspection stage/i.test(p.result));
  const text = looked ? 'Your job is in the inspection stage, and the team is arranging the inspection. Thanks for calling, goodbye.' : 'Thanks for calling, goodbye.';
  return [
    { kind: 'text' as const, text },
    { kind: 'tool' as const, name: 'end_call' as const, input: { reason: 'goodbye' } },
  ];
}

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
      // No status before the lookup: the status is only said once lookup_my_jobs has answered.
      answer: [
        { kind: 'tool', name: 'verify_caller', input: { name: 'Nina Park', street: HOME_STREET } },
        { kind: 'tool', name: 'lookup_my_jobs', input: {} },
      ],
    },
    { route: {}, answer: statusAfterLookup },
  ],
  must: {
    tools: ['verify_caller', 'lookup_my_jobs'],
    ending: 'end',
    endingReasons: ['goodbye'],
    outcome: 'job_question',
    guardHits: 'none',
    spoken: [/inspection stage|arranging the inspection/i],
  },
  mustNot: {
    // No raw record ids and no price talk: the status is said in plain words.
    phrases: [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, ...PRICE_PHRASES],
    tools: ['transfer_to_person'],
  },
  toneRubric: ['Gives the status in one or two plain sentences, not a data dump.'],
};
