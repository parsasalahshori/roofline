/** One outbound text, as the send worker hands it to a provider. */
export type OutboundSms = { companyId: string; to: string; body: string };

/** What the provider tells us back: its id for the message and how many segments it billed. */
export type SmsSendResult = { providerSid: string; segments: number };

/** The seam to the SMS provider. The real one wraps Twilio; tests use `FakeSmsAdapter`. */
export type SmsAdapter = {
  send(m: OutboundSms): Promise<SmsSendResult>;
};

/**
 * Segments a body bills as: one up to 160 characters, then 153 per segment (the 7 characters the
 * concatenation header takes). This is the GSM-7 count. A body with emoji or other non-GSM
 * characters goes out as UCS-2, which is 70 / 67 per segment, so for those this under-counts; we
 * approximate rather than carry the GSM-7 table.
 */
export function countSegments(body: string): number {
  return body.length <= 160 ? 1 : Math.ceil(body.length / 153);
}

/** An in-memory provider: records what it was asked to send, and can be told to fail. */
export class FakeSmsAdapter implements SmsAdapter {
  /** Every text accepted, in order. A text that failed is not here. */
  readonly sent: OutboundSms[] = [];
  private failuresLeft = 0;
  private counter = 0;

  /** Makes the next `n` calls to `send` reject (replacing any failures still pending). */
  failNext(n: number): void {
    this.failuresLeft = Math.max(0, Math.floor(n));
  }

  async send(m: OutboundSms): Promise<SmsSendResult> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      // Customer data (the number, the body) must never end up in an error, so the message has none.
      throw new Error('Fake SMS provider: send failed (injected by failNext)');
    }
    this.sent.push({ companyId: m.companyId, to: m.to, body: m.body });
    this.counter += 1;
    return { providerSid: `SMFAKE${String(this.counter).padStart(6, '0')}`, segments: countSegments(m.body) };
  }
}
