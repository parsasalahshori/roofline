import type { PublicProposalView } from '@roofline/shared';
import { homeowner, money } from '../../copy/homeowner.ts';
import type { RoofFacts } from './types.ts';

type Option = PublicProposalView['options'][number];

const positive = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** 875 basis points become "8.75"; a whole rate drops its zeros, so 900 becomes "9". */
export const formatApr = (aprBps: number): string => (aprBps / 100).toFixed(2).replace(/\.?0+$/, '');

/** The option the page opens on: the one most people pick (Better), else the middle one. */
export function defaultOption(options: readonly Option[]): Option | undefined {
  return options.find((option) => option.tier === 'better') ?? options[Math.floor(options.length / 2)];
}

/** What a homeowner is told about paying monthly: only what the option carries, and the total of the payments is monthly times the number of them. */
export type Financing = { monthly: string; apr: string; months: number; total: string };

export function financingOf(option: Option): Financing | null {
  const { monthlyEstimateCents: monthly, financingTerms: terms } = option;
  if (!positive(monthly) || terms === null || !Number.isInteger(terms.months) || terms.months < 1 || !Number.isFinite(terms.aprBps) || terms.aprBps < 0) return null;
  return { monthly: money(monthly), apr: formatApr(terms.aprBps), months: terms.months, total: money(monthly * terms.months) };
}

/** The roof card's figures, each only when the company has the fact; null when it has none of them (the card is then not shown). */
export type RoofCard = { stats: { key: 'roof' | 'pitch' | 'hail'; label: string; value: string }[]; photos: string | null };

export function roofCard(roof: RoofFacts | null | undefined): RoofCard | null {
  if (!roof) return null;
  const stats: RoofCard['stats'] = [];
  if (positive(roof.squares)) stats.push({ key: 'roof', label: homeowner.roofLabel, value: homeowner.squares(roof.squares) });
  if (positive(roof.pitchX12)) stats.push({ key: 'pitch', label: homeowner.pitchLabel, value: homeowner.pitch(roof.pitchX12) });
  if (positive(roof.hailInches)) stats.push({ key: 'hail', label: homeowner.hailLabel, value: homeowner.hail(roof.hailInches) });
  const photos = positive(roof.photoCount) && Number.isInteger(roof.photoCount) ? homeowner.photos(roof.photoCount) : null;
  return stats.length === 0 && photos === null ? null : { stats, photos };
}

/** The date part of a date-only (or ISO) value, the way a homeowner reads it: "Nov 11", with the year only when it is not this one. UTC keeps a bare date from sliding back a day. */
export function plainDate(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const sameYear = date.getUTCFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}
