import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { JobCard, JobStage } from '@roofline/shared';
import { Button, Icon, StageMenu, useToast, type StageMenuExtra, type StageMenuStage } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { jobs } from '../../copy/jobs.ts';
import { useArchiveJob } from '../job/api.ts';
import { useMoveJob } from './api.ts';
import { MoveJobSheet } from './MoveJobSheet.tsx';
import styles from './MoveJobMenu.module.css';

export type MoveJobMenuProps = {
  job: JobCard;
  onMoved?: () => void;
  /** The chevron alone, the caret of a card's split button. Without it the trigger says "Move to…". */
  compact?: boolean;
  /** The job is archived now (the Archived view): the menu offers Restore, not Archive. */
  archived?: boolean;
  /** A split button: "Move to {next stage}" for the common step, with the chevron menu beside it. Used on a board card. */
  split?: boolean;
  /** The split button of a page head: the quick move is graphite and full height, with the chevron the same height. */
  prominent?: boolean;
};

/** The stages in pipeline order. Installed is only offered from Won (Decision 2). */
const STAGE_ORDER: readonly Exclude<JobStage, 'lost'>[] = ['lead', 'inspection', 'proposal', 'won', 'installed'];

const STAGE_COLOR: Record<Exclude<JobStage, 'lost'>, string> = {
  lead: 'var(--st-lead)',
  inspection: 'var(--st-insp)',
  proposal: 'var(--st-prop)',
  won: 'var(--st-won)',
  installed: 'var(--st-inst)',
};

/**
 * "Move to…" for one job: a menu of the stages (number keys 1 to 5), then Lost (L) and Archive (E).
 * Lost opens the sheet that asks why, Won without a value asks for it, anything else moves at once and
 * says so in a toast with Undo.
 */
export function MoveJobMenu({ job, onMoved, compact = false, archived, split = false, prominent = false }: MoveJobMenuProps) {
  const move = useMoveJob();
  const archive = useArchiveJob(job.id);
  const toast = useToast();
  const me = useMe();
  const [params] = useSearchParams();
  const [sheetTo, setSheetTo] = useState<'lost' | 'won' | null>(null);

  const inArchive = archived ?? params.get('archived') === 'true';
  // The same rule the server applies (a rep archives their own jobs only)
  const canArchive = me.data !== undefined && (me.data.role !== 'rep' || job.assigned?.userId === me.data.user.id);

  const stages: StageMenuStage[] = STAGE_ORDER.filter(
    (stage) => stage !== 'installed' || job.stage === 'won' || job.stage === 'installed',
  ).map((stage) => ({ key: stage, label: jobs.stage[stage], color: STAGE_COLOR[stage] }));

  const extras: StageMenuExtra[] = [];
  if (job.stage !== 'lost') extras.push({ key: 'lost', label: jobs.stage.lost, shortcut: 'L', tone: 'bad' });
  if (canArchive) {
    extras.push({ key: 'archive', label: inArchive ? jobs.restoreOption : jobs.archiveOption, shortcut: 'E' });
  }

  async function changeArchive(next: boolean) {
    try {
      await archive.mutateAsync(next);
    } catch (error) {
      toast.show(error instanceof ApiError && error.message !== '' ? error.message : jobs.moveFailed, 'error');
      return;
    }
    toast.show(next ? jobs.archivedJob(job.customerName) : jobs.restoredJob(job.customerName), 'success', {
      action: { label: jobs.undo, onClick: () => archive.mutate(!next) },
    });
    onMoved?.();
  }

  async function choose(to: string) {
    if (to === 'archive') {
      await changeArchive(!inArchive);
      return;
    }
    if (to === 'lost') {
      setSheetTo('lost');
      return;
    }
    if (to === 'won' && (job.valueCents === null || job.valueCents === 0)) {
      setSheetTo('won');
      return;
    }
    try {
      await move.mutateAsync({ jobId: job.id, to: to as JobStage, undo: { name: job.customerName, from: job.stage } });
    } catch {
      return; // the toast has said why
    }
    onMoved?.();
  }

  // The step after this one, for the quick button: Installed comes only after Won, and nothing follows Installed or Lost
  const stepIndex = STAGE_ORDER.indexOf(job.stage as (typeof STAGE_ORDER)[number]);
  const nextStage = split && stepIndex >= 0 ? (STAGE_ORDER[stepIndex + 1] ?? null) : null;

  const menu = (
    <StageMenu
      label={jobs.moveTo}
      heading={jobs.moveHeading(job.customerName)}
      stages={stages}
      current={job.stage}
      extras={extras}
      showLabel={!compact && !split}
      className={prominent ? styles.tall : undefined}
      onPick={(key) => void choose(key)}
    />
  );

  return (
    <>
      {split ? (
        <div className={styles.split}>
          {nextStage !== null ? (
            <Button
              variant={prominent ? 'ink' : 'default'}
              size={prominent ? 'md' : 'sm'}
              className={styles.quick}
              data-part="quick"
              busy={move.isPending}
              onClick={() => void choose(nextStage)}
            >
              <span className={styles.quickText}>{jobs.moveToStage(jobs.stage[nextStage])}</span>
              <Icon name="arrow" size={16} />
            </Button>
          ) : null}
          {menu}
        </div>
      ) : (
        menu
      )}
      {sheetTo !== null ? (
        <MoveJobSheet
          job={job}
          to={sheetTo}
          onDone={() => {
            setSheetTo(null);
            onMoved?.();
          }}
        />
      ) : null}
    </>
  );
}
