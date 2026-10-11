/**
 * One outbound text, as the send worker hands it to a provider. `sender` is the Twilio account and
 * messaging service the text goes out from, when the text carries one.
 */
export type OutboundSms = { companyId: string; to: string; body: string; sender?: { accountSid: string; messagingServiceSid: string } | null };

/** What the provider tells us back: its id for the message and how many segments it billed. */
export type SmsSendResult = { providerSid: string; segments: number };

/**
 * The marker every refusal carries. It is registered with `Symbol.for`, so a refusal thrown by a second
 * copy of this package (a second install, a bundled copy) is still recognised by `isSmsRefusedError`.
 */
export const SMS_REFUSED: unique symbol = Symbol.for('roofline.sms.refused');

/**
 * The provider said no: the text definitely did not go out (a rejected request, an unsupported
 * number, no provider at all). Safe to try again, unless `permanent` says it never will go out.
 * Its message, and `reasonPlain`, must carry no phone number and no message body.
 *
 * - `permanent`: the carrier or provider will never take this text, so do not retry it.
 * - `optedOut`: the carrier says the person opted out of texts.
 * - `reasonPlain`: a plain-English sentence, safe to show the user, saying why the text was refused.
 */
export class SmsRefusedError extends Error {
  readonly [SMS_REFUSED] = true;
  readonly permanent: boolean;
  readonly optedOut: boolean;
  readonly reasonPlain: string | null;

  constructor(message: string, opts?: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string }) {
    super(message);
    this.name = 'SmsRefusedError';
    this.permanent = opts?.permanent ?? false;
    this.optedOut = opts?.optedOut ?? false;
    this.reasonPlain = opts?.reasonPlain ?? null;
  }
}

/**
 * True for a refusal: a `SmsRefusedError`, or one thrown by another copy of this package (which fails
 * `instanceof`, so it is matched by its name and the `SMS_REFUSED` marker). Anything else is false.
 */
export function isSmsRefusedError(err: unknown): err is SmsRefusedError {
  if (err instanceof SmsRefusedError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const look = err as { name?: unknown; [SMS_REFUSED]?: unknown };
  return look.name === 'SmsRefusedError' && look[SMS_REFUSED] === true;
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
  /** The message the pending refusals carry; each call that starts failures sets it. */
  private refusalMessage = 'Fake SMS provider: send refused (injected by failNext)';
  /** The options the pending refusals are built with. Only `refuseNext` sets them; every call that starts failures resets them. */
  private refusalOpts: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string } | undefined;
  private counter = 0;

  /** Makes the next `n` calls to `send` refuse (`SmsRefusedError`), replacing any failures still pending. */
  failNext(n: number): void {
    this.arm(n, 'refused', 'Fake SMS provider: send refused (injected by failNext)', undefined);
  }

  /**
   * Makes the next `n` calls to `send` fail with a plain error, as a timeout would (the outcome is
   * unknown), replacing any failures still pending. Nothing is recorded as sent.
   */
  failUnknownNext(n: number): void {
    this.arm(n, 'unknown', 'Fake SMS provider: no answer (injected by failUnknownNext)', undefined);
  }

  /**
   * Makes the next `n` calls to `send` refuse with an `SmsRefusedError` built with `opts`, replacing any
   * failures still pending. Nothing is recorded as sent. Without `opts` the refusal is retryable and has
   * no reason. The `opts` apply only to these `n` refusals.
   */
  refuseNext(n: number, opts?: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string }): void {
    this.arm(n, 'refused', 'Fake SMS provider: send refused (injected by refuseNext)', opts);
  }

  /** Starts `n` injected failures and replaces every piece of state the pending ones had. */
  private arm(
    n: number,
    kind: 'refused' | 'unknown',
    message: string,
    opts: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string } | undefined,
  ): void {
    this.failuresLeft = Math.max(0, Math.floor(n));
    this.failureKind = kind;
    this.refusalMessage = message;
    this.refusalOpts = opts;
  }

  async send(m: OutboundSms): Promise<SmsSendResult> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      // Customer data (the number, the body) must never end up in an error, so the message has none.
      if (this.failureKind === 'refused') throw new SmsRefusedError(this.refusalMessage, this.refusalOpts);
      throw new Error('Fake SMS provider: no answer (injected by failUnknownNext)');
    }
    const entry: OutboundSms = { companyId: m.companyId, to: m.to, body: m.body };
    // Only a text that carried a sender records one, so the recorded entry has no `sender` key otherwise.
    if (m.sender != null) entry.sender = { ...m.sender };
    this.sent.push(entry);
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
