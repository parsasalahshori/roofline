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
    canCancel: false,
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
      { label: "1 inch", href: "/settings/storm" },
      { label: "$270", href: "/settings/storm" },
      { label: "7 days", href: "/settings/storm" },
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
        canCancel: false,
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
        canCancel: false,
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
        canCancel: false,
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
        canCancel: false,
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
        canCancel: false,
      },
    });
    expect(rules[2]!.text).toBe(
      "I transfer urgent calls to Sam, then Pat, then Lee.",
    );
  });
  test("canCancel adds the cancel sentence before the transfer sentence", () => {
    const rules = rulesFor("front_desk", {
      frontDesk: {
        phoneNumber: "(402) 555-0100",
        transferNames: ["Sam"],
        canBook: true,
        canConfirm: true,
        canMove: true,
        canCancel: true,
      },
    });
    expect(rules.map((r) => r.text)).toEqual([
      "I answer every call to (402) 555-0100.",
      "I can book, confirm and move inspections; I never give prices.",
      "I can cancel appointments when a customer asks.",
      "I transfer urgent calls to Sam.",
    ]);
  });
  test("no front desk facts gives no sentences", () => {
    expect(rulesFor("front_desk", {})).toEqual([]);
  });
});

describe("agents without rules", () => {
  test.each<Agent>(["claims", "scheduler", "follow_up", "system"])(
    "%s has no rules",
    (agent) => {
      expect(rulesFor(agent, { ...STORM, ...FRONT_DESK })).toEqual([]);
    },
  );
});

describe("link integrity", () => {
  test("every link label is a substring of its sentence and points into settings", () => {
    const all: AgentRuleFacts = { ...STORM, ...FRONT_DESK };
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

describe("rep variant (S-M5)", () => {
  test("rep variant has no budget clause", () => {
    const rules = rulesFor("storm_scout", {
      stormScout: { thresholdInches: 1, budgetCents: null, days: 7 },
    });
    expect(rules[0]!.text).toBe(
      "When hail of 1 inch or more hits your service area, I draft a storm plan: texts, emails, door-knock routes and ads over 7 days.",
    );
    expect(rules[0]!.text).not.toContain("$");
    expect(rules[0]!.text).not.toContain("up to");
    expect(rules[0]!.links.map((l) => l.label)).toEqual(["1 inch", "7 days"]);
  });
  test("noLinks gives links [] for every rule", () => {
    const facts = { ...STORM, ...FRONT_DESK, noLinks: true };
    for (const agent of ["storm_scout", "estimator", "front_desk"] as const) {
      const rules = rulesFor(agent, facts);
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.links.length === 0)).toBe(true);
    }
  });
});
