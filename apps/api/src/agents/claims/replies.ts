import type { Tx } from '@roofline/db';
import type { AppDeps } from '../../app.ts';

export type ClaimsReplyMessage = {
  companyId: string;
  customerId: string;
  messageId: string;
  body: string;
  receivedAt: Date;
};

/**
 * The Claims agent's look at an inbound text from a known customer (Ruling GX-A), inside the hook's
 * tenant transaction, after the message row is written. Task 8 fills this in: when the customer had a
 * claims text in the last 7 days it sends a job that does the Haiku extraction and claim update (never
 * inline: the webhook must stay fast) and calls D1's queueFrontDeskText itself if a reply is needed.
 * It must not throw for ordinary input: a throw rolls the message back and Twilio retries.
 */
export async function onClaimsReply(tx: Tx, deps: AppDeps, msg: ClaimsReplyMessage): Promise<{ consumed: boolean }> {
  // G1 Task 8 fills this in
  void tx;
  void deps;
  void msg;
  return { consumed: false };
}
