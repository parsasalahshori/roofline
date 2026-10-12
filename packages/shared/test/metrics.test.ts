import { describe, expect, test } from "vitest";
import { hoursLabel, moneyLabel, successRate } from "../src/metrics.ts";

describe("successRate", () => {
  test("null when ran is under 5", () => {
    expect(successRate({ done: 3, partlyDone: 0, ran: 4 })).toBeNull();
    expect(successRate({ done: 0, partlyDone: 0, ran: 0 })).toBeNull();
  });
  test("null when ran is not finite", () => {
    expect(successRate({ done: 0, partlyDone: 0, ran: Number.NaN })).toBeNull();
    expect(
      successRate({ done: 0, partlyDone: 0, ran: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
  test("all done at five runs is 1", () => {
    expect(successRate({ done: 5, partlyDone: 0, ran: 5 })).toBe(1);
  });
  test("partly done counts half", () => {
    expect(successRate({ done: 3, partlyDone: 2, ran: 5 })).toBeCloseTo(0.8);
  });
  test("nothing done is 0", () => {
    expect(successRate({ done: 0, partlyDone: 0, ran: 10 })).toBe(0);
  });
  test("mixed run", () => {
    expect(successRate({ done: 8, partlyDone: 1, ran: 10 })).toBeCloseTo(0.85);
  });
});

describe("hoursLabel", () => {
  test.each([
    [1860, "about 31 hours"],
    [270, "about 4.5 hours"],
    [60, "about 1 hour"],
    [30, "about 0.5 hours"],
    [120, "about 2 hours"],
    [600, "about 10 hours"],
    [570, "about 9.5 hours"],
    [589, "about 10 hours"],
    [0, "less than half an hour"],
    [90, "about 1.5 hours"],
    [14, "less than half an hour"],
    [15, "about 0.5 hours"],
    [44, "about 0.5 hours"],
    [60000, "about 1,000 hours"],
  ])("%d minutes -> %s", (minutes, expected) => {
    expect(hoursLabel(minutes)).toBe(expected);
  });
  test("negative and NaN minutes are treated as 0", () => {
    expect(hoursLabel(-120)).toBe("less than half an hour");
    expect(hoursLabel(Number.NaN)).toBe("less than half an hour");
  });
});

describe("moneyLabel", () => {
  test.each([
    [1860, 2800, "≈ $868"],
    [1900, 2800, "≈ $887"],
    [60, 2800, "≈ $28"],
    [0, 2800, "≈ $0"],
    [60000, 2800, "≈ $28,000"],
  ])("%d minutes at %d cents/hour -> %s", (minutes, rate, expected) => {
    expect(moneyLabel(minutes, rate)).toBe(expected);
  });
});
