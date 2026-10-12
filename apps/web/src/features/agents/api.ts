/**
 * Agents screen data layer. The hooks arrive in A1 tasks 9 to 12; they extend this module and use these keys.
 */
export const agentsKeys = {
  all: ['agents'] as const,
  feed: ['agents', 'feed'] as const,
  waiting: ['agents', 'waiting'] as const,
};
