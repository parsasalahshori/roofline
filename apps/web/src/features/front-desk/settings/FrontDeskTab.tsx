import type { FrontDeskSettings, FrontDeskSettingsInput, FrontDeskVoice, FrontDeskVoiceId } from '@roofline/shared';
import { FRONT_DESK_LIMITS } from '@roofline/shared';
import { Banner, Button, Card, EmptyState, Field, Select, Skeleton, Toggle, useToast } from '@roofline/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client.ts';
import { errors } from '../../../copy/errors.ts';
import { frontDeskSettings } from '../../../copy/front-desk-settings.ts';
import { ForwardingGuide } from './ForwardingGuide.tsx';
import { OnCallList } from './OnCallList.tsx';
import { useFrontDeskSettings, useFrontDeskVoices, useSaveFrontDeskSettings } from './settings-api.ts';
import styles from './FrontDeskTab.module.css';

/*
 * Settings -> Front Desk: whether the assistant answers calls and texts, what it may do, how it
 * rings the team, how long recordings and transcripts are kept, and the on-call order. Owners and
 * office members only (the route hides the tab from everyone else).
 */

/** The number fields, with the limits the server enforces (FRONT_DESK_LIMITS). */
type NumberField = 'ringTeamFirstSeconds' | 'recordingRetentionDays' | 'transcriptRetentionDays' | 'maxConcurrentAiCalls';

/** Form fields that have a place to show a message next to them. Anything else goes in the banner. */
const FIELD_SLOTS = [
  'voice',
  'facts',
  'ringTeamFirstSeconds',
  'recordingRetentionDays',
  'transcriptRetentionDays',
  'maxConcurrentAiCalls',
] as const;

/** What the form holds while it is being edited. Numbers stay as typed until they are saved. */
type Draft = {
  enabled: boolean;
  texts: boolean;
  voice: FrontDeskVoiceId;
  facts: string;
  canMove: boolean;
  canCancel: boolean;
  missedCallTextBack: boolean;
  numbers: Record<NumberField, string>;
};

const LIMITS = FRONT_DESK_LIMITS;
const FACTS_MAX = LIMITS.factsMaxChars;

/** A whole number, typed as digits only, inside a range. Anything else is not a value to save. */
function wholeInRange(raw: string, range: { min: number; max: number }): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= range.min && value <= range.max ? value : null;
}

function draftFrom(saved: FrontDeskSettings): Draft {
  return {
    enabled: saved.enabled,
    texts: saved.texts,
    voice: saved.voice,
    facts: saved.facts,
    canMove: saved.canMove,
    canCancel: saved.canCancel,
    missedCallTextBack: saved.missedCallTextBack,
    numbers: {
      ringTeamFirstSeconds: String(saved.ringTeamFirstSeconds),
      recordingRetentionDays: String(saved.recordingRetentionDays),
      transcriptRetentionDays: String(saved.transcriptRetentionDays),
      maxConcurrentAiCalls: String(saved.maxConcurrentAiCalls),
    },
  };
}

/** The on-call order as saved: the members who are on the list, in ring order. */
function orderFrom(saved: FrontDeskSettings): string[] {
  return saved.onCall
    .filter((member) => member.onCallOrder !== null)
    .sort((a, b) => (a.onCallOrder ?? 0) - (b.onCallOrder ?? 0))
    .map((member) => member.userId);
}

/** The range copy for each number field. */
const NUMBER_COPY: Record<NumberField, { label: string; range: (min: number, max: number) => string }> = {
  ringTeamFirstSeconds: { label: frontDeskSettings.ringTeam.label, range: frontDeskSettings.ringTeam.range },
  recordingRetentionDays: { label: frontDeskSettings.recordingDays.label, range: frontDeskSettings.recordingDays.range },
  transcriptRetentionDays: { label: frontDeskSettings.transcriptDays.label, range: frontDeskSettings.transcriptDays.range },
  maxConcurrentAiCalls: { label: frontDeskSettings.maxCalls.label, range: frontDeskSettings.maxCalls.range },
};

type FormProps = {
  saved: FrontDeskSettings;
  voices: FrontDeskVoice[] | undefined;
  saving: boolean;
  serverError: Error | null;
  onSave: (input: FrontDeskSettingsInput) => void;
};

/** The form itself. It is remounted with fresh state each time the settings are saved, so it always shows what the server kept. */
function FrontDeskForm({ saved, voices, saving, serverError, onSave }: FormProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(saved));
  const [order, setOrder] = useState<string[]>(() => orderFrom(saved));

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setNumber = (key: NumberField, value: string) =>
    setDraft((current) => ({ ...current, numbers: { ...current.numbers, [key]: value } }));

  // Client-side checks mirror the server's limits. Each one is the message under its own field.
  const numberValues: Record<NumberField, number | null> = {
    ringTeamFirstSeconds: wholeInRange(draft.numbers.ringTeamFirstSeconds, LIMITS.ringTeamFirstSeconds),
    recordingRetentionDays: wholeInRange(draft.numbers.recordingRetentionDays, LIMITS.recordingRetentionDays),
    transcriptRetentionDays: wholeInRange(draft.numbers.transcriptRetentionDays, LIMITS.transcriptRetentionDays),
    maxConcurrentAiCalls: wholeInRange(draft.numbers.maxConcurrentAiCalls, LIMITS.maxConcurrentAiCalls),
  };
  const clientErrors: Partial<Record<'facts' | NumberField, string>> = {};
  if (draft.facts.length > FACTS_MAX) clientErrors.facts = frontDeskSettings.facts.tooLong(FACTS_MAX);
  for (const key of Object.keys(NUMBER_COPY) as NumberField[]) {
    if (numberValues[key] === null) {
      const range = LIMITS[key];
      clientErrors[key] = NUMBER_COPY[key].range(range.min, range.max);
    }
  }
  const hasClientErrors = Object.keys(clientErrors).length > 0;

  // The server's answer to the last save: next to its field when it names one we show, else in the banner
  const apiError = serverError instanceof ApiError ? serverError : null;
  const serverFor = (field: string) => (apiError?.field === field ? apiError.message : undefined);
  const bannerMessage =
    serverError === null
      ? undefined
      : apiError === null
        ? frontDeskSettings.saveFailed
        : apiError.field === undefined || !(FIELD_SLOTS as readonly string[]).includes(apiError.field)
          ? apiError.message
          : undefined;
  const blocked = saved.blockedReason !== null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hasClientErrors || saving) return;
    const input: FrontDeskSettingsInput = {
      enabled: draft.enabled,
      texts: draft.texts,
      voice: draft.voice,
      facts: draft.facts,
      canMove: draft.canMove,
      canCancel: draft.canCancel,
      ringTeamFirstSeconds: numberValues.ringTeamFirstSeconds ?? 0,
      missedCallTextBack: draft.missedCallTextBack,
      recordingRetentionDays: numberValues.recordingRetentionDays ?? 0,
      transcriptRetentionDays: numberValues.transcriptRetentionDays ?? 0,
      maxConcurrentAiCalls: numberValues.maxConcurrentAiCalls ?? 0,
      onCallOrder: order,
    };
    onSave(input);
  }

  const voiceOptions =
    voices && voices.length > 0
      ? voices.map((voice) => ({ value: voice.id, label: voice.label }))
      : [{ value: draft.voice, label: draft.voice }];
  const selectedVoice = voices?.find((voice) => voice.id === draft.voice);

  return (
    <form onSubmit={submit} noValidate className={styles.form}>
      {bannerMessage ? <Banner tone="danger">{bannerMessage}</Banner> : null}

      <Card as="section" className={styles.section}>
        <div className={styles.switches}>
          <Toggle
            label={frontDeskSettings.onOff.label}
            checked={draft.enabled}
            disabled={blocked || saving}
            onChange={(next) => {
              // Never turn the assistant on while it is blocked
              if (!blocked) update('enabled', next);
            }}
          />
          {blocked ? (
            <p className={styles.blocked}>{frontDeskSettings.onOff.blocked[saved.blockedReason ?? 'no_number']}</p>
          ) : null}
          <Toggle
            label={frontDeskSettings.texts.label}
            checked={draft.texts}
            disabled={saving}
            onChange={(next) => update('texts', next)}
          />
        </div>
      </Card>

      <Card as="section" className={styles.section}>
        <Select
          label={frontDeskSettings.voice.label}
          value={draft.voice}
          options={voiceOptions}
          disabled={saving}
          error={serverFor('voice')}
          className={styles.voice}
          onChange={(value) => {
            const picked = voices?.find((voice) => voice.id === value);
            if (picked) update('voice', picked.id);
          }}
        />
        {selectedVoice?.previewUrl ? (
          <audio
            controls
            preload="none"
            src={selectedVoice.previewUrl}
            aria-label={frontDeskSettings.voice.preview(selectedVoice.label)}
            className={styles.preview}
          />
        ) : null}

        <Field
          label={frontDeskSettings.facts.label}
          help={frontDeskSettings.facts.help}
          name="facts"
          multiline
          rows={6}
          value={draft.facts}
          disabled={saving}
          error={clientErrors.facts ?? serverFor('facts')}
          onChange={(event) => update('facts', event.target.value)}
        />
        <p className={styles.counter} aria-live="polite">
          {frontDeskSettings.facts.counter(draft.facts.length, FACTS_MAX)}
        </p>
      </Card>

      <Card as="section" className={styles.section}>
        <div className={styles.switches}>
          <Toggle
            label={frontDeskSettings.mayMove.label}
            checked={draft.canMove}
            disabled={saving}
            onChange={(next) => update('canMove', next)}
          />
          <Toggle
            label={frontDeskSettings.mayCancel.label}
            checked={draft.canCancel}
            disabled={saving}
            onChange={(next) => update('canCancel', next)}
          />
          <Toggle
            label={frontDeskSettings.textBack.label}
            checked={draft.missedCallTextBack}
            disabled={saving}
            onChange={(next) => update('missedCallTextBack', next)}
          />
        </div>

        <div className={styles.numbers}>
          <Field
            label={frontDeskSettings.ringTeam.label}
            help={frontDeskSettings.ringTeam.help}
            name="ringTeamFirstSeconds"
            type="number"
            inputMode="numeric"
            step={1}
            min={LIMITS.ringTeamFirstSeconds.min}
            max={LIMITS.ringTeamFirstSeconds.max}
            value={draft.numbers.ringTeamFirstSeconds}
            disabled={saving}
            error={clientErrors.ringTeamFirstSeconds ?? serverFor('ringTeamFirstSeconds')}
            onChange={(event) => setNumber('ringTeamFirstSeconds', event.target.value)}
          />
          <Field
            label={frontDeskSettings.recordingDays.label}
            help={frontDeskSettings.recordingDays.help}
            name="recordingRetentionDays"
            type="number"
            inputMode="numeric"
            step={1}
            min={LIMITS.recordingRetentionDays.min}
            max={LIMITS.recordingRetentionDays.max}
            value={draft.numbers.recordingRetentionDays}
            disabled={saving}
            error={clientErrors.recordingRetentionDays ?? serverFor('recordingRetentionDays')}
            onChange={(event) => setNumber('recordingRetentionDays', event.target.value)}
          />
          <Field
            label={frontDeskSettings.transcriptDays.label}
            help={frontDeskSettings.transcriptDays.help}
            name="transcriptRetentionDays"
            type="number"
            inputMode="numeric"
            step={1}
            min={LIMITS.transcriptRetentionDays.min}
            max={LIMITS.transcriptRetentionDays.max}
            value={draft.numbers.transcriptRetentionDays}
            disabled={saving}
            error={clientErrors.transcriptRetentionDays ?? serverFor('transcriptRetentionDays')}
            onChange={(event) => setNumber('transcriptRetentionDays', event.target.value)}
          />
          <Field
            label={frontDeskSettings.maxCalls.label}
            name="maxConcurrentAiCalls"
            type="number"
            inputMode="numeric"
            step={1}
            min={LIMITS.maxConcurrentAiCalls.min}
            max={LIMITS.maxConcurrentAiCalls.max}
            value={draft.numbers.maxConcurrentAiCalls}
            disabled={saving}
            error={clientErrors.maxConcurrentAiCalls ?? serverFor('maxConcurrentAiCalls')}
            onChange={(event) => setNumber('maxConcurrentAiCalls', event.target.value)}
          />
        </div>
      </Card>

      <Card as="section" className={styles.section}>
        <OnCallList members={saved.onCall} order={order} onChange={setOrder} disabled={saving} />
      </Card>

      <div className={styles.actions}>
        <Button type="submit" variant="primary" busy={saving}>
          {saving ? frontDeskSettings.saving : frontDeskSettings.save}
        </Button>
      </div>
    </form>
  );
}

/** Settings -> Front Desk. Loads the settings and voices, then shows the form (or a skeleton, or a failure). */
export function FrontDeskTab() {
  const query = useFrontDeskSettings();
  const voices = useFrontDeskVoices();
  const save = useSaveFrontDeskSettings();
  const toast = useToast();
  // Bumped after each save so the form re-seeds from what the server kept
  const [revision, setRevision] = useState(0);

  if (!query.data) {
    if (query.error) {
      return (
        <EmptyState
          title={frontDeskSettings.loadFailed}
          action={
            <Button variant="primary" onClick={() => void query.refetch()}>
              {errors.tryAgain}
            </Button>
          }
        />
      );
    }
    return (
      <div aria-busy="true">
        <Skeleton lines={5} />
      </div>
    );
  }

  function onSave(input: FrontDeskSettingsInput) {
    save.mutate(input, {
      onSuccess: () => {
        toast.show(frontDeskSettings.saved, 'success');
        setRevision((count) => count + 1);
      },
    });
  }

  return (
    <div className={styles.page}>
      <FrontDeskForm
        key={revision}
        saved={query.data}
        voices={voices.data}
        saving={save.isPending}
        serverError={save.error}
        onSave={onSave}
      />

      <section className={styles.forwardingSlot} data-forwarding-slot>
        <ForwardingGuide />
      </section>
    </div>
  );
}
