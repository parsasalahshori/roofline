import type { Config } from '../config.ts';
import type { BroadcastMail, BroadcastMailer } from './broadcast.ts';

const POSTMARK_URL = 'https://api.postmarkapp.com/email';
const POSTMARK_TIMEOUT_MS = 10_000;

/**
 * The Postmark broadcast stream: one-click unsubscribe headers on every message, and Metadata.unsubscribe
 * carries the unsubscribe token so the complaint webhook can find the company and address.
 * Provider response text is never read into an error or a return value: status codes and our own messages only.
 */
export class PostmarkBroadcastMailer implements BroadcastMailer {
  readonly configured = true;
  private readonly token: string;
  private readonly stream: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { token: string; stream: string; fetch?: typeof fetch }) {
    this.token = opts.token;
    this.stream = opts.stream;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(m: BroadcastMail): Promise<{ messageId: string }> {
    const payload: Record<string, unknown> = {
      From: m.from,
      To: m.to,
      Subject: m.subject,
      TextBody: m.text,
      HtmlBody: m.html,
      MessageStream: this.stream,
      Tag: m.tag,
      TrackOpens: false,
      Headers: [
        { Name: 'List-Unsubscribe', Value: `<${m.unsubscribeUrl}>` },
        { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
      ],
    };
    if (m.replyTo !== null) payload['ReplyTo'] = m.replyTo;
    const token = unsubscribeTokenFrom(m.unsubscribeUrl);
    if (token !== null) payload['Metadata'] = { unsubscribe: token };

    let res: Response;
    try {
      res = await this.fetchImpl(POSTMARK_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(POSTMARK_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Postmark broadcast send could not reach Postmark.');
    }
    if (!res.ok) {
      throw new Error(`Postmark broadcast send failed (${res.status}).`);
    }
    const messageId = await readMessageId(res);
    if (messageId === null) {
      throw new Error('Postmark broadcast send returned no message id.');
    }
    return { messageId };
  }
}

/** The last path segment of the unsubscribe URL (the token), or null when the URL cannot be parsed. */
function unsubscribeTokenFrom(unsubscribeUrl: string): string | null {
  try {
    const token = new URL(unsubscribeUrl).pathname.split('/').pop();
    return token ? token : null;
  } catch {
    return null;
  }
}

async function readMessageId(res: Response): Promise<string | null> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !('MessageID' in json)) return null;
  const id = json.MessageID;
  return typeof id === 'string' ? id : null;
}

/** The real Postmark broadcast mailer when configured; null when POSTMARK_TOKEN is not set. */
export function postmarkBroadcastFor(config: Config): BroadcastMailer | null {
  if (!config.POSTMARK_TOKEN) return null;
  return new PostmarkBroadcastMailer({ token: config.POSTMARK_TOKEN, stream: config.POSTMARK_BROADCAST_STREAM });
}
