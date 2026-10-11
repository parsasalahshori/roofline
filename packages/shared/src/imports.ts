import type { ConsentStatus, JobStage } from './enums.ts';

export const IMPORT_STATUSES = ['uploaded', 'queued', 'processing', 'done', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const IMPORT_ROW_OUTCOMES = ['created', 'updated', 'skipped'] as const;
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number];

export const IMPORT_FIELDS = ['name', 'firstName', 'lastName', 'phone', 'phone2', 'email', 'street', 'city', 'state', 'zip', 'notes', 'stage'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportMapping = Partial<Record<ImportField, number>>; // column index

export const SKIP_KEYS = ['noName', 'noContact', 'badPhone', 'duplicate'] as const;
export type SkipKey = (typeof SKIP_KEYS)[number];

export type ImportCounts = {
  total: number;
  new: number;
  updated: number;
  skipped: number;
  skippedBy: Record<SkipKey, number>;
  consent: { attested: number; express: number; unchanged: number; optedOutKept: number };
  jobs: number;
  processed: number;
  located: number;
  notLocated: number;
};

export type ImportPreviewRow = {
  row: number;
  outcome: 'create' | 'update' | 'skip';
  reason: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  stage: JobStage | null;
  consent: ConsentStatus | null;
};

export type ImportView = {
  id: string;
  fileName: string;
  status: ImportStatus;
  headers: string[];
  mapping: ImportMapping;
  rowCount: number;
  counts: ImportCounts;
  preview: ImportPreviewRow[];
  progress: { processed: number; total: number };
  consentAttested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  errorPlain: string | null;
  skippedDownloadUrl: string | null;
};

export const MAX_IMPORT_ROWS = 20_000;
