// scratch: T3's AddOn type (from the T3 brief) so T4 compiles in parallel. T3 replaces this file.
import type { AddOnUnit } from './proposals.ts';
export type AddOn = { name: string; unit: AddOnUnit; rateCents: number; taxable: boolean };
