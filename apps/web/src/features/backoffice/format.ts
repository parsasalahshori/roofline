import type { OrderStage } from '@roofline/shared';
import { backoffice } from '../../copy/backoffice.ts';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const dollarsAndCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayAndTime = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Whole dollars from cents: 123456 is $1,235. */
export const formatDollars = (cents: number): string => dollars.format(cents / 100);

/** Dollars and cents: 123456 is $1,234.56. */
export const formatExact = (cents: number): string => dollarsAndCents.format(cents / 100);

/** A calendar day (YYYY-MM-DD) as "Nov 3". */
export function formatDay(value: string): string {
  const instant = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(instant) ? value : day.format(new Date(instant));
}

/** A moment as "Oct 24, 3:05 PM" in the viewer's time zone. */
export function formatMoment(iso: string): string {
  const instant = Date.parse(iso);
  return Number.isNaN(instant) ? iso : dayAndTime.format(new Date(instant));
}

export const stageName = (stage: OrderStage): string => backoffice.stages[stage];

/** Dollars typed as text -> cents; NaN when it is not a number. "12.5" is 1250. */
export function dollarsToCents(text: string): number {
  const clean = text.replace(/[$,\s]/g, '');
  if (clean === '' || !/^-?\d*\.?\d*$/.test(clean) || clean === '.' || clean === '-') return Number.NaN;
  return Math.round(Number(clean) * 100);
}

/** Cents as the text in a dollars box: 123450 is "1234.50", 1200 is "12". */
export function centsToDollars(cents: number): string {
  if (!Number.isFinite(cents)) return '';
  const value = cents / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
