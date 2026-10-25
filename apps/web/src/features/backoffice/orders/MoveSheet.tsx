import { HOMEOWNER_STAGE_FOR, ORDER_STAGES, type BackofficeOrder, type OrderStage } from '@roofline/shared';
import { Banner, Button, Field, Select, Toggle, useToast } from '@roofline/ui';
import { useState } from 'react';
import { useMe } from '../../../api/hooks.ts';
import { ApiError } from '../../../api/client.ts';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import { AppleSheet } from '../AppleSheet.tsx';
import { useBackofficeSettings, useMoveOrder } from '../api.ts';
import { formatDay, stageName } from '../format.ts';
import { fillTemplate, firstName, STAGES_WITH_DATE } from './messages.ts';
import styles from './orders.module.css';

const t = copy.orders;

export type MoveSheetProps = {
  order: BackofficeOrder;
  open: boolean;
  /** The stage it opens on (the next one for "Move to next stage"); left out, the person picks. */
  initialStage: OrderStage | null;
  onClose: () => void;
};

/** Mounted only while open, so each opening starts with a clean form. */
export function MoveSheet(props: MoveSheetProps) {
  return props.open ? <Form {...props} /> : null;
}

function Form({ order, initialStage, onClose }: MoveSheetProps) {
  const settings = useBackofficeSettings();
  const me = useMe();
  const toast = useToast();
  const move = useMoveOrder(order.id);
  const choices = ORDER_STAGES.filter((stage) => stage !== order.stage);
  const [stage, setStage] = useState<OrderStage>(initialStage ?? ORDER_STAGES[ORDER_STAGES.indexOf(order.stage) + 1] ?? choices[0]!);
  const [note, setNote] = useState('');
  const [plannedFor, setPlannedFor] = useState('');
  const template = settings.data?.templates.find((tpl) => tpl.stage === stage);
  const hasMessage = template?.enabled === true;
  const [notifyChoice, setNotifyChoice] = useState(true);
  const notify = hasMessage && notifyChoice;
  const needsDate = STAGES_WITH_DATE.includes(stage);

  const values = {
    first: firstName(order.customerName),
    date: needsDate && plannedFor !== '' ? formatDay(plannedFor) : t.datePlaceholder,
    company: me.data?.company.name ?? '',
  };
  const error = move.error instanceof ApiError ? move.error.message : move.isError ? t.moveFailed : null;
  const appStage = copy.homeownerStages[HOMEOWNER_STAGE_FOR[stage]];

  function submit() {
    move.mutate(
      { stage, note: note.trim(), plannedFor: needsDate && plannedFor !== '' ? plannedFor : null, notify },
      {
        onSuccess: () => {
          toast.show(t.moved(stageName(stage)), 'success');
          onClose();
        },
      },
    );
  }

  return (
    <AppleSheet
      open
      title={t.moveTitle}
      onClose={onClose}
      closeLabel={t.moveCancel}
      footer={
        <Button variant="primary" busy={move.isPending} onClick={submit}>
          {move.isPending ? t.moveSubmitting : t.moveSubmit}
        </Button>
      }
    >
      <div className={styles.sheetBody}>
        <Select label={t.moveStage} value={stage} onChange={(value) => setStage(value as OrderStage)} options={choices.map((s) => ({ value: s, label: stageName(s) }))} />
        {needsDate ? <Field label={t.movePlanned} help={t.movePlannedHelp} type="date" value={plannedFor} onChange={(event) => setPlannedFor(event.target.value)} /> : null}
        <Field label={t.moveNote} help={t.moveNoteHelp} multiline rows={2} value={note} onChange={(event) => setNote(event.target.value)} />

        <div className={styles.notifyRow}>
          <span>
            <b>{t.moveNotify}</b>
            <br />
            <small className="bo-foot">{hasMessage ? (notify ? t.movePreviewTitle : t.moveNotifyOff) : t.moveNoTemplate}</small>
          </span>
          <Toggle label={t.moveNotify} labelHidden checked={notify} disabled={!hasMessage} onChange={setNotifyChoice} />
        </div>

        {notify && template ? (
          <section className={styles.preview} aria-label={t.movePreviewTitle}>
            <h3 className="bo-grouphead">{t.movePreviewTitle}</h3>
            <span className="bo-foot">{t.movePreviewText}</span>
            <p className={styles.bubble}>{fillTemplate(template.sms, values)}</p>
            <span className="bo-foot">{t.movePreviewEmailSubject}</span>
            <p className={styles.bubble}>{fillTemplate(template.emailSubject, values)}</p>
            <span className="bo-foot">{t.movePreviewEmail}</span>
            <p className={styles.bubble}>{fillTemplate(template.emailBody, values)}</p>
          </section>
        ) : null}

        <section className={styles.preview} aria-label={t.moveAppTitle}>
          <h3 className="bo-grouphead">{t.moveAppTitle}</h3>
          <p>{t.moveAppLine(appStage)}</p>
        </section>

        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </AppleSheet>
  );
}
