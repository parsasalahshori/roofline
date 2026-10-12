export const BOARD_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];
