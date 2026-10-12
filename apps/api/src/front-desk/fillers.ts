import type { FrontDeskToolName } from '@roofline/shared';

/** Fixed filler per slow tool; never model-written. Every entry passes guardSentence unchanged. */
export const FILLERS: Readonly<Record<FrontDeskToolName, string | null>> = {
  find_inspection_times: 'Let me check the calendar.',
  book_inspection: 'One moment while I book that.',
  move_inspection: 'One moment while I move that.',
  cancel_inspection: 'One moment while I cancel that.',
  verify_caller: 'Let me look that up.',
  lookup_my_jobs: 'Let me pull that up.',
  check_forecast: 'Let me check the forecast.',
  hail_at_my_home: 'Let me check the hail records.',
  confirm_appointment: 'One moment while I confirm that.',
  take_claim_details: 'Let me write that down.',
  take_message: null,
  transfer_to_person: null,
  end_call: null,
};

/** The spoken filler for a slow tool, or null when the tool is fast. */
export function fillerFor(tool: FrontDeskToolName): string | null {
  return FILLERS[tool] ?? null;
}
