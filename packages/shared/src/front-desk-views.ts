/** Ruling DR: the forwarding test as the API returns it (POST /api/front-desk/forwarding-test -> { id }; GET .../:id -> this). */
export const FORWARDING_TEST_STATUSES = ['pending', 'verified', 'not_received', 'failed'] as const;
export type ForwardingTestStatus = (typeof FORWARDING_TEST_STATUSES)[number];

export type ForwardingTestView = {
  id: string;
  status: ForwardingTestStatus;
  /** Plain-words cause for not_received/failed; null otherwise. */
  message: string | null;
};
