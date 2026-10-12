/*
 * Agents screen (A1) shared pieces: the time-saved baselines (spec 3.1) and `minutesFor`.
 * SHELL by the lead: TIME_BASELINES and the types are final; `minutesFor`, `VISIBLE_BASELINE_KEYS`
 * and `G1_AGENTS_SHIPPED` are filled in by Package 1.
 */

export type BaselineDef = {
  /** Default minutes per unit (for the call keys: the fixed part; the call length is added on top). */
  minutes: number;
  /** Most minutes one step may count; absent means no cap. */
  capMinutes?: number;
  unit: string;
  /** The sentence shown to the owner next to the number. */
  basis: string;
  /** The call's own length (result.seconds / 60) is added to the minutes. */
  perCallLength?: boolean;
  /** Internal key: not editable and not listed for the owner. */
  hidden?: boolean;
};

export const TIME_BASELINES = {
  text_sent: { minutes: 1.5, capMinutes: 120, unit: 'text', basis: 'Looking up the number, writing and sending one text' },
  email_sent: { minutes: 0.5, capMinutes: 120, unit: 'email', basis: 'Sending one email from a template' },
  route_built: { minutes: 45, unit: 'route', basis: 'Planning one walking route on a map' },
  ad_campaign: { minutes: 45, unit: 'campaign', basis: 'Setting up one campaign by hand' },
  proposal_sent: { minutes: 20, unit: 'proposal', basis: 'Building and sending a three-option proposal' },
  exact_report: { minutes: 10, unit: 'order', basis: "Ordering a report on the supplier's site" },
  call_answered: {
    minutes: 2,
    perCallLength: true,
    unit: 'call',
    basis: 'Answering the call yourself, plus 2 minutes of notes',
  },
  spam_call: {
    minutes: 0,
    perCallLength: true,
    unit: 'call',
    basis: 'The time someone would have spent on the line',
  },
  booking: { minutes: 3, unit: 'booking', basis: 'Checking the calendar and entering the appointment' },
  text_reply: { minutes: 2, unit: 'reply', basis: 'Reading and answering one text' },
  /** Ruling AX-E: the three demo step types count 5 minutes per done step. Hidden: never editable or listed. */
  demo: { minutes: 5, unit: 'step', basis: 'A demo step', hidden: true },
} as const satisfies Record<string, BaselineDef>;

export type BaselineKey = keyof typeof TIME_BASELINES;

/** The same table, typed so that every key exposes the full BaselineDef shape (including `hidden`). */
const BASELINE_DEFS: Record<BaselineKey, BaselineDef> = TIME_BASELINES;

/** The baseline keys an owner sees and can edit (every key that is not hidden), in table order. */
export const VISIBLE_BASELINE_KEYS: readonly BaselineKey[] = (Object.keys(TIME_BASELINES) as BaselineKey[]).filter(
  (key) => BASELINE_DEFS[key].hidden !== true,
);

/** True only for a visible baseline key: hidden keys (demo) and unknown strings are not editable. */
export function isEditableBaselineKey(k: string): k is BaselineKey {
  return (VISIBLE_BASELINE_KEYS as readonly string[]).includes(k);
}

/** Ruling AX-B: flipped to true by G1 Task 15. */
export const G1_AGENTS_SHIPPED = false as boolean;

function finiteNonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Minutes saved for `units` done units of one baseline key.
 * - The per-unit base is the owner's override when one is set (never for hidden keys), else the table default.
 * - Keys with `perCallLength` add `extra.callMinutes` (the total call length) once on top.
 * - `capMinutes` is applied last and is not overridable.
 * - Zero (or invalid) units give zero minutes; `minutesPerUnit` is then the base.
 * - Nothing is rounded.
 */
export function minutesFor(
  key: BaselineKey,
  units: number,
  overrides: Partial<Record<BaselineKey, number>>,
  extra?: { callMinutes?: number },
): { minutesPerUnit: number; minutes: number } {
  const def = BASELINE_DEFS[key];
  const override = overrides[key];
  const base =
    !def.hidden && override !== undefined && Number.isFinite(override) && override >= 0 ? override : def.minutes;
  const count = Number.isFinite(units) && units > 0 ? units : 0;
  if (count === 0) return { minutesPerUnit: base, minutes: 0 };
  const callMinutes = def.perCallLength ? finiteNonNegative(extra?.callMinutes) : 0;
  let minutes = count * base + callMinutes;
  if (def.capMinutes !== undefined) minutes = Math.min(def.capMinutes, minutes);
  return { minutesPerUnit: minutes / count, minutes };
}
