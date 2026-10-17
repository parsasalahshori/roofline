import { missingStormTokens } from '@roofline/shared';
import { Button, EmptyState, Field, FilePicker, Listbox, Panel, Skeleton, Toggle, useToast, type ListboxOption } from '@roofline/ui';
import { useId, useState, type CSSProperties, type FormEvent } from 'react';
import { ApiError } from '../../api/client.ts';
import type { StormSettingsBody, StormSettingsPatch } from '../../api/types.ts';
import { connections } from '../../copy/connections.ts';
import { errors } from '../../copy/errors.ts';
import { settings as settingsCopy } from '../../copy/settings.ts';
import { storm } from '../../copy/storm.ts';
import { useDeleteStormPhoto, useSaveStormSettings, useStormSettings, useUploadStormPhoto } from './stormApi.ts';
import form from './form.module.css';
import { SaveBar } from './SaveBar.tsx';
import styles from './StormTab.module.css';

/*
 * The Storm tab of Settings (owner and office): when a storm starts a plan, the ad budget and
 * how it is split, whether storm emails go out, the standard texts, and the ad photos.
 */

const THRESHOLD_OPTIONS: ListboxOption[] = ['0.75', '1', '1.25', '1.5', '1.75', '2'].map((value) => ({
  value,
  label: settingsCopy.stormTab.hailSize(Number(value)),
}));

const PHOTO_TYPES = ['image/jpeg', 'image/png'];
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** The server fields this form shows under an input; any other field's message is a toast. */
const FORM_FIELDS: readonly string[] = [
  'thresholdIn',
  'adBudgetCents',
  'adDays',
  'adGoogleSharePct',
  'smsTemplate',
  'emailSubject',
  'emailTemplate',
];

/** What the form shows. The dollars and days are text while they are typed. */
type Draft = {
  threshold: string;
  budget: string;
  days: string;
  share: number;
  emailEnabled: boolean;
  sms: string;
  emailSubject: string;
  email: string;
};

function draftFrom(settings: StormSettingsBody): Draft {
  return {
    threshold: String(settings.thresholdIn),
    budget: toDollars(settings.adBudgetCents),
    days: String(settings.adDays),
    share: settings.adGoogleSharePct,
    emailEnabled: settings.emailEnabled,
    sms: settings.smsTemplate,
    emailSubject: settings.emailSubject,
    email: settings.emailTemplate,
  };
}

/** Cents as the budget field shows them: whole dollars without decimals, else two places. */
function toDollars(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** Dollars typed as text back to whole cents, or null when it is not an amount of money. A $ and commas are allowed. */
function parseDollars(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

/** Days typed as text back to a whole number, or null when it is not one. The server checks the range. */
function parseDays(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/** Only what changed since the settings were loaded, as PUT takes it. */
function buildPatch(settings: StormSettingsBody, draft: Draft, budgetCents: number | null, days: number | null): StormSettingsPatch {
  const patch: StormSettingsPatch = {};
  const threshold = Number(draft.threshold);
  if (threshold !== settings.thresholdIn) patch.thresholdIn = threshold;
  if (budgetCents !== null && budgetCents !== settings.adBudgetCents) patch.adBudgetCents = budgetCents;
  if (days !== null && days !== settings.adDays) patch.adDays = days;
  if (draft.share !== settings.adGoogleSharePct) patch.adGoogleSharePct = draft.share;
  if (draft.emailEnabled !== settings.emailEnabled) patch.emailEnabled = draft.emailEnabled;
  if (draft.sms !== settings.smsTemplate) patch.smsTemplate = draft.sms;
  if (draft.emailSubject !== settings.emailSubject) patch.emailSubject = draft.emailSubject;
  if (draft.email !== settings.emailTemplate) patch.emailTemplate = draft.email;
  return patch;
}

/**
 * Keys the form on what the server holds, so a saved change (or a changed template) starts the form
 * again from the new answer. Photos are left out: adding one must not wipe what is typed in the form.
 */
const formKey = (settings: StormSettingsBody) =>
  JSON.stringify([
    settings.thresholdIn,
    settings.adBudgetCents,
    settings.adDays,
    settings.adGoogleSharePct,
    settings.emailEnabled,
    settings.smsTemplate,
    settings.emailSubject,
    settings.emailTemplate,
  ]);

export function StormTab() {
  const query = useStormSettings();
  const settings = query.data;
  if (settings === undefined) {
    if (query.isError) {
      return (
        <EmptyState
          title={errors.generic}
          action={
            <Button variant="primary" onClick={() => void query.refetch()}>
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
          <span className="visually-hidden">{storm.settings.loading}</span>
        </div>
      </Panel>
    );
  }
  return (
    <div className={styles.page}>
      <SettingsForm key={formKey(settings)} settings={settings} />
      <PhotosSection settings={settings} />
    </div>
  );
}

type FormProps = { settings: StormSettingsBody };

/** The settings form: four panels and a save bar, which sends only what changed. */
function SettingsForm({ settings }: FormProps) {
  const save = useSaveStormSettings();
  const toast = useToast();
  const shareHelpId = useId();
  // What the form was loaded with: the form starts again from the server's answer after a save (see formKey)
  const [baseline] = useState<Draft>(() => draftFrom(settings));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [serverError, setServerError] = useState<{ field: string; message: string } | null>(null);

  const update = (changes: Partial<Draft>) => {
    setServerError(null);
    setDraft((current) => ({ ...current, ...changes }));
  };

  const budgetCents = parseDollars(draft.budget);
  const days = parseDays(draft.days);
  const missingSms = missingStormTokens(draft.sms, 'sms');
  const missingEmail = missingStormTokens(draft.email, 'email');
  const patch = buildPatch(settings, draft, budgetCents, days);
  const canSave =
    Object.keys(patch).length > 0 && budgetCents !== null && days !== null && missingSms.length === 0 && missingEmail.length === 0;
  // Anything typed that differs from what was loaded: a wrong entry is a change too, and can be discarded
  const changed = JSON.stringify(draft) !== JSON.stringify(baseline);

  /** A server message for this field, when the last save named it. */
  const at = (field: string) => (serverError?.field === field ? serverError.message : undefined);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    save.mutateAsync(patch).then(
      () => toast.show(storm.settings.saved, 'success'),
      (error: unknown) => {
        if (error instanceof ApiError && error.field !== undefined && FORM_FIELDS.includes(error.field)) {
          setServerError({ field: error.field, message: error.message });
        } else {
          toast.show(error instanceof ApiError ? error.message : errors.generic, 'error');
        }
      },
    );
  }

  /** A template's text box, with the button that puts the standard text back under it. */
  const resetButton = (label: string, standard: Partial<Draft>) => (
    <Button
      type="button"
      variant="default"
      size="sm"
      aria-label={storm.settings.useStandardTextFor(label)}
      onClick={() => update(standard)}
    >
      {storm.settings.useStandardText}
    </Button>
  );

  return (
    // noValidate: the browser's own range check would stop a 40-day entry before the server can say why
    <form className={form.form} onSubmit={submit} noValidate>
      <Panel title={storm.settings.thresholdHeading}>
        <div className={form.grid}>
          <Listbox
            label={storm.settings.thresholdLabel}
            value={draft.threshold}
            options={THRESHOLD_OPTIONS}
            help={storm.settings.thresholdHelp}
            error={at('thresholdIn')}
            onChange={(value) => update({ threshold: value })}
          />
        </div>
      </Panel>

      <Panel title={storm.settings.budgetHeading}>
        <div className={form.grid}>
          <Field
            label={storm.settings.budgetLabel}
            inputMode="decimal"
            value={draft.budget}
            help={storm.settings.budgetHelp}
            error={budgetCents === null ? storm.settings.budgetInvalid : at('adBudgetCents')}
            onChange={(event) => update({ budget: event.target.value })}
          />
          <Field
            label={storm.settings.daysLabel}
            type="number"
            min={1}
            max={30}
            step={1}
            inputMode="numeric"
            value={draft.days}
            help={storm.settings.daysHelp}
            error={days === null ? storm.settings.daysInvalid : at('adDays')}
            onChange={(event) => update({ days: event.target.value })}
          />
          {/* --ratio is how far along the slider is, so its filled part can follow the thumb */}
          <div className={`${form.span} ${styles.share}`} style={{ '--ratio': draft.share / 100 } as CSSProperties}>
            <Field
              label={connections.googleShareLabel}
              type="range"
              min={0}
              max={100}
              step={5}
              value={String(draft.share)}
              aria-valuetext={connections.shareSplit(draft.share, 100 - draft.share)}
              aria-describedby={shareHelpId}
              error={at('adGoogleSharePct')}
              onChange={(event) => update({ share: Number(event.target.value) })}
            />
            {/* The two ends of the slider, named short: Google's share on the left, Meta's on the right. The slider says both aloud. */}
            <p className={styles.split} aria-hidden="true">
              <span>
                {connections.googleShareShort} <span className={styles.figure}>{`${draft.share}%`}</span>
              </span>
              <span>
                {connections.metaShareShort} <span className={styles.figure}>{`${100 - draft.share}%`}</span>
              </span>
            </p>
            <p id={shareHelpId} className={styles.fieldHelp}>
              {storm.settings.shareHelp}
            </p>
          </div>
        </div>
      </Panel>

      <Panel title={storm.settings.emailsHeading}>
        <Toggle label={storm.settings.emailsLabel} checked={draft.emailEnabled} onChange={(next) => update({ emailEnabled: next })} />
        <p className={styles.toggleHelp}>{storm.settings.emailsHelp}</p>
      </Panel>

      <Panel title={storm.settings.templatesHeading}>
        <p className={form.help}>{storm.settings.templatesHelp}</p>
        <p className={form.help}>{storm.settings.tokensHelp}</p>

        <div className={styles.templates}>
          <div className={styles.template}>
            <Field
              label={storm.settings.smsLabel}
              multiline
              rows={4}
              value={draft.sms}
              help={storm.settings.smsHelp}
              error={missingSms.length > 0 ? storm.settings.missingTokens(missingSms.join(', ')) : at('smsTemplate')}
              onChange={(event) => update({ sms: event.target.value })}
            />
            {resetButton(storm.settings.smsLabel, { sms: settings.defaults.smsTemplate })}
          </div>

          <div className={styles.template}>
            <Field
              label={storm.settings.emailSubjectLabel}
              value={draft.emailSubject}
              error={at('emailSubject')}
              onChange={(event) => update({ emailSubject: event.target.value })}
            />
            {resetButton(storm.settings.emailSubjectLabel, { emailSubject: settings.defaults.emailSubject })}
          </div>

          <div className={styles.template}>
            <Field
              label={storm.settings.emailLabel}
              multiline
              rows={8}
              value={draft.email}
              help={storm.settings.emailHelp}
              error={missingEmail.length > 0 ? storm.settings.missingTokens(missingEmail.join(', ')) : at('emailTemplate')}
              onChange={(event) => update({ email: event.target.value })}
            />
            {resetButton(storm.settings.emailLabel, { email: settings.defaults.emailTemplate })}
          </div>
        </div>
      </Panel>

      <SaveBar
        dirty={changed}
        saving={save.isPending}
        saveLabel={storm.settings.save}
        saveDisabled={!canSave}
        onDiscard={() => {
          save.reset();
          setServerError(null);
          setDraft(baseline);
        }}
      />
    </form>
  );
}

/** The ad photos: the list with a remove button for each, and a picker until the company has the most allowed. */
function PhotosSection({ settings }: FormProps) {
  const upload = useUploadStormPhoto();
  const remove = useDeleteStormPhoto();
  const toast = useToast();
  const [photoError, setPhotoError] = useState<string | undefined>(undefined);
  const full = settings.photos.length >= settings.maxPhotos;

  // Checked here before anything is sent; the server checks the same rules again
  function pick(file: File) {
    if (!PHOTO_TYPES.includes(file.type)) {
      setPhotoError(storm.settings.photoType);
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setPhotoError(storm.settings.photoSize);
      return;
    }
    setPhotoError(undefined);
    upload.mutateAsync(file).catch((error: unknown) => {
      setPhotoError(error instanceof ApiError ? error.message : errors.generic);
    });
  }

  function removeOne(id: string) {
    remove.mutateAsync(id).catch((error: unknown) => {
      toast.show(error instanceof ApiError ? error.message : errors.generic, 'error');
    });
  }

  return (
    <Panel title={storm.settings.photosHeading}>
      <p className={form.help}>{storm.settings.photosHelp}</p>

      {settings.photos.length === 0 ? <p className={styles.help}>{storm.settings.photosEmpty}</p> : null}
      {settings.photos.length > 0 ? (
        <ul className={styles.photos}>
          {settings.photos.map((photo, index) => (
            <li key={photo.id} className={styles.photo}>
              <img src={photo.url} alt={storm.settings.photoAlt(index + 1)} className={styles.thumb} />
              <Button
                type="button"
                variant="default"
                size="sm"
                aria-label={storm.settings.removePhoto(index + 1)}
                busy={remove.isPending && remove.variables === photo.id}
                onClick={() => removeOne(photo.id)}
              >
                {storm.settings.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {full ? (
        <p className={styles.help}>{storm.settings.photosFull(settings.maxPhotos)}</p>
      ) : (
        <div className={styles.picker}>
          <FilePicker
            label={storm.settings.photoPickLabel}
            buttonLabel={storm.settings.photoChoose}
            dropLabel={settingsCopy.stormTab.photoDrop}
            accept="image/jpeg,image/png"
            busy={upload.isPending}
            error={photoError}
            onFile={pick}
          />
        </div>
      )}
    </Panel>
  );
}
