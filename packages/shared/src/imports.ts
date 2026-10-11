export const IMPORT_STATUSES = ['uploaded', 'queued', 'processing', 'done', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const IMPORT_ROW_OUTCOMES = ['created', 'updated', 'skipped'] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];
