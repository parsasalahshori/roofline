/*
 * Agents screen (A1, spec 6): the plain-English rule sentences shown on each agent's card.
 * Pure: every fact value is written into the text from `AgentRuleFacts`, which the API fills.
 * Each fact value appears once as a link label; the link points at the page where it is changed.
 */
import type { Agent } from "./enums.ts";

export type RuleSentence = {
  text: string;
  links: { label: string; href: string }[];
};

export type AgentRuleFacts = {
  /** budgetCents null = leave the ad-budget clause out (reps). */
  stormScout?: { thresholdInches: number; budgetCents: number | null; days: number };
  /** true = every rule gets `links: []` (reps cannot open the settings pages). */
  noLinks?: boolean;
  frontDesk?: {
    phoneNumber: string;
    transferNames: string[];
    canBook: boolean;
    canConfirm: boolean;
    canMove: boolean;
  };
  claims?: { nudgeDays: [number, number, number] };
  scheduler?: { reminderHour: number; rainPct: number; gustMph: number };
  followUp?: {
    proposalDays: [number, number];
    leadDays: number;
    reviewDelayDays: number;
    /** True only when the follow-up reviews switch is on and a review link is saved. */
    reviewsOn: boolean;
    /** Default true. */
    leadsOn?: boolean;
    /** Default true. */
    proposalsOn?: boolean;
  };
};

const STORM_SETTINGS = "/settings/storm";
const FRONT_DESK_SETTINGS = "/settings/front-desk";
const AGENT_SETTINGS = "/settings/agents";

/** '1 inch', '1.5 inches' (singular only for exactly 1). */
function inchesText(inches: number): string {
  return inches === 1 ? "1 inch" : `${inches} inches`;
}

/** '$270' from cents; whole dollars. */
function dollarsText(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** '7 days' ('1 day' singular). */
function daysText(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** 'book', 'book and confirm', 'book, confirm and move'. */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** 'Sam', 'Sam, then Pat', 'Sam, then Pat, then Lee'. */
function transferText(names: string[]): string {
  const [first, ...rest] = names;
  return `${first}${rest.map((name) => `, then ${name}`).join("")}`;
}

function stormRules(
  storm: NonNullable<AgentRuleFacts["stormScout"]>,
): RuleSentence[] {
  const threshold = inchesText(storm.thresholdInches);
  const days = daysText(storm.days);
  if (storm.budgetCents === null) {
    return [
      {
        text: `When hail of ${threshold} or more hits your service area, I draft a storm plan: texts, emails, door-knock routes and ads over ${days}.`,
        links: [
          { label: threshold, href: STORM_SETTINGS },
          { label: days, href: STORM_SETTINGS },
        ],
      },
    ];
  }
  const budget = dollarsText(storm.budgetCents);
  return [
    {
      text: `When hail of ${threshold} or more hits your service area, I draft a storm plan: texts, emails, door-knock routes and ads up to ${budget} over ${days}.`,
      links: [
        { label: threshold, href: STORM_SETTINGS },
        { label: budget, href: STORM_SETTINGS },
        { label: days, href: STORM_SETTINGS },
      ],
    },
  ];
}

function frontDeskRules(
  desk: NonNullable<AgentRuleFacts["frontDesk"]>,
): RuleSentence[] {
  const rules: RuleSentence[] = [
    {
      text: `I answer every call to ${desk.phoneNumber}.`,
      links: [{ label: desk.phoneNumber, href: FRONT_DESK_SETTINGS }],
    },
  ];

  const verbs: string[] = [];
  if (desk.canBook) verbs.push("book");
  if (desk.canConfirm) verbs.push("confirm");
  if (desk.canMove) verbs.push("move");
  if (verbs.length > 0) {
    const phrase = joinWords(verbs);
    rules.push({
      text: `I can ${phrase} inspections; I never give prices.`,
      links: [{ label: phrase, href: FRONT_DESK_SETTINGS }],
    });
  } else {
    rules.push({
      text: "I take messages for your team; I never give prices.",
      links: [{ label: "take messages", href: FRONT_DESK_SETTINGS }],
    });
  }

  const names = desk.transferNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length > 0) {
    const phrase = transferText(names);
    rules.push({
      text: `I transfer urgent calls to ${phrase}.`,
      links: [{ label: phrase, href: FRONT_DESK_SETTINGS }],
    });
  }

  return rules;
}

/** '4 PM', '12 AM', '12 PM' from an hour 0 to 23. */
function hourText(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

function claimsRules(
  claims: NonNullable<AgentRuleFacts["claims"]>,
): RuleSentence[] {
  const [d0, d1, d2] = claims.nudgeDays.map(daysText) as [string, string, string];
  return [
    {
      text: `I check claims every morning at 10 and draft check-in texts for you to approve: ${d0} after the inspection if no claim is filed, ${d1} after filing if no adjuster date, ${d2} after the adjuster visit.`,
      links: [d0, d1, d2].map((label) => ({ label, href: AGENT_SETTINGS })),
    },
    {
      text: "I never contact insurers or adjusters, and I never talk about coverage or deductibles.",
      links: [],
    },
  ];
}

function schedulerRules(
  scheduler: NonNullable<AgentRuleFacts["scheduler"]>,
): RuleSentence[] {
  const hour = hourText(scheduler.reminderHour);
  const rain = `${scheduler.rainPct}%`;
  const gust = `${scheduler.gustMph} mph`;
  return [
    {
      text: `At ${hour} I draft reminder texts for tomorrow's visits for you to approve.`,
      links: [{ label: hour, href: AGENT_SETTINGS }],
    },
    {
      text: "At 6 PM I email each crew member their visits for tomorrow.",
      links: [],
    },
    {
      text: `At 6 AM and 2 PM I check the weather for the next three days of installs and suggest moving any with rain of ${rain} or more or gusts of ${gust} or more. I never cancel.`,
      links: [
        { label: rain, href: AGENT_SETTINGS },
        { label: gust, href: AGENT_SETTINGS },
      ],
    },
    {
      text: "When a visit is marked no-show, I draft a text offering two new times.",
      links: [],
    },
  ];
}

function followUpRules(
  f: NonNullable<AgentRuleFacts["followUp"]>,
): RuleSentence[] {
  const rules: RuleSentence[] = [];
  if (f.proposalsOn !== false) {
    const d0 = daysText(f.proposalDays[0]);
    const d1 = daysText(f.proposalDays[1]);
    rules.push({
      text: `After a proposal goes out, I draft a follow-up text for you to approve ${d0} and ${d1} later if there is no answer.`,
      links: [
        { label: d0, href: AGENT_SETTINGS },
        { label: d1, href: AGENT_SETTINGS },
      ],
    });
  }
  if (f.leadsOn !== false) {
    const quiet = daysText(f.leadDays);
    rules.push({
      text: `I draft a follow-up text for a lead that has gone quiet for ${quiet}.`,
      links: [{ label: quiet, href: AGENT_SETTINGS }],
    });
  }
  rules.push({
    text: "When a job is stuck, I leave a next step for the rep and send no text.",
    links: [],
  });
  if (f.reviewsOn) {
    const delay = daysText(f.reviewDelayDays);
    rules.push({
      text: `${delay} after an install, I draft a review request, only to customers who agreed to marketing texts.`,
      links: [{ label: delay, href: AGENT_SETTINGS }],
    });
  } else {
    rules.push({
      text: "Reviews are off until you add your review link.",
      links: [{ label: "review link", href: AGENT_SETTINGS }],
    });
  }
  rules.push({
    text: "At most one text per customer every 3 days, and none after they reply.",
    links: [],
  });
  return rules;
}

/** The rule sentences for one agent's card. Agents without facts (or without rules) return []. */
export function rulesFor(agent: Agent, s: AgentRuleFacts): RuleSentence[] {
  const rules = rulesForAgent(agent, s);
  return s.noLinks === true ? rules.map((rule) => ({ ...rule, links: [] })) : rules;
}

function rulesForAgent(agent: Agent, s: AgentRuleFacts): RuleSentence[] {
  switch (agent) {
    case "storm_scout":
      return s.stormScout ? stormRules(s.stormScout) : [];
    case "estimator":
      return [
        {
          text: "When you type an address, I measure the roof and draft a three-option proposal. I order exact reports only when you approve.",
          links: [],
        },
      ];
    case "front_desk":
      return s.frontDesk ? frontDeskRules(s.frontDesk) : [];
    case "claims":
      return s.claims ? claimsRules(s.claims) : [];
    case "scheduler":
      return s.scheduler ? schedulerRules(s.scheduler) : [];
    case "follow_up":
      return s.followUp ? followUpRules(s.followUp) : [];
    default:
      return [];
  }
}
