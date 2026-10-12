import { useState } from 'react';
import { useParams } from 'react-router';
import type { ProposalView } from '@roofline/shared';
import { Banner, Button, Card, EmptyState, Field, Pill, Skeleton } from '@roofline/ui';
import { proposals } from '../../copy/proposals.ts';
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
import { formatLastOpened, formatWhen } from './format.ts';
import { OptionCard } from './OptionCard.tsx';
import styles from './ProposalWindow.module.css';

/** The text message; edits stay local and save when the field loses focus with a changed value. */
function MessageBox({ body, editable, onCommit }: { body: string; editable: boolean; onCommit: (body: string) => void }) {
  const [draft, setDraft] = useState(body);
  return (
    <section className={styles.message}>
      <h2 className={styles.heading}>{proposals.messageHeading}</h2>
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
    </section>
  );
}

function ProposalBody({ proposal }: { proposal: ProposalView }) {
  const id = proposal.id;
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
  const now = new Date();
  const status = proposal.status;
  const editable = proposal.canEdit && status === 'draft';
  const prices = pricebook.data?.prices ?? null;
  const canRevise = status === 'sent' || status === 'viewed' || status === 'ready';

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{proposals.title(proposal.number)}</h1>
          <Pill tone="neutral">{proposals.statusLabelFor(status)}</Pill>
        </div>
        <p className={styles.meta}>{proposals.customerLine(proposal.customer.name, proposal.address)}</p>
        <p className={styles.meta}>{proposals.validUntil(proposal.validUntil)}</p>
        {proposal.basis === 'exact' ? <p className={styles.meta}>{proposals.basisExactNote}</p> : null}
      </header>

      {!editable && status !== 'draft' ? <Banner tone="info">{proposals.readOnlyNote}</Banner> : null}
      {proposal.replacedById ? (
        <Banner
          tone="info"
          action={
            <Button variant="ghost" href={`/estimator/proposals/${proposal.replacedById}`}>
              {proposals.openReplacement}
            </Button>
          }
        >
          {proposals.replacedNote}
        </Banner>
      ) : null}

      <div className={styles.options}>
        {proposal.options.map((option) => (
          <OptionCard
            key={`${option.id}:${resets[option.id] ?? 0}`}
            option={option}
            editable={editable}
            basis={proposal.basis}
            prices={prices}
            onChange={(change) => patch.mutate({ options: [{ id: option.id, ...change }] })}
          />
        ))}
      </div>

      <Card className={styles.events}>
        {proposal.views.count > 0 && proposal.views.last ? (
          <p>{proposals.eventsLine(proposal.views.count, formatLastOpened(proposal.views.last, now, timeZone))}</p>
        ) : proposal.sentAt ? (
          <>
            <p>{proposals.sentOn(formatWhen(proposal.sentAt, now, timeZone))}</p>
            <p>{proposals.eventsNone}</p>
          </>
        ) : null}
        {proposal.signed ? <p>{proposals.signedLine(proposal.signed.name, formatWhen(proposal.signed.at, now, timeZone))}</p> : null}
        {proposal.declined ? (
          <>
            <p>{proposals.declinedLine(formatWhen(proposal.declined.at, now, timeZone))}</p>
            {proposal.declined.reason ? <p>{proposals.declinedReason(proposal.declined.reason)}</p> : null}
          </>
        ) : null}
      </Card>

      <MessageBox
        key={proposal.messageBody}
        body={proposal.messageBody}
        editable={editable}
        onCommit={(messageBody) => patch.mutate({ messageBody })}
      />

      <div className={styles.actions}>
        {editable ? (
          <Button busy={send.isPending} onClick={() => send.mutate()}>
            {proposals.send}
          </Button>
        ) : null}
        {status !== 'draft' ? (
          <Button variant="ghost" busy={copyLink.isPending} onClick={() => copyLink.mutate()}>
            {proposals.copyLink}
          </Button>
        ) : null}
        <Button variant="ghost" href={proposalPdfUrl(id)}>
          {proposals.downloadPdf}
        </Button>
        {canRevise ? (
          <Button variant="ghost" busy={revise.isPending} onClick={() => revise.mutate()}>
            {proposals.makeRevised}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The proposal window: header, the three options, who opened it, the text message and the actions. */
export function ProposalWindow() {
  const { proposalId = '' } = useParams();
  const query = useProposal(proposalId);

  if (query.isPending) {
    return (
      <div className={styles.loading}>
        <Skeleton height="2rem" width="50%" />
        <Skeleton lines={4} />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <EmptyState
        title={proposals.loadFailed}
        action={
          <Button variant="ghost" onClick={() => void query.refetch()}>
            {proposals.retry}
          </Button>
        }
      />
    );
  }
  return <ProposalBody proposal={query.data} />;
}
