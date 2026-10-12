import type { BroadcastMail, BroadcastMailer } from '../broadcast.ts';

/** Records mail instead of sending it. */
export class FakeBroadcastMailer implements BroadcastMailer {
  readonly configured = true;
  readonly sent: BroadcastMail[] = [];
  readonly calls: { method: string; args: unknown[] }[] = [];
  private failures = 0;
  private n = 0;

  failNext(): void {
    this.failures++;
  }
  async send(m: BroadcastMail): Promise<{ messageId: string }> {
    this.calls.push({ method: 'send', args: [m] });
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Fake broadcast mailer is unavailable.');
    }
    this.sent.push({ ...m });
    return { messageId: `bm-${++this.n}` };
  }
}
