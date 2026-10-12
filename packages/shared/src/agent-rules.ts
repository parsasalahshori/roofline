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
  stormScout?: { thresholdInches: number; budgetCents: number; days: number };
  frontDesk?: {
    phoneNumber: string;
    transferNames: string[];
    canBook: boolean;
    canConfirm: boolean;
    canMove: boolean;
  };
};

const STORM_SETTINGS = "/settings/storm";
const FRONT_DESK_SETTINGS = "/settings/front-desk";

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
  const budget = dollarsText(storm.budgetCents);
  const days = daysText(storm.days);
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

/** The rule sentences for one agent's card. Agents without facts (or without rules) return []. */
export function rulesFor(agent: Agent, s: AgentRuleFacts): RuleSentence[] {
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
    default:
      return [];
  }
}
