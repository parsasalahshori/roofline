import {
  schedulerAgentOn,
  schedulerCompany,
  userBusyIntervals,
  weatherInstallCandidates,
  weatherSettings,
  weatherTaskOpen,
  withTenant,
  zoneDayAfter,
  zoneDayStart,
  type TenantContext,
  type WeatherInstall,
} from '@roofline/db';
import { claimsGuard, guardSentence, weatherRisk, workIntervals, type HourlyForecast, type WorkHours } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import type { JobMeta } from '../../jobs/queue.ts';
import { LlmUnavailableError, MAX_DRAFT_JOBS, type JobFacts } from '../../providers/llm.ts';
import { createTask } from '../../tasks/service.ts';
import { localParts } from '../schedule.ts';

const MAX_BODY = 300;
/** Matches the send_personal_texts payload max in packages/shared/src/steps.ts. */
const MAX_TEXTS_PER_STEP = 100;
const HOUR_MS = 3_600_000;
const SIX_HOURS_MS = 6 * HOUR_MS;
const MOVE_DAYS = 14;
const FORECAST_HOURS = 168;
const MAX_REASON = 200;

type Reason = 'rain' | 'wind';
type Moved = {
  install: WeatherInstall;
  reasons: Reason[];
  oldDate: string;
  newDate: string;
  start: Date;
  end: Date;
  reason: string;
};

function bodyOk(body: string): boolean {
  if (body.trim() === '' || body.length > MAX_BODY) return false;
  if (!claimsGuard(body).ok) return false;
  return body.split(/(?<=[.!?])\s+/).every((s) => guardSentence(s, { repName: null }).hits.length === 0);
}

/** Whole calendar days from `a` to `b` (YYYY-MM-DD). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function weekdayName(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`));
}

/** 'Thursday', or 'Thursday, Oct 15' when the day is more than 6 days after `today`. */
function dayLabel(date: string, today: string): string {
  if (daysBetween(today, date) <= 6) return weekdayName(date);
  const md = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
  return `${weekdayName(date)}, ${md}`;
}

function hourLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: true }).format(instant);
}

/** The fixed text used when the model's text is missing or fails a guard. */
export function weatherTemplate(first: string, companyName: string, reasons: readonly Reason[], oldDay: string, newDay: string): string {
  const what = reasons.length === 1 && reasons[0] === 'wind' ? 'Wind is forecast' : 'Rain is forecast';
  return `Hi ${first}, it's ${companyName}. ${what} on ${oldDay}, so we'd like to move your roof install to ${newDay}. Reply here or call us if that doesn't work.`;
}

function titleFor(moved: Moved[]): string {
  const n = moved.length;
  const noun = `move ${n} install${n === 1 ? '' : 's'}?`;
  const dates = new Set(moved.map((m) => m.oldDate));
  if (dates.size > 1) return `Bad weather this week — ${noun}`;
  const all = new Set(moved.flatMap((m) => m.reasons));
  const what = all.has('rain') && all.has('wind') ? 'Rain and wind' : all.has('wind') ? 'Wind' : 'Rain';
  return `${what} on ${weekdayName(moved[0]!.oldDate)} — ${noun}`;
}

/**
 * Looks at the next three local days of installs, and asks to move the ones the forecast says are
 * too wet or windy to the next clear day the installer is free. One approval task per run window;
 * customers are texted only after approval (the texts step follows every move).
 */
export async function runWeatherWatch(deps: AppDeps, companyId: string, meta: JobMeta): Promise<void> {
  void meta;
  const ctx: TenantContext = { companyId, userId: null, role: 'system', canApproveSpend: false };
  const now = deps.clock.now();
  const since = new Date(now.getTime() - SIX_HOURS_MS);

  const plan = await withTenant(deps.pools, ctx, async (tx) => {
    const company = await schedulerCompany(tx, ctx);
    if (!company || (company.status !== 'active' && company.status !== 'trial')) return null;
    if (!(await schedulerAgentOn(tx, ctx))) return null;
    if (await weatherTaskOpen(tx, ctx, since)) return null;

    const tz = company.timezone;
    const today = localParts(now, tz).localDate;
    // The next three local days: today, tomorrow and the day after, ending at the start of today+3.
    const to = zoneDayStart(zoneDayAfter(zoneDayAfter(zoneDayAfter(today))), tz);
    const candidates = await weatherInstallCandidates(tx, ctx, { from: now, to });
    if (candidates.length === 0) return null;
    const settings = await weatherSettings(tx, ctx);
    return { company, tz, today, candidates, settings };
  });
  if (!plan) return;
  const { company, tz, today, candidates, settings } = plan;
  const workHours: WorkHours = settings.workHours;
  const thresholds = { rainPct: settings.rainPct, gustMph: settings.gustMph };

  // One forecast per rounded place; a missing forecast is never guessed.
  const forecasts = new Map<string, Map<string, HourlyForecast[]> | null>();
  const forecastFor = async (lat: number, lng: number): Promise<Map<string, HourlyForecast[]> | null> => {
    const rl = Math.round(lat * 100) / 100;
    const rg = Math.round(lng * 100) / 100;
    const key = `${rl},${rg}`;
    if (forecasts.has(key)) return forecasts.get(key)!;
    const points: HourlyForecast[] | null = await deps.weather.hourly(rl, rg, FORECAST_HOURS).catch(() => null);
    let byDay: Map<string, HourlyForecast[]> | null = null;
    if (points !== null && points.length > 0) {
      byDay = new Map();
      for (const p of points) {
        const at = new Date(p.at);
        if (!Number.isFinite(at.getTime())) continue;
        const d = localParts(at, tz).localDate;
        const list = byDay.get(d);
        if (list) list.push(p);
        else byDay.set(d, [p]);
      }
    }
    forecasts.set(key, byDay);
    return byDay;
  };

  const risky: { install: WeatherInstall; oldDate: string; byDay: Map<string, HourlyForecast[]>; reasons: Reason[]; reason: string }[] = [];
  for (const install of candidates) {
    const byDay = await forecastFor(install.lat, install.lng);
    if (byDay === null) continue;
    const oldDate = localParts(install.startsAt, tz).localDate;
    const points = byDay.get(oldDate);
    if (!points) continue;
    const risk = weatherRisk(points, workHours, thresholds, tz);
    if (!risk.risky) continue;
    const name = weekdayName(oldDate);
    const parts: string[] = [];
    if (risk.reasons.includes('rain')) {
      const work = workIntervals(workHours, zoneDayStart(oldDate, tz), zoneDayStart(zoneDayAfter(oldDate), tz), tz);
      const wet = points
        .filter((p) => p.precipPct >= thresholds.rainPct)
        .map((p) => ({ s: Date.parse(p.at), e: Date.parse(p.at) + HOUR_MS }))
        .filter((h) => work.some((w) => w.start.getTime() < h.e && h.s < w.end.getTime()));
      const from = Math.min(...wet.map((h) => h.s));
      const upto = Math.max(...wet.map((h) => h.e));
      parts.push(`${risk.worstPrecipPct}% rain ${hourLabel(new Date(from), tz)}–${hourLabel(new Date(upto), tz)} ${name}`);
    }
    if (risk.reasons.includes('wind')) parts.push(`Gusts to ${risk.worstGustMph} mph ${name}`);
    risky.push({ install, oldDate, byDay, reasons: risk.reasons, reason: parts.join('; ') });
  }
  if (risky.length === 0) return;

  // Find the next clear day the installer is free.
  let noClear = 0;
  const moved: Moved[] = [];
  const claimed = new Set<string>();
  await withTenant(deps.pools, ctx, async (tx) => {
    for (const r of risky) {
      const { install, oldDate, byDay } = r;
      let date = oldDate;
      let found = false;
      for (let i = 0; i < MOVE_DAYS && !found; i++) {
        date = zoneDayAfter(date);
        const dayStart = zoneDayStart(date, tz);
        const nextStart = zoneDayStart(zoneDayAfter(date), tz);
        if (workIntervals(workHours, dayStart, nextStart, tz).length === 0) continue;
        const dayPoints = byDay.get(date);
        if (dayPoints && dayPoints.length > 0 && weatherRisk(dayPoints, workHours, thresholds, tz).risky) continue;
        if (claimed.has(`${install.assignedUserId}|${date}`)) continue;
        const busy = await userBusyIntervals(tx, ctx, { userId: install.assignedUserId, from: dayStart, to: nextStart, excludeAppointmentId: install.appointmentId });
        if (busy.length > 0) continue;

        let start = dayStart;
        let end = nextStart;
        if (!install.allDay) {
          const offset = install.startsAt.getTime() - zoneDayStart(oldDate, tz).getTime();
          start = new Date(dayStart.getTime() + offset);
          end = new Date(start.getTime() + (install.endsAt.getTime() - install.startsAt.getTime()));
        }
        let reason = r.reason;
        if (!dayPoints || dayPoints.length === 0) reason = `${reason}. No forecast yet for ${weekdayName(date)}`;
        claimed.add(`${install.assignedUserId}|${date}`);
        moved.push({ install, reasons: r.reasons, oldDate, newDate: date, start, end, reason: reason.slice(0, MAX_REASON) });
        found = true;
      }
      if (!found) noClear++;
    }
  });
  if (moved.length === 0) return;

  // One text per customer, written outside any transaction.
  const keyOf = (i: WeatherInstall): string => i.jobId ?? i.appointmentId;
  const textFor = new Map<string, Moved>();
  for (const m of moved) {
    if (m.install.textable && m.install.customerId !== null && !textFor.has(m.install.customerId)) textFor.set(m.install.customerId, m);
  }
  const targets = [...textFor.values()];
  const facts: JobFacts[] = targets.map((m) => ({
    jobId: keyOf(m.install),
    customerFirstName: m.install.customerFirstName,
    companyName: company.name,
    repFirstName: null,
    address: null,
    facts: { oldDay: dayLabel(m.oldDate, today), newDay: dayLabel(m.newDate, today) },
  }));
  const drafted = new Map<string, string>();
  for (let i = 0; i < facts.length; i += MAX_DRAFT_JOBS) {
    try {
      const res = await deps.llm.draftTexts({ instruction: 'weather_move', facts: facts.slice(i, i + MAX_DRAFT_JOBS) });
      if (!res.refused) for (const t of res.texts) if (!drafted.has(t.jobId)) drafted.set(t.jobId, t.body);
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
    }
  }
  const messages = targets.map((m) => {
    const text = drafted.get(keyOf(m.install));
    const body =
      text !== undefined && bodyOk(text)
        ? text
        : weatherTemplate(m.install.customerFirstName, company.name, m.reasons, dayLabel(m.oldDate, today), dayLabel(m.newDate, today));
    return { customerId: m.install.customerId!, jobId: m.install.jobId, body };
  });

  const { localDate, hour } = localParts(now, tz);
  const textSteps = Array.from({ length: Math.ceil(messages.length / MAX_TEXTS_PER_STEP) }, (_, n) => ({
    type: 'send_personal_texts' as const,
    payload: {
      purpose: 'informational',
      kind: 'reminder',
      messages: messages.slice(n * MAX_TEXTS_PER_STEP, (n + 1) * MAX_TEXTS_PER_STEP),
      dedupePrefix: `weather:${localDate}:${hour}`,
    },
  }));
  const moveSteps = moved.map((m) => ({
    type: 'move_appointment' as const,
    payload: {
      appointmentId: m.install.appointmentId,
      start: m.start.toISOString(),
      end: m.end.toISOString(),
      userId: m.install.assignedUserId,
      reason: m.reason,
    },
  }));
  const summary =
    noClear > 0
      ? noClear === 1
        ? '1 install has no clear day in the next two weeks'
        : `${noClear} installs have no clear day in the next two weeks`
      : 'Bad weather is forecast; these installs can move to a clear day.';
  const expiresAt = new Date(Math.min(...moved.map((m) => m.install.startsAt.getTime())));

  await withTenant(deps.pools, ctx, async (tx) => {
    // Another run may have made the task while the model was writing.
    if (await weatherTaskOpen(tx, ctx, since)) return;
    await createTask(
      tx,
      ctx,
      { agent: 'scheduler', kind: 'weather_moves', title: titleFor(moved), summary, expiresAt, steps: [...moveSteps, ...textSteps] },
      { now, allowInternalStepTypes: true },
    );
  });
}
