import type { OrderStage } from '@roofline/shared';

export type MessageValues = { first: string; date: string; company: string };

/** Fills {first}, {date} and {company} in a stage message. Anything else in braces is left as written. */
export function fillTemplate(text: string, values: MessageValues): string {
  return text.replace(/\{(first|date|company)\}/g, (_match, name: keyof MessageValues) => values[name]);
}

/** The customer's first name from the name on the order. */
export function firstName(customerName: string): string {
  return customerName.trim().split(/\s+/)[0] ?? '';
}

/** Stages where the customer is told a date, so the move asks for one. */
export const STAGES_WITH_DATE: readonly OrderStage[] = ['shipped', 'install-scheduled'];
