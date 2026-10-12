const FAILURES_TO_TRIP = 3;
const UNHEALTHY_MS = 60_000;

/**
 * The registry of live relay sessions, for the global call cap, plus the LLM circuit breaker
 * (Ruling DQ): three consecutive model failures mark the LLM unhealthy for 60 seconds.
 * Tasks 11 and 13 extend it.
 */
export class RelaySessions {
  private readonly live = new Set<string>();
  private consecutiveFailures = 0;
  private unhealthyUntil = 0;

  get size(): number { return this.live.size; }
  add(callSid: string): void { this.live.add(callSid); }
  remove(callSid: string): void { this.live.delete(callSid); }
  has(callSid: string): boolean { return this.live.has(callSid); }

  recordLlmSuccess(now: Date): void {
    void now;
    this.consecutiveFailures = 0;
  }

  recordLlmFailure(now: Date): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURES_TO_TRIP) this.unhealthyUntil = now.getTime() + UNHEALTHY_MS;
  }

  /** True when the window has passed; once it has, the failure count starts over. */
  isLlmHealthy(now: Date): boolean {
    if (this.unhealthyUntil === 0) return true;
    if (now.getTime() >= this.unhealthyUntil) {
      this.unhealthyUntil = 0;
      this.consecutiveFailures = 0;
      return true;
    }
    return false;
  }

  /** Back-compat for readers that only want the flag now. */
  get llmHealthy(): boolean { return this.isLlmHealthy(new Date()); }
}
