import { type Script, ScriptedLlm } from '../providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../providers/llm.ts';

/*
 * The demo's Front Desk "model": a ScriptedLlm whose rules give believable answers to the homeowner lines the
 * simulate routes use (demo/simulate.ts), with a polite catch-all for anything else typed in a demo. It never
 * reaches the network. Answers are plain text only, so no tool handler runs from a scripted line.
 */

const ANSWER: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };

/** What the demo homeowner says on the simulated call, in order. */
export const DEMO_CALL_LINES = [
  "Hi, that hail storm last night came right over our street and I think it damaged my roof.",
  "I can see a few dents on the gutters and some shingle pieces in the yard.",
  'Thursday at 10 works great, and this number is the best one to reach me. Thank you!',
] as const;

/** The texts a demo homeowner sends; the simulate route rotates through them. */
export const DEMO_TEXTS = [
  'Hi, a few shingles blew off in the storm. Could someone look at my roof this week?',
  'Hello! Do you do free inspections after hail? Our neighbor said you were great.',
  'Is there any chance someone could come by Thursday to check the leak over our garage?',
] as const;

/** The after-call summary the demo call ends with. */
export const DEMO_CALL_SUMMARY =
  'Homeowner reported hail damage after last night\'s storm: dented gutters and shingle pieces in the yard. Front Desk booked a free inspection for Thursday at 10 AM.';

export const DEMO_SCRIPT: Script = [
  {
    when: /hail storm last night|damaged my roof/i,
    route: ANSWER,
    answer: [
      {
        kind: 'text',
        text: "I'm sorry to hear that. We've been out in your area since the storm, so we can get a free inspection on the calendar. What are you seeing so far?",
      },
    ],
  },
  {
    when: /dents|shingle pieces/i,
    route: ANSWER,
    answer: [
      {
        kind: 'text',
        text: 'Thanks, that helps. Dented gutters usually mean the roof took hits too. I can book a free inspection for Thursday at 10 AM. Does that work, and is this the best number for you?',
      },
    ],
  },
  {
    when: /best one to reach me|thank you/i,
    route: ANSWER,
    answer: [{ kind: 'text', text: "You're booked for Thursday at 10 AM. We'll text you a reminder the day before. Have a good afternoon!" }],
  },
  {
    when: /inspection|look at my roof|check the leak|come by/i,
    route: ANSWER,
    answer: [
      {
        kind: 'text',
        text: 'Thanks for reaching out! Yes, inspections are free. Someone from our team will text you shortly with a time this week that works.',
      },
    ],
  },
  {
    when: /[\s\S]*/,
    route: ANSWER,
    answer: [{ kind: 'text', text: 'Thanks for your message! Someone from our team will get back to you shortly.' }],
  },
];

/** A fresh demo Front Desk model. */
export function demoLlm(): ScriptedLlm {
  return new ScriptedLlm(DEMO_SCRIPT, { summary: DEMO_CALL_SUMMARY });
}
