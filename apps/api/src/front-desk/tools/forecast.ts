import { companyLocation, propertiesForCustomer, withTenant } from '@roofline/db';
import type { DailyForecast } from '../../weather/source.ts';
import type { ToolHandler } from '../engine-types.ts';
import { systemCtx } from './system-ctx.ts';

/*
 * D1 Task 7: check_forecast. The place is the caller's own property (shown to the model and owned by the
 * matched customer) or else the company's location. The model never picks a company or customer.
 */

const CANT_REACH = "I can't reach the forecast right now.";
const FORECAST_DAYS = 7;

/** `2026-10-15` as `Thursday Oct 15`; the date has no zone, so it is read as UTC both ways. */
function dayWords(isoDate: string): string {
  const at = new Date(`${isoDate}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(at);
  const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(at);
  return `${weekday} ${monthDay}`;
}

export const checkForecast: ToolHandler<'check_forecast'> = async (ctx, input) => {
  const { companyId, conversation } = ctx;
  const sys = systemCtx(companyId);

  let place: { lat: number; lng: number } | null;
  if (input.propertyId !== null) {
    if (!conversation.shownIds.has(input.propertyId) || conversation.customerId === null) {
      return { ok: false, forModel: "I can't use that property for a forecast." };
    }
    const customerId = conversation.customerId;
    const props = await withTenant(ctx.deps.pools, sys, (tx) => propertiesForCustomer(tx, sys, customerId));
    const prop = props.find((p) => p.id === input.propertyId);
    if (!prop) return { ok: false, forModel: "I can't use that property for a forecast." };
    place = prop.lat !== null && prop.lng !== null ? { lat: prop.lat, lng: prop.lng } : null;
  } else {
    place = await withTenant(ctx.deps.pools, sys, (tx) => companyLocation(tx, sys));
  }
  if (!place) return { ok: false, forModel: CANT_REACH };

  let days: DailyForecast[] | null;
  try {
    days = await ctx.deps.weather.daily(place.lat, place.lng, FORECAST_DAYS);
  } catch {
    days = null;
  }
  const day = days?.find((d) => d.date === input.date);
  if (!day) return { ok: false, forModel: CANT_REACH };

  const parts = [day.summary.toLowerCase()];
  if (day.highF !== null) parts.push(`high ${day.highF}`);
  if (day.lowF !== null) parts.push(`low ${day.lowF}`);
  if (day.precipChancePercent !== null) parts.push(`${day.precipChancePercent} percent chance of rain`);
  return { ok: true, forModel: `Forecast for ${dayWords(day.date)}: ${parts.filter((p) => p !== '').join(', ')}.` };
};
