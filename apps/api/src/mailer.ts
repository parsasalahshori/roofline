export type MailMessage = { to: string; subject: string; text: string };

/** Sends plain-text email. */
export type Mailer = { send(msg: MailMessage): Promise<void> };

const POSTMARK_URL = 'https://api.postmarkapp.com/email';
const POSTMARK_TIMEOUT_MS = 10_000;

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
      // Postmark's error body ({ErrorCode, Message}) is safe to log; the token is never in it.
      const detail = await res.text().catch(() => '');
      throw new Error(`Postmark rejected the email (HTTP ${res.status}): ${detail.slice(0, 500)}`);
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
