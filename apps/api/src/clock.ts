/** Where the app gets the current time. Tests swap in a clock they control. */
export type Clock = { now(): Date };

export const systemClock: Clock = {
  now: () => new Date(),
};
