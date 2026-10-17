import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Button, EmptyState, Skeleton } from '@roofline/ui';
import { homeowner, money } from '../../copy/homeowner.ts';
import { quote } from '../../copy/quote.ts';
import { ArrowIcon, CameraIcon, CheckIcon, DocIcon } from '../public/icons.tsx';
import { PublicHeader } from '../public/PublicHeader.tsx';
import { usePublicBrand } from '../public/usePublicBrand.ts';
import { RoofThumb } from '../quote/RoofThumb.tsx';
import { SignFlow } from './SignFlow.tsx';
import { DeclineSheet } from './DeclineSheet.tsx';
import { usePublicProposal, useRecordView, signedPdfUrl } from './api.ts';
import { defaultOption, financingOf, plainDate, roofCard } from './facts.ts';
import type { HomeownerView } from './types.ts';
import styles from './HomeownerPage.module.css';

type Option = HomeownerView['options'][number];

/** A moment in the homeowner's own time zone, as a date ("Oct 12, 2026"). */
const formatSigned = (value: string): string => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** The company's phone from a 410 body, when the body carries a usable one. */
function latestPhone(latest: unknown): string | null {
  if (typeof latest !== 'object' || latest === null) return null;
  const phone = (latest as { companyPhone?: unknown }).companyPhone;
  return typeof phone === 'string' && phone.length > 0 ? phone : null;
}

/**
 * The public proposal a homeowner opens from a link. No session and no shell: the route mounts it
 * alone, and it is never indexed. Only the company's own proposal is shown, totals only, never unit prices.
 * Good, Better and Best are three tiles; the one picked shows its single all-in price, and the main button
 * (the company's colour, the only use of it on the screen) chooses it.
 */
export function HomeownerPage() {
  const params = useParams();
  const token = params.token ?? '';
  const query = usePublicProposal(token);
  useRecordView(token, query.isSuccess);
  // The company's one colour (null: the default blue stays). It is set on the document root, so the sheets, which are
  // portaled to the body, wear it too.
  usePublicBrand(query.data ? (query.data as HomeownerView).accentColor : null);

  const [pickedId, setPickedId] = useState<string | null>(null);
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
        <div className={`${styles.column} ${styles.bare}`}>
          <div className={styles.loading}>
            <p className={styles.lede} role="status">{homeowner.loading}</p>
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
          <div className={`${styles.column} ${styles.bare}`}>
            <EmptyState title={homeowner.goneTitle} body={homeowner.goneBody} />
          </div>
        </main>
      );
    }
    if (status === 410) {
      const phone = latestPhone(query.error?.latest);
      return (
        <main className={styles.page}>
          <div className={`${styles.column} ${styles.bare}`}>
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
        <div className={`${styles.column} ${styles.bare}`}>
          <EmptyState
            title={homeowner.loadFailed}
            action={<Button variant="ghost" onClick={() => void query.refetch()}>{homeowner.tryAgain}</Button>}
          />
        </div>
      </main>
    );
  }

  const proposal = query.data as HomeownerView;
  const phone = proposal.companyPhone;
  const callLink = phone ? <Button variant="ghost" className={styles.link} href={`tel:${phone}`}>{homeowner.callUs(proposal.companyName)}</Button> : null;
  const chosen = chosenOptionId === null ? null : proposal.options.find((option) => option.id === chosenOptionId) ?? null;
  const picked = proposal.options.find((option) => option.id === pickedId) ?? defaultOption(proposal.options);
  const facts = roofCard(proposal.roof);

  return (
    <div className={styles.page}>
      <PublicHeader name={proposal.companyName} logoUrl={proposal.logoUrl} phone={phone} />
      <main className={styles.column}>
        {proposal.status === 'open' && picked ? (
          <>
            <header className={styles.heading}>
              <h1 className={styles.title}>{homeowner.greeting(proposal.firstName)}</h1>
              <p className={styles.lede}>{homeowner.forAddress(proposal.address)}</p>
            </header>

            {facts !== null ? (
              <section className={styles.house} aria-label={homeowner.roofFacts} data-thumb={proposal.roof?.outline ? true : undefined}>
                {proposal.roof?.outline ? (
                  <div className={styles.houseThumb}>
                    <RoofThumb ring={proposal.roof.outline.ring} center={proposal.roof.outline.center} alt={quote.outlineAlt} showOutline />
                  </div>
                ) : null}
                <div className={styles.facts}>
                  {facts.stats.length > 0 ? (
                    <dl className={styles.stats}>
                      {facts.stats.map((stat) => (
                        <div key={stat.key}>
                          <dt>{stat.label}</dt>
                          <dd>{stat.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {facts.photos !== null ? (
                    <p className={styles.photos}>
                      <CameraIcon size={16} />
                      {facts.photos}
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}

            {proposal.options.length > 1 ? (
              <fieldset className={styles.tiles} data-count={proposal.options.length}>
                <legend className="visually-hidden">{homeowner.chooseOne}</legend>
                {proposal.options.map((option: Option) => (
                  <label key={option.id} className={styles.tile} data-selected={option.id === picked.id ? true : undefined}>
                    <input type="radio" name="option" value={option.id} checked={option.id === picked.id} onChange={() => setPickedId(option.id)} />
                    <span className={styles.tileTier}>{homeowner.tierLabel[option.tier]}</span>{' '}
                    <span className={styles.tilePrice}>{money(option.totalCents)}</span>{' '}
                    {option.tier === 'better' ? <span className={styles.popular}>{homeowner.mostPopular}</span> : null}
                  </label>
                ))}
              </fieldset>
            ) : null}

            <OptionPanel
              option={picked}
              estimate={proposal.basis !== 'exact'}
              validUntil={plainDate(proposal.validUntil)}
              onChoose={() => setChosenOptionId(picked.id)}
            />

            <div className={styles.links}>
              <Button variant="ghost" className={styles.link} onClick={() => setDeclineOpen(true)}>{homeowner.declineLink}</Button>
              {callLink}
            </div>

            {/* Mounted only while an option is chosen, and keyed by it: every opening starts with an empty pad, no old drawing, name or error. */}
            {chosen !== null ? (
              <SignFlow
                key={chosen.id}
                token={token}
                proposal={proposal}
                optionId={chosen.id}
                open
                onClose={() => setChosenOptionId(null)}
                onSigned={() => setChosenOptionId(null)}
              />
            ) : null}
            <DeclineSheet
              token={token}
              open={declineOpen}
              onClose={() => setDeclineOpen(false)}
              onDeclined={() => setDeclineOpen(false)}
            />
          </>
        ) : null}

        {proposal.status === 'signed' && proposal.signed !== null ? <Signed proposal={proposal} token={token} /> : null}

        {proposal.status === 'declined' ? (
          <section className={styles.end}>
            <h1 className={styles.title}>{homeowner.declinedTitle}</h1>
            <p className={styles.lede}>{homeowner.declinedBody(proposal.companyName)}</p>
            {callLink}
          </section>
        ) : null}

        {proposal.status === 'expired' ? (
          <section className={styles.end}>
            <h1 className={styles.title}>{homeowner.expiredTitle}</h1>
            <p className={styles.lede}>{homeowner.expiredBody(proposal.companyName)}</p>
            {callLink}
          </section>
        ) : null}
      </main>
    </div>
  );
}

/**
 * The option that is picked: its one all-in price, what the monthly payment would be when it carries the terms, what it
 * includes, then the main button. The panel is a region named for the option, so the price and its button read together.
 */
function OptionPanel({ option, estimate, validUntil, onChoose }: { option: Option; estimate: boolean; validUntil: string; onChoose: () => void }) {
  const financing = financingOf(option);
  const highlights = option.highlights;
  const inclusions = option.inclusions.filter((item) => !highlights.some((h) => h.toLowerCase() === item.toLowerCase()));
  return (
    <section className={styles.panel} aria-label={option.name} data-testid="option-card">
      <div className={styles.option}>
        <div className={styles.optionHead}>
          <h2 className={styles.optionName}>{option.name}</h2>
          {estimate ? <span className={styles.estimate}>{homeowner.estimateLabel}</span> : null}
        </div>
        <p className={styles.priceRow}>
          <span className={styles.price}>{money(option.totalCents)}</span>
          <span className={styles.allIn}>{homeowner.allIn}</span>
        </p>

        {financing !== null ? (
          <div className={styles.fin}>
            <b className={styles.finMonthly}>{homeowner.financingMonthly(financing.monthly)}</b>
            <span className={styles.finRight}>{homeowner.financingApr(financing.apr)}</span>
            <small>{homeowner.financingPayments(financing.months)}</small>
            <small className={styles.finRight}>{homeowner.financingTotal(financing.total)}</small>
            <small className={styles.finNote}>{homeowner.financingNote}</small>
          </div>
        ) : null}

        {highlights.length > 0 ? (
          <ul className={styles.checks}>
            {highlights.map((item) => (
              <li key={item}>
                <CheckIcon size={16} />
                <b>{item}</b>
              </li>
            ))}
          </ul>
        ) : null}

        {inclusions.length > 0 ? (
          <>
            <h3 className={styles.eyebrow}>{homeowner.includedHeading}</h3>
            <ul className={styles.checks}>
              {inclusions.map((item) => (
                <li key={item}>
                  <CheckIcon size={16} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className={styles.dock}>
        <Button size="lg" className={styles.choose} onClick={onChoose}>
          {homeowner.chooseOption(homeowner.tierLabel[option.tier], money(option.totalCents))}
          <ArrowIcon size={18} />
        </Button>
        <p className={styles.fine}>{homeowner.priceGoodUntil(validUntil)}</p>
      </div>
    </section>
  );
}

/** The signed page: a green check, what was signed, a short timeline, and the signed copy to keep. */
function Signed({ proposal, token }: { proposal: HomeownerView; token: string }) {
  const signed = proposal.signed;
  if (signed === null) return null;
  const option = proposal.options.find((candidate) => candidate.id === signed.optionId);
  const when = formatSigned(signed.at);
  return (
    <section className={styles.end}>
      <span className={styles.okMark} aria-hidden="true">
        <CheckIcon size={26} />
      </span>
      <h1 className={styles.title}>{homeowner.signedTitle}</h1>
      <p className={styles.lede}>{homeowner.signedBy(signed.name, when, option?.name ?? '')}</p>

      {option ? (
        <div className={styles.record}>
          <small>{homeowner.tierLabel[option.tier]}</small>
          <small className={styles.right}>{homeowner.signedOn(when)}</small>
          <b>{proposal.address}</b>
          <b className={styles.right}>{money(option.totalCents)}</b>
        </div>
      ) : null}

      <ol className={styles.timeline}>
        <li data-done="">
          <i aria-hidden="true">
            <CheckIcon size={14} />
          </i>
          <div>
            <b>{homeowner.signedStepDone}</b>
            <span>{signed.pdfReady ? homeowner.signedStepCopy : homeowner.pdfPreparing}</span>
          </div>
        </li>
        <li>
          <i aria-hidden="true" />
          <div>
            <b>{homeowner.signedStepNext}</b>
            <span>{homeowner.signedStepNextBody(proposal.companyName)}</span>
          </div>
        </li>
      </ol>

      {signed.pdfReady ? (
        <div className={styles.dock}>
          <Button variant="ghost" size="lg" className={styles.secondary} href={signedPdfUrl(token)}>
            <DocIcon size={18} />
            {homeowner.downloadPdf}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
