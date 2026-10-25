import { renderStageText, type OrderStage } from '@roofline/shared';

export type MessageValues = { first: string; date: string | null; company: string };

/**
 * Fills {first}, {date} and {company} in a stage message with the server's own code (renderStageText), so the preview
 * reads exactly like the text the customer gets, including its wording when no date is set yet.
 */
export function fillTemplate(text: string, values: MessageValues): string {
  return renderStageText(text, values);
}

/** The customer's first name from the name on the order. */
export function firstName(customerName: string): string {
  return customerName.trim().split(/\s+/)[0] ?? '';
}

/** Stages where the customer is told a date, so the move asks for one. */
export const STAGES_WITH_DATE: readonly OrderStage[] = ['shipped', 'install-scheduled'];
