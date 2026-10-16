import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { JobView, ProposalOptionView, ProposalStatus, ProposalView } from '@roofline/shared';
import { Button, Icon, Panel, Tag, UiLink, useToast, type IconName, type TagTone } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { job } from '../../copy/job.ts';
import { proposals } from '../../copy/proposals.ts';
import { useMeasure } from '../estimator/api.ts';
import { EmptyPanel, LoadError, RowsSkeleton } from '../jobs/states.tsx';
import { useCompanyZone } from '../jobs/useCompanyToday.ts';
import { useCopyLink } from '../proposals/api.ts';
import { formatLastOpened, formatWhen } from '../proposals/format.ts';
import { useJobProposals } from './api.ts';
import styles from './JobProposals.module.css';

/** The option the pages call out: the one most people choose. The measure screen follows the same rule. */
const RECOMMENDED_TIER = 'better';

/** The status tag: its tone, and the glyph that goes with the word so the status is never only a colour. */
const STATUS_TAG: Record<ProposalStatus, { tone: TagTone; icon: IconName }> = {
  draft: { tone: 'neutral', icon: 'pen' },
  ready: { tone: 'tape', icon: 'clock' },
  sent: { tone: 'info', icon: 'arrow' },
  viewed: { tone: 'info', icon: 'doc' },
  signed: { tone: 'ok', icon: 'check' },
  declined: { tone: 'warn', icon: 'x' },
  expired: { tone: 'warn', icon: 'alert' },
  replaced: { tone: 'neutral', icon: 'refresh' },
};

/** The lowest enabled option's total as a line, or null when there is none. Instant numbers say Estimate. */
function proposalFromText(proposal: ProposalView): string | null {
  const totals = proposal.options.filter((option) => option.enabled).map((option) => option.totalCents);
  if (totals.length === 0) return null;
  const money = proposals.money(Math.min(...totals));
  return proposal.basis === 'exact' ? job.proposalExactFrom(money) : job.proposalFrom(money);
}

/** "Sent", or "Opened 2×" once the customer has looked: the word, a glyph and a tone. */
function StatusTag({ proposal }: { proposal: ProposalView }) {
  const { tone, icon } = STATUS_TAG[proposal.status];
  const opened = proposal.status === 'viewed' && proposal.views.count > 0;
  return (
    <Tag tone={tone} icon={icon}>
      {opened ? job.openedTag(proposal.views.count) : proposals.statusLabelFor(proposal.status)}
    </Tag>
  );
}

/** One option as a tile: its tier, its price in Archivo, what it is. The recommended one is ringed, tinted and says so. */
function TierTile({ option, showPrice }: { option: ProposalOptionView; showPrice: boolean }) {
  const recommended = option.tier === RECOMMENDED_TIER;
  return (
    <li className={styles.tile} data-recommended={recommended ? 'true' : undefined} data-tier={option.tier}>
      <span className={styles.tier}>{proposals.tierName[option.tier]}</span>
      {showPrice ? <span className={styles.price}>{proposals.money(option.totalCents)}</span> : null}
      <span className={styles.spec}>{option.name}</span>
      {recommended ? (
        <Tag tone="brand" icon="star" className={styles.recommended}>
          {job.recommended}
        </Tag>
      ) : null}
    </li>
  );
}

/** What has happened to the proposal, from the facts the server keeps: sent, opened, signed or declined. */
function ProposalEvents({ proposal }: { proposal: ProposalView }) {
  const zone = useCompanyZone();
  const now = new Date();
  const lines: { key: string; icon: IconName; text: string }[] = [];
  if (proposal.sentAt !== null) lines.push({ key: 'sent', icon: 'arrow', text: proposals.sentOn(formatWhen(proposal.sentAt, now, zone)) });
  if (proposal.views.count > 0 && proposal.views.last !== null) {
    lines.push({ key: 'opened', icon: 'doc', text: proposals.eventsLine(proposal.views.count, formatLastOpened(proposal.views.last, now, zone)) });
  } else if (proposal.sentAt !== null) {
    lines.push({ key: 'unopened', icon: 'clock', text: proposals.eventsNone });
  }
  if (proposal.signed !== null) {
    lines.push({ key: 'signed', icon: 'check', text: proposals.signedLine(proposal.signed.name, formatWhen(proposal.signed.at, now, zone)) });
  }
  if (proposal.declined !== null) {
    lines.push({ key: 'declined', icon: 'x', text: proposals.declinedLine(formatWhen(proposal.declined.at, now, zone)) });
    if (proposal.declined.reason !== null && proposal.declined.reason !== '') {
      lines.push({ key: 'reason', icon: 'msg', text: proposals.declinedReason(proposal.declined.reason) });
    }
  }
  if (lines.length === 0) return null;
  return (
    <ul className={styles.events}>
      {lines.map((line) => (
        <li key={line.key}>
          <Icon name={line.icon} size={16} />
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

type RowProps = { proposal: ProposalView; open: boolean; seeValue: boolean; canCopy: boolean };

/** One proposal: its number, status and lowest price as a link, Copy link beside it, and (for the newest) its options. */
function ProposalRow({ proposal, open, seeValue, canCopy }: RowProps) {
  const copyLink = useCopyLink(proposal.id);
  const from = seeValue ? proposalFromText(proposal) : null;
  const enabled = proposal.options.filter((option) => option.enabled);
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <UiLink href={'/estimator/proposals/' + proposal.id} className={styles.link} data-status={proposal.status}>
          <span className={styles.number}>{proposal.number}</span>
          <StatusTag proposal={proposal} />
          {from !== null ? <span className={styles.from}>{from}</span> : null}
          <Icon name="chev" size={16} className={styles.chev} />
        </UiLink>
        {canCopy ? (
          <Button variant="default" size="sm" busy={copyLink.isPending} onClick={() => copyLink.mutate()}>
            {proposals.copyLink}
          </Button>
        ) : null}
      </div>
      {open && enabled.length > 0 ? (
        <ul aria-label={job.tiersLabel} className={styles.tiers}>
          {enabled.map((option) => (
            <TierTile key={option.id} option={option} showPrice={seeValue} />
          ))}
        </ul>
      ) : null}
      {open ? <ProposalEvents proposal={proposal} /> : null}
    </li>
  );
}

export type ProposalsPanelProps = { view: JobView; className?: string };

/** The job's proposals, newest first. The newest opens out: Good, Better and Best as tiles, then who has opened it. */
export function ProposalsPanel({ view, className }: ProposalsPanelProps) {
  const jobId = view.job.id;
  const navigate = useNavigate();
  const toast = useToast();
  const measure = useMeasure();
  const query = useJobProposals(jobId);
  const me = useMe();
  const canCopyLinks = me.data?.role === 'owner' || me.data?.role === 'office';

  async function startProposal() {
    try {
      const measurement = await measure.mutateAsync({ propertyId: view.home.id });
      // Ruling EM: the measure window builds the proposal on this job
      navigate('/estimator/measure/' + measurement.id, { state: { jobId } });
    } catch {
      toast.show(job.proposalStartFailed, 'error');
    }
  }

  const list = query.data ?? [];
  const listed = query.isSuccess && list.length > 0;
  let body: ReactNode;
  if (query.isPending) {
    body = <RowsSkeleton rows={2} />;
  } else if (query.isError) {
    body = <LoadError tag={job.errorTag} title={job.proposalsLoadFailed} retry={job.retry} busy={query.isFetching} onRetry={() => void query.refetch()} />;
  } else if (list.length === 0) {
    body = <EmptyPanel variant="inline" title={job.proposalsEmpty} body={job.proposalsEmptyBody} />;
  } else {
    body = (
      <ul className={styles.list}>
        {list.map((proposal, index) => (
          <ProposalRow
            key={proposal.id}
            proposal={proposal}
            open={index === 0}
            seeValue={view.can.seeValue}
            canCopy={canCopyLinks && proposal.status !== 'draft'}
          />
        ))}
      </ul>
    );
  }

  return (
    <Panel
      title={job.proposalsTitle}
      className={className}
      padded={!listed}
      actions={
        view.can.edit ? (
          <Button variant="default" size="sm" busy={measure.isPending} onClick={() => void startProposal()}>
            <Icon name="plus" size={16} />
            {job.newProposal}
          </Button>
        ) : undefined
      }
    >
      {body}
    </Panel>
  );
}

/**
 * The roof the newest proposal was priced from: its area in squares, the pitch and what to order with waste. Drawn only
 * from the proposal's own numbers, so a job with no proposal has no roof card. An exact report says so; anything else
 * says Estimate.
 */
export function RoofPanel({ jobId, className }: { jobId: string; className?: string }) {
  const query = useJobProposals(jobId);
  const proposal = query.data?.[0];
  const option =
    proposal?.options.find((candidate) => candidate.enabled && candidate.tier === RECOMMENDED_TIER) ??
    proposal?.options.find((candidate) => candidate.enabled);
  if (proposal === undefined || option === undefined) return null;

  const { scope, calculation } = option;
  const stats: { label: string; value: string }[] = [
    { label: job.roofArea, value: job.squares(calculation.roofSquares) },
    { label: job.roofPitch, value: job.pitchValue(scope.pitch) },
    { label: job.roofOrder(scope.wastePercent), value: job.squares(calculation.orderedSquares) },
  ];
  if (scope.ridgeFt > 0) stats.push({ label: job.roofRidge, value: job.feet(scope.ridgeFt) });
  if (scope.edgeFt > 0) stats.push({ label: job.roofEdge, value: job.feet(scope.edgeFt) });
  if (scope.valleyFt > 0) stats.push({ label: job.roofValley, value: job.feet(scope.valleyFt) });

  return (
    <Panel
      title={job.roofTitle}
      className={className}
      tag={
        proposal.basis === 'exact' ? (
          <Tag tone="ok" icon="check">
            {job.roofExact}
          </Tag>
        ) : (
          <Tag>{job.roofEstimate}</Tag>
        )
      }
    >
      <dl className={styles.stats}>
        {stats.map((stat) => (
          <div key={stat.label} className={styles.stat}>
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
