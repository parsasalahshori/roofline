import { useId, useState } from 'react';
import { useParams } from 'react-router';
import type { ProposalView } from '@roofline/shared';
import { Banner, Button, Field, Icon, Panel, Segmented, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { proposals } from '../../copy/proposals.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { DetailPage } from '../jobs/DetailPage.tsx';
import { EmptyPanel, LoadError } from '../jobs/states.tsx';
import { useCompany } from '../settings/api.ts';
import {
  proposalPdfUrl,
  useCopyLink,
  usePatchProposal,
  usePricebook,
  useProposal,
  useReviseProposal,
  useSendProposal,
} from './api.ts';
import { formatDay } from './format.ts';
import { OptionCard } from './OptionCard.tsx';
import { ProposalEvents, proposalEventLines } from './ProposalEvents.tsx';
import { StatusTag } from './StatusTag.tsx';
import { RECOMMENDED_TIER } from './tiers.ts';
import styles from './ProposalWindow.module.css';

const JOBS_CRUMB = { label: WINDOW_COPY.jobs.title, href: '/jobs' } as const;

/** The text message; edits stay local and save when the field loses focus with a changed value. */
function MessageBox({ body, editable, onCommit }: { body: string; editable: boolean; onCommit: (body: string) => void }) {
  const [draft, setDraft] = useState(body);
  return (
    <Panel title={proposals.messageHeading} className={styles.message}>
      {editable ? (
        <Field
          multiline
          rows={4}
          label={proposals.messageLabel}
          help={proposals.messageHelp}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== body) onCommit(draft);
          }}
        />
      ) : (
        <p className={styles.messageText}>{body}</p>
      )}
    </Panel>
  );
}

function ProposalBody({ proposal }: { proposal: ProposalView }) {
  const id = proposal.id;
  const phone = useIsPhone();
  const [resets, setResets] = useState<Record<string, number>>({});
  const company = useCompany();
  const pricebook = usePricebook();
  const patch = usePatchProposal(id, (failed) => {
    const ids = failed.options?.map((o) => o.id) ?? [];
    if (ids.length > 0) {
      setResets((r) => {
        const next = { ...r };
        for (const optionId of ids) next[optionId] = (next[optionId] ?? 0) + 1;
        return next;
      });
    }
  });
  const send = useSendProposal(id);
  const copyLink = useCopyLink(id);
  const revise = useReviseProposal(id);

  const timeZone = company.data?.timezone;
  const status = proposal.status;
  const editable = proposal.canEdit && status === 'draft';
  const prices = pricebook.data?.prices ?? null;
  const canRevise = ['sent', 'viewed', 'ready', 'declined', 'expired'].includes(status);
  const canCopyLink = ['sent', 'viewed', 'signed', 'declined', 'expired'].includes(status);

  // On a phone one option shows at a time, chosen from three tabs; the one the customer signed first, else the
  // recommended one. All stay mounted so a change that has not been saved yet is not lost when the tab is left.
  const signedId = proposal.signed?.optionId ?? null;
  const firstShown =
    (proposal.options.find((option) => option.id === signedId) ??
      proposal.options.find((option) => option.tier === RECOMMENDED_TIER) ??
      proposal.options[0])?.id ?? '';
  const [picked, setPicked] = useState(firstShown);
  const shown = proposal.options.some((option) => option.id === picked) ? picked : firstShown;

  // A desktop's rows are one radio group: they share a name, so the arrow keys move the pick
  const radioName = useId();

  const events = proposalEventLines(proposal, new Date(), timeZone);

  return (
    <DetailPage
      app="estimator"
      title={proposals.title(proposal.number)}
      crumbs={[JOBS_CRUMB, { label: proposal.customer.name, href: `/jobs/${proposal.jobId}` }, { label: proposal.number }]}
      subtitle={
        <span className={styles.meta}>
          <StatusTag proposal={proposal} />
          <span>{proposals.customerLine(proposal.customer.name, proposal.address)}</span>
          <span>{proposals.validUntil(formatDay(proposal.validUntil))}</span>
          {proposal.basis === 'exact' ? <span>{proposals.basisExactNote}</span> : null}
        </span>
      }
      actions={
        <div className={styles.actions}>
          <Button href={proposalPdfUrl(id)} variant="default">
            <Icon name="doc" size={16} />
            {proposals.downloadPdf}
          </Button>
          {canCopyLink ? (
            <Button variant="default" busy={copyLink.isPending} onClick={() => copyLink.mutate()}>
              {proposals.copyLink}
            </Button>
          ) : null}
          {canRevise ? (
            <Button variant="default" busy={revise.isPending} onClick={() => revise.mutate()}>
              {proposals.makeRevised}
            </Button>
          ) : null}
          {editable ? (
            <Button variant="primary" busy={send.isPending} onClick={() => send.mutate()}>
              <Icon name="arrow" size={16} />
              {proposals.send}
            </Button>
          ) : null}
        </div>
      }
    >
      {!editable && status !== 'draft' && status !== 'replaced' ? (
        <div className={styles.notice}>
          <Banner
            tone="info"
            action={
              status === 'ready' && proposal.taskId ? (
                <Button variant="default" size="sm" href={`/approvals/${proposal.taskId}`}>
                  {proposals.waitingForOk}
                </Button>
              ) : undefined
            }
          >
            {proposals.noteFor(status)}
          </Banner>
        </div>
      ) : null}
      {proposal.replacedById ? (
        <div className={styles.notice}>
          <Banner
            tone="info"
            action={
              <Button variant="default" size="sm" href={`/estimator/proposals/${proposal.replacedById}`}>
                {proposals.openReplacement}
              </Button>
            }
          >
            {proposals.replacedNote}
          </Banner>
        </div>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.main}>
          {phone ? (
            <Segmented
              className={styles.tabs}
              label={proposals.tiersLabel}
              value={shown}
              onChange={setPicked}
              options={proposal.options.map((option) => ({
                value: option.id,
                label: proposals.tierName[option.tier],
                count: proposals.money(option.totalCents),
              }))}
            />
          ) : null}
          <div className={styles.options} role={phone ? undefined : 'radiogroup'} aria-label={phone ? undefined : proposals.tiersLabel}>
            {proposal.options.map((option) => (
              <div key={`${option.id}:${resets[option.id] ?? 0}`} className={styles.option} hidden={phone && option.id !== shown}>
                <OptionCard
                  option={option}
                  editable={editable}
                  basis={proposal.basis}
                  prices={prices}
                  open={option.id === shown}
                  signed={option.id === signedId}
                  onSelect={phone ? undefined : () => setPicked(option.id)}
                  radioName={radioName}
                  onChange={(change) => patch.mutate({ options: [{ id: option.id, ...change }] })}
                />
              </div>
            ))}
          </div>
        </div>

        <div className={styles.side}>
          {events.length > 0 ? (
            <Panel title={proposals.activityHeading}>
              <ProposalEvents lines={events} />
            </Panel>
          ) : null}
          <MessageBox
            key={proposal.messageBody}
            body={proposal.messageBody}
            editable={editable}
            onCommit={(messageBody) => patch.mutate({ messageBody })}
          />
        </div>
      </div>
    </DetailPage>
  );
}

/** The panels' shape while the proposal loads: the options at the left, the activity and the message at the right. */
function ProposalSkeleton() {
  return (
    <div role="status" aria-label={proposals.pageTitle} aria-busy="true" className={styles.grid}>
      <div className={styles.main}>
        {[0, 1, 2].map((row) => (
          <div key={row} className={styles.skeletonPanel}>
            <Skeleton lines={2} height="24px" />
          </div>
        ))}
      </div>
      <div className={styles.side}>
        <div className={styles.skeletonPanel}>
          <Skeleton lines={4} />
        </div>
      </div>
    </div>
  );
}

/** The proposal page: its head, the three options, who has opened it, the text message and the actions. */
export function ProposalWindow() {
  const { proposalId = '' } = useParams();
  const query = useProposal(proposalId);

  if (query.data !== undefined) return <ProposalBody key={query.data.id} proposal={query.data} />;

  const crumbs = [JOBS_CRUMB, { label: proposals.pageTitle }];
  return (
    <DetailPage app="estimator" title={proposals.pageTitle} crumbs={crumbs}>
      {query.error instanceof ApiError && query.error.status === 404 ? (
        <EmptyPanel
          title={proposals.notFound}
          ghost="none"
          action={
            <Button variant="default" href="/jobs">
              {proposals.backToJobs}
            </Button>
          }
        />
      ) : query.isError ? (
        <LoadError tag={proposals.errorTag} title={proposals.loadFailed} retry={proposals.retry} busy={query.isFetching} onRetry={() => void query.refetch()} />
      ) : (
        <ProposalSkeleton />
      )}
    </DetailPage>
  );
}
