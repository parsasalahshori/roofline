import { missingStormTokens } from '@roofline/shared';
import { Button, Card, EmptyState, Field, FilePicker, Select, Skeleton, Toggle, useToast } from '@roofline/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client.ts';
import type { StormSettingsBody, StormSettingsPatch } from '../../api/types.ts';
import { connections } from '../../copy/connections.ts';
import { errors } from '../../copy/errors.ts';
import { storm } from '../../copy/storm.ts';
import { useDeleteStormPhoto, useSaveStormSettings, useStormSettings, useUploadStormPhoto } from './stormApi.ts';
import styles from './StormTab.module.css';

/*
 * The Storm tab of Settings (owner and office): when a storm starts a plan, the ad budget and
 * how it is split, whether storm emails go out, the standard texts, and the ad photos.
 */

const THRESHOLD_OPTIONS = ['0.75', '1', '1.25', '1.5', '1.75', '2'].map((value) => ({
  value,
  label: storm.settings.thresholdOption(Number(value)),
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
    budget: (settings.adBudgetCents / 100).toFixed(2),
    days: String(settings.adDays),
    share: settings.adGoogleSharePct,
    emailEnabled: settings.emailEnabled,
    sms: settings.smsTemplate,
    emailSubject: settings.emailSubject,
    email: settings.emailTemplate,
  };
}

/** Dollars typed as text back to whole cents, or null when it is not an amount of money. */
function parseDollars(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
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
      <div role="status">
        <Skeleton lines={4} />
        <span className="visually-hidden">{storm.settings.loading}</span>
      </div>
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

/** The settings form: four sections and one Save button, which sends only what changed. */
function SettingsForm({ settings }: FormProps) {
  const save = useSaveStormSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [serverError, setServerError] = useState<{ field: string; message: string } | null>(null);
  const thresholdId = useId();
  const budgetId = useId();
  const emailsId = useId();
  const templatesId = useId();

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

  return (
    // noValidate: the browser's own range check would stop a 40-day entry before the server can say why
    <form className={styles.form} onSubmit={submit} noValidate>
      <Card as="section" aria-labelledby={thresholdId}>
        <h2 id={thresholdId} className={styles.heading}>
          {storm.settings.thresholdHeading}
        </h2>
        <Select
          label={storm.settings.thresholdLabel}
          value={draft.threshold}
          options={THRESHOLD_OPTIONS}
          help={storm.settings.thresholdHelp}
          error={at('thresholdIn')}
          onChange={(value) => update({ threshold: value })}
        />
      </Card>

      <Card as="section" aria-labelledby={budgetId} className={styles.budget}>
        <h2 id={budgetId} className={styles.heading}>
          {storm.settings.budgetHeading}
        </h2>
        <div className={styles.pair}>
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
        </div>
        <div className={styles.share}>
          <Field
            label={connections.googleShareLabel}
            type="range"
            min={0}
            max={100}
            step={5}
            value={String(draft.share)}
            help={storm.settings.shareHelp}
            error={at('adGoogleSharePct')}
            onChange={(event) => update({ share: Number(event.target.value) })}
          />
          <p className={styles.shareLine}>
            <span>{`${draft.share}%`}</span>
          </p>
          <p className={styles.shareLine}>
            {connections.metaShareLabel} <span>{`${100 - draft.share}%`}</span>
          </p>
        </div>
      </Card>

      <Card as="section" aria-labelledby={emailsId}>
        <h2 id={emailsId} className={styles.heading}>
          {storm.settings.emailsHeading}
        </h2>
        <Toggle label={storm.settings.emailsLabel} checked={draft.emailEnabled} onChange={(next) => update({ emailEnabled: next })} />
        <p className={styles.help}>{storm.settings.emailsHelp}</p>
      </Card>

      <Card as="section" aria-labelledby={templatesId} className={styles.wide}>
        <h2 id={templatesId} className={styles.heading}>
          {storm.settings.templatesHeading}
        </h2>
        <p className={styles.help}>{storm.settings.templatesHelp}</p>
        <p className={styles.help}>{storm.settings.tokensHelp}</p>

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
          <Button
            type="button"
            variant="ghost"
            aria-label={storm.settings.useStandardTextFor(storm.settings.smsLabel)}
            onClick={() => update({ sms: settings.defaults.smsTemplate })}
          >
            {storm.settings.useStandardText}
          </Button>
        </div>

        <div className={styles.template}>
          <Field
            label={storm.settings.emailSubjectLabel}
            value={draft.emailSubject}
            error={at('emailSubject')}
            onChange={(event) => update({ emailSubject: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            aria-label={storm.settings.useStandardTextFor(storm.settings.emailSubjectLabel)}
            onClick={() => update({ emailSubject: settings.defaults.emailSubject })}
          >
            {storm.settings.useStandardText}
          </Button>
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
          <Button
            type="button"
            variant="ghost"
            aria-label={storm.settings.useStandardTextFor(storm.settings.emailLabel)}
            onClick={() => update({ email: settings.defaults.emailTemplate })}
          >
            {storm.settings.useStandardText}
          </Button>
        </div>
      </Card>

      <div className={styles.saveRow}>
        <Button type="submit" variant="primary" disabled={!canSave} busy={save.isPending}>
          {storm.settings.save}
        </Button>
      </div>
    </form>
  );
}

/** The ad photos: the list with a remove button for each, and a picker until the company has the most allowed. */
function PhotosSection({ settings }: FormProps) {
  const upload = useUploadStormPhoto();
  const remove = useDeleteStormPhoto();
  const toast = useToast();
  const [photoError, setPhotoError] = useState<string | undefined>(undefined);
  const headingId = useId();
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
    <Card as="section" aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {storm.settings.photosHeading}
      </h2>
      <p className={styles.help}>{storm.settings.photosHelp}</p>

      {settings.photos.length === 0 ? <p className={styles.help}>{storm.settings.photosEmpty}</p> : null}
      {settings.photos.length > 0 ? (
        <ul className={styles.photos}>
          {settings.photos.map((photo, index) => (
            <li key={photo.id} className={styles.photo}>
              <img src={photo.url} alt={storm.settings.photoAlt(index + 1)} className={styles.thumb} />
              <Button
                type="button"
                variant="ghost"
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
        <FilePicker
          label={storm.settings.photoPickLabel}
          buttonLabel={storm.settings.photoChoose}
          dropLabel={storm.settings.photoDrop}
          accept="image/jpeg,image/png"
          busy={upload.isPending}
          error={photoError}
          onFile={pick}
        />
      )}
    </Card>
  );
}
