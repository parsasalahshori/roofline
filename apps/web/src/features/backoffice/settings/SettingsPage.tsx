import { ORDER_STAGES, type BackofficeSettings, type OrderStage, type OrderStageTemplate } from '@roofline/shared';
import { Banner, Field, Skeleton, Toggle, useToast } from '@roofline/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client.ts';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { SaveBar } from '../../settings/SaveBar.tsx';
import { useBackofficeSettings, useSaveBackofficeSettings } from '../api.ts';
import { BackofficePage } from '../BackofficePage.tsx';
import { fillTemplate } from '../orders/messages.ts';
import { stageName } from '../format.ts';
import styles from './settings.module.css';

const t = copy.settings;
const SAMPLE = { first: t.sampleFirst, date: t.sampleDate, company: t.sampleCompany };

/** A template for every stage, filling in blanks for a stage the server has none for yet. */
function complete(settings: BackofficeSettings): BackofficeSettings {
  return {
    ...settings,
    templates: ORDER_STAGES.map((stage) => settings.templates.find((tpl) => tpl.stage === stage) ?? { stage, enabled: false, sms: '', emailSubject: '', emailBody: '' }),
  };
}

/** Settings: what the customer is told at each stage, and how many days before an order counts as stuck. */
export function SettingsPage() {
  return <BackofficePage tab="settings">{() => <Editor />}</BackofficePage>;
}

function Editor() {
  const settings = useBackofficeSettings();
  const save = useSaveBackofficeSettings();
  const toast = useToast();
  const [edited, setEdited] = useState<BackofficeSettings | null>(null);

  if (settings.isPending) return <Skeleton lines={4} />;
  if (settings.isError) return <Banner tone="danger">{copy.loadFailed}</Banner>;

  const base = complete(settings.data);
  const current = edited ?? base;
  const dirty = edited !== null && JSON.stringify(edited) !== JSON.stringify(base);
  const change = (edit: (value: BackofficeSettings) => BackofficeSettings) => setEdited((previous) => edit(previous ?? base));
  const patchTemplate = (stage: OrderStage, patch: Partial<OrderStageTemplate>) =>
    change((value) => ({ ...value, templates: value.templates.map((tpl) => (tpl.stage === stage ? { ...tpl, ...patch } : tpl)) }));
  const saveError = save.error instanceof ApiError ? save.error.message : save.isError ? copy.saveFailed : null;

  const dayErrors = new Map<OrderStage, string>();
  for (const stage of ORDER_STAGES) {
    const days = current.stuckDays[stage];
    if (days !== undefined && (!Number.isInteger(days) || days < 1)) dayErrors.set(stage, t.errors.days);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || dayErrors.size > 0 || !edited) return;
    save.mutate(edited, {
      onSuccess: () => {
        setEdited(null);
        toast.show(t.saved, 'success');
      },
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className={styles.page}>
      <section aria-label={t.stuckTitle}>
        <h3 className="bo-grouphead">{t.stuckTitle}</h3>
        <p className="bo-foot bo-groupfoot">{t.stuckIntro}</p>
        <div className={styles.days}>
          {ORDER_STAGES.slice(0, -1).map((stage) => (
            <Field
              key={stage}
              label={t.stuckDays(stageName(stage))}
              help={undefined}
              inputMode="numeric"
              placeholder={t.stuckHelp}
              value={current.stuckDays[stage] === undefined ? '' : String(current.stuckDays[stage])}
              error={dayErrors.get(stage)}
              onChange={(event) =>
                change((value) => {
                  const text = event.target.value.trim();
                  const stuckDays = { ...value.stuckDays };
                  if (text === '') delete stuckDays[stage];
                  else stuckDays[stage] = /^\d+$/.test(text) ? Number(text) : Number.NaN;
                  return { ...value, stuckDays };
                })
              }
            />
          ))}
        </div>
      </section>

      <h3 className="bo-grouphead">{t.title}</h3>
      <p className="bo-foot bo-groupfoot">{t.help}</p>
      <dl className={styles.placeholders}>
        <dt>{t.placeholdersTitle}</dt>
        {Object.entries(t.placeholders).map(([token, meaning]) => (
          <dd key={token}>
            <code>{token}</code> {meaning}
          </dd>
        ))}
      </dl>

      {current.templates.map((tpl) => (
        <TemplateCard key={tpl.stage} tpl={tpl} onChange={(patch) => patchTemplate(tpl.stage, patch)} />
      ))}

      {saveError ? <Banner tone="danger">{saveError}</Banner> : null}
      <SaveBar dirty={dirty} saving={save.isPending} saveLabel={t.save} saveDisabled={dayErrors.size > 0} onDiscard={() => setEdited(null)} />
    </form>
  );
}

function TemplateCard({ tpl, onChange }: { tpl: OrderStageTemplate; onChange: (patch: Partial<OrderStageTemplate>) => void }) {
  const name = stageName(tpl.stage);
  return (
    <section className={styles.card} aria-label={name}>
      <div className={styles.cardHead}>
        <h4 className="bo-headline">{name}</h4>
        <Toggle label={t.templateEnabled(name)} labelHidden checked={tpl.enabled} onChange={(enabled) => onChange({ enabled })} />
      </div>
      {tpl.enabled ? (
        <div className={styles.cols}>
          <div className={styles.fields}>
            <Field label={t.templateSms(name)} multiline rows={3} value={tpl.sms} onChange={(event) => onChange({ sms: event.target.value })} help={t.smsLength(tpl.sms.length)} />
            <Field label={t.templateSubject(name)} value={tpl.emailSubject} onChange={(event) => onChange({ emailSubject: event.target.value })} />
            <Field label={t.templateBody(name)} multiline rows={4} value={tpl.emailBody} onChange={(event) => onChange({ emailBody: event.target.value })} />
          </div>
          <div className={styles.preview} aria-label={t.previewTitle}>
            <span className="bo-foot">{t.previewTitle}</span>
            <span className="bo-foot">{t.previewText}</span>
            <p className={styles.bubble} data-testid={'preview-sms-' + tpl.stage}>
              {fillTemplate(tpl.sms, SAMPLE)}
            </p>
            <span className="bo-foot">{t.previewEmail}</span>
            <p className={styles.bubble}>
              <b>{fillTemplate(tpl.emailSubject, SAMPLE)}</b>
              <br />
              {fillTemplate(tpl.emailBody, SAMPLE)}
            </p>
            <span className="bo-foot">{t.previewSample}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
