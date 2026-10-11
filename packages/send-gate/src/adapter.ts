/** One outbound text, as the send worker hands it to a provider. */
export type OutboundSms = { companyId: string; to: string; body: string };

/** What the provider tells us back: its id for the message and how many segments it billed. */
export type SmsSendResult = { providerSid: string; segments: number };

/**
 * The provider said no: the text definitely did not go out (a rejected request, an unsupported
 * number, no provider at all). Safe to try again. Its message must carry no customer data.
 */
export class SmsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsRefusedError';
  }
}

/**
 * The seam to the SMS provider. The real one wraps Twilio; tests use `FakeSmsAdapter`.
 *
 * `send` resolves once the provider has taken the text. It rejects with `SmsRefusedError` only when
 * the text definitely did not go out. Any other rejection (a timeout, a dropped connection, a reply
 * that could not be read) means the outcome is unknown: the provider may have sent it, so callers
 * must never send that text again by themselves. Errors carry no number and no body.
 */
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
  private failureKind: 'refused' | 'unknown' = 'refused';
  private counter = 0;

  /** Makes the next `n` calls to `send` refuse (`SmsRefusedError`), replacing any failures still pending. */
  failNext(n: number): void {
    this.failuresLeft = Math.max(0, Math.floor(n));
    this.failureKind = 'refused';
  }

  /**
   * Makes the next `n` calls to `send` fail with a plain error, as a timeout would (the outcome is
   * unknown), replacing any failures still pending. Nothing is recorded as sent.
   */
  failUnknownNext(n: number): void {
    this.failuresLeft = Math.max(0, Math.floor(n));
    this.failureKind = 'unknown';
  }

  async send(m: OutboundSms): Promise<SmsSendResult> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      // Customer data (the number, the body) must never end up in an error, so the message has none.
      if (this.failureKind === 'refused') throw new SmsRefusedError('Fake SMS provider: send refused (injected by failNext)');
      throw new Error('Fake SMS provider: no answer (injected by failUnknownNext)');
    }
    this.sent.push({ companyId: m.companyId, to: m.to, body: m.body });
    this.counter += 1;
    return { providerSid: `SMFAKE${String(this.counter).padStart(6, '0')}`, segments: countSegments(m.body) };
  }
}

/**
 * The provider until a real one is set up (F3 adds Twilio): every send is refused
 * (`SmsRefusedError`, so nothing went out) with a plain sentence. The server and the worker use it.
 * A company only gets as far as a send once the carriers approved its registration (the send
 * gate's registration rule), so in practice nothing reaches it; if something does, the text is
 * marked as not taken, never as sent, and can be retried once texting is set up.
 */
export class DisabledSmsAdapter implements SmsAdapter {
  async send(): Promise<SmsSendResult> {
    throw new SmsRefusedError("Texting isn't set up yet.");
  }
}
