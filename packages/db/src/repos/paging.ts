export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** A page request made safe: `limit` between 1 and 200 (default 50), `offset` 0 or more. */
export function clampPage(options: { limit?: number; offset?: number }): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE),
    offset: Math.max(0, Math.trunc(options.offset ?? 0)),
  };
}
