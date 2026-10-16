import { useState, type FormEvent } from 'react';
import { WEEKDAYS, type ScheduleSettings, type WorkHours, type Weekday } from '@roofline/shared';
import { Button, EmptyState, Field, Icon, Panel, Skeleton, Toggle, useToast } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { schedule } from '../../copy/schedule.ts';
import { useMyHours, useSaveMyHours, useSaveScheduleSettings, useScheduleSettings, type MyHours } from './crm-api.ts';
import { WorkHoursEditor } from './WorkHoursEditor.tsx';
import form from './form.module.css';
import { SaveBar } from './SaveBar.tsx';
import styles from './ScheduleTab.module.css';

/** The three numbers of the company settings, as the API names them. */
type NumberKey = 'travelBufferMinutes' | 'minNoticeMinutes' | 'stuckAfterDays';
const NUMBER_KEYS: readonly NumberKey[] = ['travelBufferMinutes', 'minNoticeMinutes', 'stuckAfterDays'];
const NUMBER_LABELS: Record<NumberKey, string> = {
  travelBufferMinutes: schedule.travelBuffer,
  minNoticeMinutes: schedule.minNotice,
  stuckAfterDays: schedule.stuckAfter,
};

const WHOLE_NUMBER = /^\d+$/;
const DAY_PREFIX = 'workHours.';

function isNumberKey(field: string): field is NumberKey {
  return (NUMBER_KEYS as readonly string[]).includes(field);
}

function isWeekday(day: string): day is Weekday {
  return (WEEKDAYS as readonly string[]).includes(day);
}

/** Where a save error shows: under a day, under a number field, or as a toast. */
type Problems = {
  days: Partial<Record<Weekday, string>>;
  number?: { key: NumberKey; message: string };
  general?: string;
};

/** The API names a day as `workHours.<day>` and its message starts with the day key; the message is shown as it is. */
function routeError(error: Error): Problems {
  if (!(error instanceof ApiError)) return { days: {}, general: errors.generic };
  const field = error.field;
  if (field !== undefined && field.startsWith(DAY_PREFIX)) {
    const day = field.slice(DAY_PREFIX.length);
    if (isWeekday(day)) return { days: { [day]: error.message } };
  }
  if (field !== undefined && isNumberKey(field)) return { days: {}, number: { key: field, message: error.message } };
  return { days: {}, general: error.message };
}

/** Everything the Schedule tab shows: the owner's company hours, and the person's own hours. */
export function ScheduleTab() {
  const me = useMe();
  const settings = useScheduleSettings();
  const mine = useMyHours();

  // Shown only while there is nothing to show instead: a failed read with no earlier answer to keep
  const failure = settings.error ?? mine.error ?? me.error;
  if (settings.data === undefined || mine.data === undefined || me.data === undefined) {
    if (failure) {
      return (
        <EmptyState
          title={schedule.loadFailed}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void settings.refetch();
                void mine.refetch();
                void me.refetch();
              }}
            >
              {errors.tryAgain}
            </Button>
          }
        />
      );
    }
    return (
      <Panel>
        <div role="status">
          <Skeleton lines={4} />
          <span className="visually-hidden">{schedule.loading}</span>
        </div>
      </Panel>
    );
  }

  return (
    <>
      <CompanySection settings={settings.data} canEdit={me.data.role === 'owner'} />
      <YourHours mine={mine.data} />
    </>
  );
}

/** The form's values: the hours, and the three numbers as the text the person typed. */
type CompanyForm = { workHours: WorkHours } & Record<NumberKey, string>;

function toCompanyForm(settings: ScheduleSettings): CompanyForm {
  return {
    workHours: settings.workHours,
    travelBufferMinutes: String(settings.travelBufferMinutes),
    minNoticeMinutes: String(settings.minNoticeMinutes),
    stuckAfterDays: String(settings.stuckAfterDays),
  };
}

/** Company work hours and settings. The owner edits them; everyone else reads them. */
function CompanySection({ settings, canEdit }: { settings: ScheduleSettings; canEdit: boolean }) {
  const [values, setValues] = useState(() => toCompanyForm(settings));
  // The values the form was last loaded or saved with, so a background refresh does not look like a change
  const [baseline, setBaseline] = useState(() => toCompanyForm(settings));
  const [problems, setProblems] = useState<Problems>({ days: {} });
  const save = useSaveScheduleSettings();
  const toast = useToast();

  const changed =
    JSON.stringify(values.workHours) !== JSON.stringify(baseline.workHours) ||
    NUMBER_KEYS.some((key) => values[key] !== baseline[key]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !changed) return;
    // Only the form's shape is checked here; whether the hours fit together is the server's call
    const numbers = {} as Record<NumberKey, number>;
    for (const key of NUMBER_KEYS) {
      const text = values[key].trim();
      if (!WHOLE_NUMBER.test(text)) {
        setProblems({ days: {}, number: { key, message: schedule.notWholeNumber } });
        return;
      }
      numbers[key] = Number(text);
    }
    const body: ScheduleSettings = { workHours: values.workHours, ...numbers };
    setProblems({ days: {} });
    save.mutate(body, {
      onSuccess: (saved) => {
        // The server may have tidied the values: show those
        const next = toCompanyForm(saved);
        setBaseline(next);
        setValues(next);
        toast.show(schedule.saved, 'success');
      },
      onError: (error) => {
        const routed = routeError(error);
        setProblems(routed);
        if (routed.general) toast.show(routed.general, 'error');
      },
    });
  }

  return (
    <form className={form.form} onSubmit={submit} noValidate>
      <Panel title={schedule.companyTitle} padded={false}>
        {canEdit ? null : (
          <p className={`${form.note} ${styles.note}`}>
            <Icon name="lock" size={16} />
            {schedule.ownerOnlyNote}
          </p>
        )}
        <WorkHoursEditor
          value={values.workHours}
          onChange={(next) => setValues((current) => ({ ...current, workHours: next }))}
          disabled={!canEdit}
          errors={problems.days}
        />
        <div className={styles.rules}>
          <h3 className={form.group}>{schedule.rulesTitle}</h3>
          <div className={styles.numbers}>
            {NUMBER_KEYS.map((key) => (
              <Field
                key={key}
                name={key}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                label={NUMBER_LABELS[key]}
                value={values[key]}
                readOnly={!canEdit}
                error={problems.number?.key === key ? problems.number.message : undefined}
                onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
              />
            ))}
          </div>
        </div>
      </Panel>
      {canEdit ? (
        <SaveBar
          dirty={changed}
          saving={save.isPending}
          saveLabel={schedule.save}
          onDiscard={() => {
            save.reset();
            setValues(baseline);
            setProblems({ days: {} });
          }}
        />
      ) : null}
    </form>
  );
}

/** The person's own hours: the company hours, or their own when they turn that switch off. */
function YourHours({ mine }: { mine: MyHours }) {
  // The hours being edited. Null while the person follows the company hours or has no edits to save.
  const [draft, setDraft] = useState<WorkHours | null>(null);
  const [problems, setProblems] = useState<Problems>({ days: {} });
  const save = useSaveMyHours();
  const toast = useToast();

  // The editor shows while there are edits, or while the person has hours of their own
  const editing = draft !== null || mine.custom;
  const shown = draft ?? mine.workHours;

  function report(error: Error) {
    const routed = routeError(error);
    setProblems(routed);
    if (routed.general) toast.show(routed.general, 'error');
  }

  function followCompany(on: boolean) {
    if (on) {
      // Back on the company hours: sent at once, and the editor closes when the answer comes
      save.mutate(
        { workHours: null },
        {
          onSuccess: () => {
            setDraft(null);
            setProblems({ days: {} });
            toast.show(schedule.saved, 'success');
          },
          onError: report,
        },
      );
    } else {
      setProblems({ days: {} });
      setDraft(mine.workHours);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null) return;
    setProblems({ days: {} });
    save.mutate(
      { workHours: draft },
      {
        onSuccess: () => {
          setDraft(null);
          toast.show(schedule.saved, 'success');
        },
        onError: report,
      },
    );
  }

  return (
    <form className={form.form} onSubmit={submit} noValidate>
      <Panel
        title={schedule.yourTitle}
        padded={false}
        actions={
          <Toggle checked={!editing} label={schedule.useCompanyHours} disabled={save.isPending} onChange={followCompany} />
        }
      >
        {editing ? (
          <WorkHoursEditor value={shown} onChange={setDraft} disabled={save.isPending} errors={problems.days} />
        ) : null}
      </Panel>
      {draft !== null ? (
        <SaveBar
          dirty
          saving={save.isPending}
          saveLabel={schedule.save}
          onDiscard={() => {
            setDraft(null);
            setProblems({ days: {} });
          }}
        />
      ) : null}
    </form>
  );
}
