import { stepTypes } from '@roofline/shared';
import { Button, Checkbox, Field, Sheet } from '@roofline/ui';
import { useState } from 'react';
import type { StepView } from '../../api/types.ts';
import { common } from '../../copy/common.ts';
import { review } from '../../copy/review.ts';
import { stepAds } from '../../copy/stepAds.ts';
import { stepEdit } from '../../copy/stepEdit.ts';
import { stepRoutes } from '../../copy/stepRoutes.ts';
import { useCompany, useTeam } from '../settings/api.ts';
import { useStormSettings } from '../settings/stormApi.ts';
import sheetStyles from './ApprovalSheets.module.css';
import type { EditFieldSpec, EditValues, StepKit, StepKitContext } from './steps/types.ts';
import styles from './StepFieldsSheet.module.css';

export type StepFieldsSheetProps = {
  step: StepView;
  kit: StepKit;
  /** The save is on its way. */
  saving: boolean;
  /** The server's sentence about the step (its 400), shown above the footer. */
  error?: string;
  /** The payload the kit built from the edited values, ready to send. */
  onSave(payload: Record<string, unknown>): void;
  onClose(): void;
};

type Option = { value: string; label: string };

/** A field's value as the sheet holds it while typing: a string, or the chosen values of a pick. */
function initialValues(fields: EditFieldSpec[]): EditValues {
  const values: EditValues = {};
  for (const field of fields) {
    if (field.kind === 'pick') values[field.id] = Array.isArray(field.value) ? field.value : [];
    else values[field.id] = Array.isArray(field.value) ? field.value.join('\n') : field.value;
  }
  return values;
}

const textOf = (values: EditValues, id: string): string => {
  const value = values[id];
  return typeof value === 'string' ? value : '';
};

const pickedOf = (values: EditValues, id: string): string[] => {
  const value = values[id];
  return Array.isArray(value) ? value : [];
};

/**
 * The Edit sheet for a step with a review kit: one control per field the kit lists, the kit's
 * warnings under them, and its field errors and the shared payload check before anything is saved.
 * The parent mounts it per step while editing and unmounts it to close it.
 */
export function StepFieldsSheet(props: StepFieldsSheetProps) {
  const needsZone = props.step.type === 'create_appointment' || props.step.type === 'move_appointment';
  const company = useCompany(needsZone);
  // The visit and move kits show times in the company's zone, so their fields wait for it (G1 Task 17p)
  if (needsZone && company.isPending) return null;
  return <StepFieldsBody {...props} ctx={{ zone: company.data?.timezone ?? 'America/Chicago' }} />;
}

function StepFieldsBody({ step, kit, saving, error, onSave, onClose, ctx }: StepFieldsSheetProps & { ctx: StepKitContext }) {
  const team = useTeam();
  // The ad photos come from Settings; only a create_ad_campaign step reads them.
  const stormSettings = useStormSettings(step.type === 'create_ad_campaign');
  const photos = stormSettings.data?.photos ?? [];
  const [fields] = useState(() => kit.editFields(step, ctx));
  const [values, setValues] = useState<EditValues>(() => initialValues(fields));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sheetError, setSheetError] = useState<string | undefined>(undefined);

  const warnings = kit.warnings?.(step, values) ?? {};
  const members = (team.data?.members ?? []).filter((member) => member.status === 'active');

  /** The choices of a pick field: the team's members for the reps of a build_routes step, the kit's options otherwise. */
  function optionsOf(field: EditFieldSpec): Option[] {
    if (field.kind !== 'pick') return [];
    if (step.type === 'create_ad_campaign' && field.id === 'photo') {
      const current = pickedOf(values, field.id).filter((id) => id !== '');
      const known = photos.map((photo, i) => ({ value: photo.id.toLowerCase(), label: stepAds.photoN(i + 1) }));
      // A photo picked earlier that Settings no longer holds keeps a place in the list, so the choice is not lost
      const gone = current
        .filter((id) => !known.some((option) => option.value === id.toLowerCase()))
        .map((id) => ({ value: id, label: stepAds.photoGone }));
      return [{ value: '', label: stepAds.noPhoto }, ...known, ...gone];
    }
    if (step.type !== 'build_routes' || field.id !== 'reps') return field.options ?? [];
    const current = pickedOf(values, field.id);
    const known = members.map((member) => ({ value: member.userId.toLowerCase(), label: member.name }));
    // A rep already on the route who has left the team keeps a place in the list, so the choice is not lost
    const gone = current
      .filter((id) => !known.some((option) => option.value === id.toLowerCase()))
      .map((id) => ({ value: id, label: stepRoutes.repFallback(current.indexOf(id)) }));
    return [...known, ...gone];
  }

  function setField(id: string, value: string | string[]) {
    setValues((current) => ({ ...current, [id]: value }));
    setFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    setSheetError(undefined);
  }

  function togglePick(id: string, value: string, on: boolean) {
    const current = pickedOf(values, id);
    setField(id, on ? [...current.filter((item) => item !== value), value] : current.filter((item) => item !== value));
  }

  function save() {
    const errors = kit.fieldErrors?.(step, values, ctx) ?? {};
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setSheetError(undefined);
      return;
    }
    const payload = kit.toPayload(step, values, ctx);
    const def = stepTypes[step.type];
    const parsed = def.payload.safeParse(payload);
    if (!parsed.success) {
      setSheetError(parsed.error.issues[0]?.message ?? stepEdit.checkFailed);
      return;
    }
    const sentence = def.validate?.(parsed.data, { companyName: '' });
    if (sentence) {
      setSheetError(sentence);
      return;
    }
    setSheetError(undefined);
    onSave(payload);
  }

  function renderField(field: EditFieldSpec) {
    const error = fieldErrors[field.id];
    const notes = warnings[field.id] ?? [];

    if (field.kind === 'pick') {
      const options = optionsOf(field);
      const picked = pickedOf(values, field.id);
      const emptyText =
        step.type === 'build_routes' && field.id === 'reps'
          ? team.isPending
            ? stepEdit.loadingTeam
            : stepEdit.noTeam
          : stepEdit.noOptions;
      return (
        <fieldset key={field.id} className={styles.group}>
          <legend className={styles.legend}>{field.label}</legend>
          {options.length === 0 ? <p className={styles.hint}>{emptyText}</p> : null}
          {options.map((option) => (
            <Checkbox
              key={option.value}
              checked={picked.includes(option.value)}
              label={option.label}
              onChange={(on) => togglePick(field.id, option.value, on)}
            />
          ))}
          {field.help ? <p className={styles.hint}>{field.help}</p> : null}
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          {notes.map((note) => (
            <p key={note} className={styles.warning}>
              {note}
            </p>
          ))}
        </fieldset>
      );
    }

    const multiline = field.kind === 'multiline' || field.kind === 'lines';
    return (
      <div key={field.id} className={styles.field}>
        <Field
          label={field.label}
          help={field.kind === 'lines' ? (field.help ?? stepEdit.linesHelp) : field.help}
          error={error}
          multiline={multiline}
          rows={6}
          inputMode={field.inputMode ?? (field.kind === 'number' ? 'numeric' : undefined)}
          value={textOf(values, field.id)}
          onChange={(event) => setField(field.id, event.target.value)}
        />
        {notes.map((note) => (
          <p key={note} className={styles.warning}>
            {note}
          </p>
        ))}
      </div>
    );
  }

  const shown = error ?? sheetError;

  return (
    <Sheet
      open
      title={review.editTitle}
      onClose={onClose}
      closeLabel={common.close}
      footer={
        <div className={sheetStyles.footer}>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {review.cancel}
          </Button>
          <Button variant="primary" busy={saving} onClick={save}>
            {review.save}
          </Button>
        </div>
      }
    >
      <div className={sheetStyles.body}>
        {fields.map(renderField)}
        {shown ? (
          <p role="alert" className={styles.sheetError}>
            {shown}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
