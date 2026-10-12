export type ScreenInput = { from: string; stirVerstat: string | null; blocked: boolean; callsLastHour: number; knownCustomer: boolean };
/** The screening rules arrive in Task 15; this stub allows every call. */
export function screenCall(i: ScreenInput): { action: 'allow' | 'reject'; reason: string | null } {
  void i;
  return { action: 'allow', reason: null };
}
