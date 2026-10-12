import type { StepView } from '../../../api/types.ts';
import { stepRoutes } from '../../../copy/stepRoutes.ts';
import { useTeam } from '../../settings/api.ts';
import type { StepKit, StepPreviewProps } from './types.ts';
import styles from './BuildRoutesPreview.module.css';

/** The build_routes payload's fields the kit reads, typed loosely: a payload the server sent is checked by the shared schema, not here. */
function readPayload(step: Pick<StepView, 'payload'>): { repUserIds: string[]; maxDoors: number | undefined } {
  const payload = step.payload ?? {};
  const repUserIds = Array.isArray(payload.repUserIds)
    ? payload.repUserIds.filter((id): id is string => typeof id === 'string')
    : [];
  const maxDoors = typeof payload.maxDoors === 'number' ? payload.maxDoors : undefined;
  return { repUserIds, maxDoors };
}

/**
 * The door-knock plan: its title, one line per rep (their name, then their routes and doors) and the
 * door cap. Counts only: no owner names and no addresses. The lines come from the step's preview, where
 * each starts with its rep's number; the names come from the team, by position, and fall back to the number.
 */
export function BuildRoutesPreview({ step }: StepPreviewProps) {
  const team = useTeam();
  const members = team.data?.members ?? [];
  const { repUserIds, maxDoors } = readPayload(step);
  const names = new Map(members.map((member) => [member.userId.toLowerCase(), member.name]));

  return (
    <section className={styles.preview}>
      <h3 className={styles.title}>{step.preview.title}</h3>
      <p className={styles.note}>{stepRoutes.internalNote}</p>
      <ul className={styles.routes}>
        {step.preview.lines.map((line, i) => {
          const id = repUserIds[i]?.toLowerCase() ?? '';
          return (
            <li key={i} className={styles.route}>
              <span className={styles.rep}>{names.get(id) ?? stepRoutes.repFallback(i)}</span>
              <span className={styles.detail}>{line.replace(/^Rep \d+:\s*/, '')}</span>
            </li>
          );
        })}
      </ul>
      {maxDoors === undefined ? null : <p className={styles.cap}>{stepRoutes.doorsCap(maxDoors)}</p>}
    </section>
  );
}

/** The build_routes review kit: the route preview, and the Edit sheet's reps and door cap. */
export const buildRoutesKit: StepKit = {
  Preview: BuildRoutesPreview,
  review: (step) => step.preview,
  editFields(step) {
    const { repUserIds, maxDoors } = readPayload(step);
    return [
      { id: 'reps', label: stepRoutes.repsLabel, kind: 'pick', value: repUserIds, options: [] },
      { id: 'maxDoors', label: stepRoutes.doorsLabel, kind: 'number', value: maxDoors === undefined ? '' : String(maxDoors) },
    ];
  },
  toPayload(step, values) {
    const reps = Array.isArray(values.reps) ? values.reps : [];
    return { ...(step.payload ?? {}), repUserIds: reps, maxDoors: Number(values.maxDoors) };
  },
  fieldErrors(_step, values) {
    const errors: Record<string, string> = {};
    if (!Array.isArray(values.reps) || values.reps.length === 0) errors.reps = stepRoutes.pickOneRep;
    return errors;
  },
};
