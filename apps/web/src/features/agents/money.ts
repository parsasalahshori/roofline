import { moneyLabel } from '@roofline/shared';
import { agentsCommon } from '../../copy/agents.ts';

/** Cents as a rate: "$28" for whole dollars, else "$28.50". The one cents formatter for the Agents screens. */
export function rateLabel(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** "≈ $870 of staff time at $28/hour" (no "(estimate)": the caller adds agentsCommon.estimate). */
export function moneyLineText(minutes: number, hourlyRateCents: number): string {
  return `${moneyLabel(minutes, hourlyRateCents)} ${agentsCommon.staffTime} ${rateLabel(hourlyRateCents)}${agentsCommon.perHour}`;
}
