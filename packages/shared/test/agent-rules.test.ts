import { describe, expect, test } from "vitest";
import { AGENTS, type Agent } from "../src/enums.ts";
import { type AgentRuleFacts, rulesFor } from "../src/agent-rules.ts";

const FRONT_DESK: AgentRuleFacts = {
  frontDesk: {
    phoneNumber: "(402) 555-0100",
    transferNames: ["Sam", "Pat"],
    canBook: true,
    canConfirm: true,
    canMove: true,
  },
};
const STORM: AgentRuleFacts = {
  stormScout: { thresholdInches: 1, budgetCents: 27000, days: 7 },
};

describe("storm_scout", () => {
  test("exact sentence and three links", () => {
    const rules = rulesFor("storm_scout", STORM);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.text).toBe(
      "When hail of 1 inch or more hits your service area, I draft a storm plan: texts, emails, door-knock routes and ads up to $270 over 7 days.",
    );
    expect(rules[0]!.links).toEqual([
      { label: "1 inch", href: "/settings/storm-scout" },
      { label: "$270", href: "/settings/storm-scout" },
      { label: "7 days", href: "/settings/storm-scout" },
    ]);
  });
  test("fractional threshold is plural", () => {
    const rules = rulesFor("storm_scout", {
      stormScout: { thresholdInches: 1.5, budgetCents: 27000, days: 7 },
    });
    expect(rules[0]!.text).toContain("hail of 1.5 inches or more");
  });
  test("one day is singular", () => {
    const rules = rulesFor("storm_scout", {
      stormScout: { thresholdInches: 1, budgetCents: 27000, days: 1 },
    });
    expect(rules[0]!.text).toContain("over 1 day.");
    expect(rules[0]!.links.map((l) => l.label)).toContain("1 day");
  });
  test("different facts produce different text", () => {
    const a = rulesFor("storm_scout", STORM)[0]!.text;
    const b = rulesFor("storm_scout", {
      stormScout: { thresholdInches: 2, budgetCents: 50000, days: 3 },
    })[0]!.text;
    expect(b).toContain("hail of 2 inches or more");
    expect(b).toContain("up to $500 over 3 days");
    expect(b).not.toBe(a);
  });
  test("no storm facts gives no sentences", () => {
    expect(rulesFor("storm_scout", {})).toEqual([]);
  });
});

describe("estimator", () => {
  test("one sentence with no links", () => {
    expect(rulesFor("estimator", {})).toEqual([
      {
        text: "When you type an address, I measure the roof and draft a three-option proposal. I order exact reports only when you approve.",
        links: [],
      },
    ]);
  });
});

describe("front_desk", () => {
  test("exact three sentences for the full facts", () => {
    const rules = rulesFor("front_desk", FRONT_DESK);
    expect(rules.map((r) => r.text)).toEqual([
      "I answer every call to (402) 555-0100.",
      "I can book, confirm and move inspections; I never give prices.",
      "I transfer urgent calls to Sam, then Pat.",
    ]);
    expect(rules[0]!.links).toEqual([
      { label: "(402) 555-0100", href: "/settings/front-desk" },
    ]);
    expect(rules[2]!.links).toEqual([
      { label: "Sam, then Pat", href: "/settings/front-desk" },
    ]);
  });
  test("book-only flags", () => {
    const rules = rulesFor("front_desk", {
      frontDesk: {
        phoneNumber: "(402) 555-0100",
        transferNames: [],
        canBook: true,
        canConfirm: false,
        canMove: false,
      },
    });
    expect(rules[1]!.text).toBe("I can book inspections; I never give prices.");
  });
  test("book and confirm", () => {
    const rules = rulesFor("front_desk", {
      frontDesk: {
        phoneNumber: "(402) 555-0100",
        transferNames: [],
        canBook: true,
        canConfirm: true,
        canMove: false,
      },
    });
    expect(rules[1]!.text).toBe(
      "I can book and confirm inspections; I never give prices.",
    );
  });
  test("no transfer names gives two sentences only", () => {
    const rules = rulesFor("front_desk", {
      frontDesk: {
        phoneNumber: "(402) 555-0100",
        transferNames: [],
        canBook: true,
        canConfirm: true,
        canMove: true,
      },
    });
    expect(rules).toHaveLength(2);
  });
  test("one transfer name and no abilities gives the messages sentence", () => {
    const rules = rulesFor("front_desk", {
      frontDesk: {
        phoneNumber: "(402) 555-0100",
        transferNames: ["Lee"],
        canBook: false,
        canConfirm: false,
        canMove: false,
      },
    });
    expect(rules.map((r) => r.text)).toEqual([
      "I answer every call to (402) 555-0100.",
      "I take messages for your team; I never give prices.",
      "I transfer urgent calls to Lee.",
    ]);
  });
  test("three transfer names", () => {
    const rules = rulesFor("front_desk", {
      frontDesk: {
        phoneNumber: "(402) 555-0100",
        transferNames: ["Sam", "Pat", "Lee"],
        canBook: false,
        canConfirm: false,
        canMove: false,
      },
    });
    expect(rules[2]!.text).toBe(
      "I transfer urgent calls to Sam, then Pat, then Lee.",
    );
  });
  test("no front desk facts gives no sentences", () => {
    expect(rulesFor("front_desk", {})).toEqual([]);
  });
});

const CLAIMS: AgentRuleFacts = { claims: { nudgeDays: [3, 5, 7] } };
const SCHEDULER: AgentRuleFacts = {
  scheduler: { reminderHour: 15, rainPct: 60, gustMph: 25 },
};
const FOLLOW_UP: AgentRuleFacts = {
  followUp: {
    proposalDays: [3, 4],
    leadDays: 2,
    reviewDelayDays: 3,
    reviewsOn: true,
  },
};

describe("claims", () => {
  test("default sentences and links", () => {
    const rules = rulesFor("claims", CLAIMS);
    expect(rules.map((r) => r.text)).toEqual([
      "I check claims every morning at 10 and draft check-in texts for you to approve: 3 days after the inspection if no claim is filed, 5 days after filing if no adjuster date, 7 days after the adjuster visit.",
      "I never contact insurers or adjusters, and I never talk about coverage or deductibles.",
    ]);
    expect(rules[0]!.links).toEqual([
      { label: "3 days", href: "/settings/agents" },
      { label: "5 days", href: "/settings/agents" },
      { label: "7 days", href: "/settings/agents" },
    ]);
    expect(rules[1]!.links).toEqual([]);
  });
  test("no facts gives no sentences", () => {
    expect(rulesFor("claims", {})).toEqual([]);
  });
});

describe("scheduler", () => {
  test("default sentences and links", () => {
    const rules = rulesFor("scheduler", SCHEDULER);
    expect(rules.map((r) => r.text)).toEqual([
      "At 3 PM I draft reminder texts for tomorrow's visits for you to approve.",
      "At 6 PM I email each crew member their visits for tomorrow.",
      "At 6 AM and 2 PM I check the weather for the next three days of installs and suggest moving any with rain of 60% or more or gusts of 25 mph or more. I never cancel.",
      "When a visit is marked no-show, I draft a text offering two new times.",
    ]);
    expect(rules[0]!.links).toEqual([{ label: "3 PM", href: "/settings/agents" }]);
    expect(rules[2]!.links).toEqual([
      { label: "60%", href: "/settings/agents" },
      { label: "25 mph", href: "/settings/agents" },
    ]);
  });
  test.each([
    [0, "12 AM"],
    [9, "9 AM"],
    [12, "12 PM"],
    [16, "4 PM"],
    [23, "11 PM"],
  ])("hour %i reads %s", (reminderHour, label) => {
    const rules = rulesFor("scheduler", {
      scheduler: { reminderHour, rainPct: 60, gustMph: 25 },
    });
    expect(rules[0]!.text).toBe(
      `At ${label} I draft reminder texts for tomorrow's visits for you to approve.`,
    );
    expect(rules[0]!.links).toEqual([{ label, href: "/settings/agents" }]);
  });
  test("no facts gives no sentences", () => {
    expect(rulesFor("scheduler", {})).toEqual([]);
  });
});

describe("follow_up", () => {
  test("default sentences with reviews on", () => {
    const rules = rulesFor("follow_up", FOLLOW_UP);
    expect(rules.map((r) => r.text)).toEqual([
      "After a proposal goes out, I draft a follow-up text for you to approve 3 days and 4 days later if there is no answer.",
      "I draft a follow-up text for a lead that has gone quiet for 2 days.",
      "When a job is stuck, I leave a next step for the rep and send no text.",
      "3 days after an install, I draft a review request, only to customers who agreed to marketing texts.",
      "At most one text per customer every 3 days, and none after they reply.",
    ]);
    expect(rules[0]!.links.map((l) => l.label)).toEqual(["3 days", "4 days"]);
    expect(rules[3]!.links).toEqual([{ label: "3 days", href: "/settings/agents" }]);
  });
  test("reviews off points at the review link", () => {
    const rules = rulesFor("follow_up", {
      followUp: { ...FOLLOW_UP.followUp!, reviewsOn: false },
    });
    expect(rules.map((r) => r.text)).toEqual([
      "After a proposal goes out, I draft a follow-up text for you to approve 3 days and 4 days later if there is no answer.",
      "I draft a follow-up text for a lead that has gone quiet for 2 days.",
      "When a job is stuck, I leave a next step for the rep and send no text.",
      "Reviews are off until you add your review link.",
      "At most one text per customer every 3 days, and none after they reply.",
    ]);
    expect(rules[3]!.links).toEqual([{ label: "review link", href: "/settings/agents" }]);
  });
  test("leads and proposals switched off leave their sentences out", () => {
    const rules = rulesFor("follow_up", {
      followUp: { ...FOLLOW_UP.followUp!, leadsOn: false, proposalsOn: false },
    });
    expect(rules.map((r) => r.text)).toEqual([
      "When a job is stuck, I leave a next step for the rep and send no text.",
      "3 days after an install, I draft a review request, only to customers who agreed to marketing texts.",
      "At most one text per customer every 3 days, and none after they reply.",
    ]);
  });
  test("one day reads singular", () => {
    const rules = rulesFor("follow_up", {
      followUp: { ...FOLLOW_UP.followUp!, leadDays: 1 },
    });
    expect(rules[1]!.text).toBe("I draft a follow-up text for a lead that has gone quiet for 1 day.");
  });
  test("no facts gives no sentences", () => {
    expect(rulesFor("follow_up", {})).toEqual([]);
  });
});

describe("agents without rules", () => {
  test.each<Agent>(["system"])(
    "%s has no rules",
    (agent) => {
      expect(rulesFor(agent, { ...STORM, ...FRONT_DESK })).toEqual([]);
    },
  );
});

describe("link integrity", () => {
  test("every link label is a substring of its sentence and points into settings", () => {
    const all: AgentRuleFacts = { ...STORM, ...FRONT_DESK, ...CLAIMS, ...SCHEDULER, ...FOLLOW_UP };
    for (const agent of AGENTS) {
      for (const rule of rulesFor(agent, all)) {
        for (const link of rule.links) {
          expect(rule.text).toContain(link.label);
          expect(link.href.startsWith("/settings/")).toBe(true);
        }
      }
    }
  });
});
