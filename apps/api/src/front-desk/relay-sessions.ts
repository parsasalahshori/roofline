/** The registry of live relay sessions, for the global call cap and the health flag. Tasks 11 and 13 extend it. */
export class RelaySessions {
  private readonly live = new Set<string>();
  /** Set by the fd-health schedule (Task 6): false when the LLM looked unavailable. */
  llmHealthy = true;
  get size(): number { return this.live.size; }
  add(callSid: string): void { this.live.add(callSid); }
  remove(callSid: string): void { this.live.delete(callSid); }
  has(callSid: string): boolean { return this.live.has(callSid); }
}
