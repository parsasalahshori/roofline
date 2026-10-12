export type BroadcastMail = { to: string; from: string; replyTo: string | null; subject: string; text: string; html: string; unsubscribeUrl: string; tag: string };
/** Sends over the broadcast stream with List-Unsubscribe and List-Unsubscribe-Post headers. */
export interface BroadcastMailer { readonly configured: boolean; send(m: BroadcastMail): Promise<{ messageId: string }> }
