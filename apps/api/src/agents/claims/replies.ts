import type { AppDeps } from '../../app.ts';

export type ClaimsReplyMessage = {
  companyId: string;
  customerId: string;
  messageId: string;
  body: string;
  receivedAt: Date;
};

/** Task 8 fills this in (and calls D1's queueFrontDeskText itself when it consumes a reply). */
export async function onClaimsReply(deps: AppDeps, msg: ClaimsReplyMessage): Promise<{ consumed: boolean }> {
  // G1 Task 8 fills this in
  void deps;
  void msg;
  return { consumed: false };
}
