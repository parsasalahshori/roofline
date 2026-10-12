import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Button, Card, EmptyState, Skeleton } from '@roofline/ui';
import type { PublicProposalView } from '@roofline/shared';
import { homeowner, money } from '../../copy/homeowner.ts';
import { SignFlow } from './SignFlow.tsx';
import { DeclineSheet } from './DeclineSheet.tsx';
import { usePublicProposal, useRecordView, signedPdfUrl } from './api.ts';
import styles from './HomeownerPage.module.css';

type Option = PublicProposalView['options'][number];

/** The date part of a date-only (or ISO) value, the way a homeowner reads it. UTC keeps a bare date from sliding back a day. */
const formatDate = (value: string): string => new Date(value).toLocaleDateString('en-US', { timeZone: 'UTC' });

/** A moment in the homeowner's own time zone, as a date. */
const formatSigned = (value: string): string => new Date(value).toLocaleDateString('en-US');

/** 875 basis points become "8.75"; a whole rate drops its zeros, so 900 becomes "9". */
const formatApr = (aprBps: number): string => (aprBps / 100).toFixed(2).replace(/\.?0+$/, '');

/** The company's phone from a 410 body, when the body carries a usable one. */
function latestPhone(latest: unknown): string | null {
  if (typeof latest !== 'object' || latest === null) return null;
  const phone = (latest as { companyPhone?: unknown }).companyPhone;
  return typeof phone === 'string' && phone.length > 0 ? phone : null;
}

/**
 * The public proposal a homeowner opens from a link. No session and no shell: the route mounts it
 * alone, and it is never indexed. Only the company's own proposal is shown, totals only, never unit prices.
 */
export function HomeownerPage() {
  const params = useParams();
  const token = params.token ?? '';
  const query = usePublicProposal(token);
  useRecordView(token, query.isSuccess);

  const [chosenOptionId, setChosenOptionId] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);

  // noindex and the tab title belong to this page only: the previous values come back on leaving.
  useEffect(() => {
    const previousTitle = document.title;
    document.title = homeowner.pageTitle;
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const meta = existing ?? document.createElement('meta');
    const previousContent = existing?.getAttribute('content') ?? null;
    if (existing === null) {
      meta.name = 'robots';
      document.head.appendChild(meta);
    }
    meta.content = 'noindex';
    return () => {
      document.title = previousTitle;
      if (existing === null) meta.remove();
      else if (previousContent !== null) meta.setAttribute('content', previousContent);
    };
  }, []);

  if (query.isPending) {
    return (
      <main className={styles.page}>
        <div className={styles.column}>
          <div className={styles.loading}>
            <p className={styles.text} role="status">{homeowner.loading}</p>
            <Skeleton lines={3} />
          </div>
        </div>
      </main>
    );
  }

  if (query.isError) {
    const status = query.error?.status;
    if (status === 404) {
      return (
        <main className={styles.page}>
          <div className={styles.column}>
            <EmptyState title={homeowner.goneTitle} body={homeowner.goneBody} />
          </div>
        </main>
      );
    }
    if (status === 410) {
      const phone = latestPhone(query.error?.latest);
      return (
        <main className={styles.page}>
          <div className={styles.column}>
            <EmptyState
              title={homeowner.expiredTitle}
              body={homeowner.goneBody}
              action={phone ? <Button variant="ghost" href={`tel:${phone}`}>{phone}</Button> : undefined}
            />
          </div>
        </main>
      );
    }
    return (
      <main className={styles.page}>
        <div className={styles.column}>
          <EmptyState
            title={homeowner.loadFailed}
            action={<Button variant="ghost" onClick={() => void query.refetch()}>{homeowner.tryAgain}</Button>}
          />
        </div>
      </main>
    );
  }

  const proposal = query.data;
  const phone = proposal.companyPhone;
  const callLink = phone ? <Button variant="ghost" href={`tel:${phone}`}>{homeowner.callUs(proposal.companyName)}</Button> : null;
  const chosen = chosenOptionId === null ? null : proposal.options.find((option) => option.id === chosenOptionId) ?? null;

  const header = (
    <header className={styles.header}>
      <p className={styles.company}>{proposal.companyName}</p>
      <p className={styles.text}>{homeowner.forAddress(proposal.address)}</p>
    </header>
  );

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        {header}

        {proposal.status === 'open' ? (
          <>
            <div className={styles.header}>
              <h1 className={styles.title}>{homeowner.greeting(proposal.firstName)}</h1>
              <p className={styles.text}>{homeowner.validUntil(formatDate(proposal.validUntil))}</p>
              <p className={styles.text}>{homeowner.chooseOne}</p>
            </div>

            <ul className={styles.options}>
              {proposal.options.map((option: Option) => (
                <li key={option.id}>
                  <Card as="section" className={styles.option} data-testid="option-card" aria-label={option.name}>
                    <div className={styles.optionHead}>
                      <h2 className={styles.optionName}>{option.name}</h2>
                      {option.tier === 'better' ? <span className={styles.badge}>{homeowner.mostPopular}</span> : null}
                    </div>

                    {option.highlights.length > 0 ? (
                      <ul className={styles.list}>
                        {option.highlights.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    ) : null}

                    {option.inclusions.length > 0 ? (
                      <>
                        <h3 className={styles.sectionHeading}>{homeowner.includedHeading}</h3>
                        <ul className={styles.list}>
                          {option.inclusions.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      </>
                    ) : null}

                    <p className={styles.total}>
                      <span className={styles.totalLabel}>{homeowner.totalLabel}</span>
                      <span className={styles.totalValue}>{money(option.totalCents)}</span>
                      {proposal.basis !== 'exact' ? <span className={styles.badgeMuted}>{homeowner.estimateLabel}</span> : null}
                    </p>

                    {option.monthlyEstimateCents !== null && option.financingTerms !== null ? (
                      <p className={styles.monthly}>
                        {homeowner.monthlyLine(
                          money(option.monthlyEstimateCents),
                          option.financingTerms.months,
                          formatApr(option.financingTerms.aprBps),
                        )}
                      </p>
                    ) : null}

                    <Button size="lg" className={styles.choose} onClick={() => setChosenOptionId(option.id)}>
                      {homeowner.chooseOption(option.name)}
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>

            <div className={styles.footer}>
              <Button variant="ghost" onClick={() => setDeclineOpen(true)}>{homeowner.declineLink}</Button>
              {callLink}
            </div>

            <SignFlow
              token={token}
              proposal={proposal}
              optionId={chosen?.id ?? ''}
              open={chosen !== null}
              onClose={() => setChosenOptionId(null)}
              onSigned={() => setChosenOptionId(null)}
            />
            <DeclineSheet
              token={token}
              open={declineOpen}
              onClose={() => setDeclineOpen(false)}
              onDeclined={() => setDeclineOpen(false)}
            />
          </>
        ) : null}

        {proposal.status === 'signed' && proposal.signed !== null ? (
          <Card as="section" className={styles.end}>
            <h1 className={styles.title}>{homeowner.signedTitle}</h1>
            <p className={styles.text}>
              {homeowner.signedBy(
                proposal.signed.name,
                formatSigned(proposal.signed.at),
                proposal.options.find((option) => option.id === proposal.signed?.optionId)?.name ?? '',
              )}
            </p>
            {proposal.signed.pdfReady ? (
              <div className={styles.actions}>
                <Button size="lg" href={signedPdfUrl(token)}>{homeowner.downloadPdf}</Button>
              </div>
            ) : (
              <p className={styles.text}>{homeowner.pdfPreparing}</p>
            )}
          </Card>
        ) : null}

        {proposal.status === 'declined' ? (
          <Card as="section" className={styles.end}>
            <h1 className={styles.title}>{homeowner.declinedTitle}</h1>
            <p className={styles.text}>{homeowner.declinedBody(proposal.companyName)}</p>
            {callLink}
          </Card>
        ) : null}

        {proposal.status === 'expired' ? (
          <Card as="section" className={styles.end}>
            <h1 className={styles.title}>{homeowner.expiredTitle}</h1>
            <p className={styles.text}>{homeowner.expiredBody(proposal.companyName)}</p>
            {callLink}
          </Card>
        ) : null}
      </div>
    </main>
  );
}
