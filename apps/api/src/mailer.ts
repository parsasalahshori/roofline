export type MailMessage = { to: string; subject: string; text: string };

/** Sends plain-text email. */
export type Mailer = { send(msg: MailMessage): Promise<void> };

const POSTMARK_URL = 'https://api.postmarkapp.com/email';
const POSTMARK_TIMEOUT_MS = 10_000;

/** The numeric `ErrorCode` of a Postmark error body, or null when the body has none. Nothing else is read. */
async function postmarkErrorCode(res: Response): Promise<number | null> {
  try {
    const body: unknown = JSON.parse(await res.text());
    const code = typeof body === 'object' && body !== null ? (body as { ErrorCode?: unknown }).ErrorCode : undefined;
    return typeof code === 'number' && Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

/** The real mailer: Postmark's single-message API. */
export class PostmarkMailer implements Mailer {
  private readonly token: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { token: string; from: string; fetch?: typeof fetch }) {
    this.token = opts.token;
    this.from = opts.from;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(msg: MailMessage): Promise<void> {
    const res = await this.fetchImpl(POSTMARK_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': this.token,
      },
      body: JSON.stringify({
        From: this.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        MessageStream: 'outbound',
      }),
      signal: AbortSignal.timeout(POSTMARK_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Only Postmark's numeric ErrorCode is kept: its Message echoes recipient addresses (406
      // inactive recipients, 300 invalid email), and this error is logged.
      const code = await postmarkErrorCode(res);
      throw new Error(`Postmark rejected the email (HTTP ${res.status}${code === null ? '' : `, ErrorCode ${code}`}).`);
    }
  }
}

/**
 * Stand-in when no POSTMARK_TOKEN is set (local development). It prints the message instead of
 * sending it. The body is left out in production, because it can carry sign-in and reset links.
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly includeBody: boolean) {}

  async send(msg: MailMessage): Promise<void> {
    const body = this.includeBody ? `\n${msg.text}` : '';
    console.log(`[mail not sent: no POSTMARK_TOKEN] to=${msg.to} subject=${JSON.stringify(msg.subject)}${body}`);
  }
}
