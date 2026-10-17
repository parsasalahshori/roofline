import type { CatalogFinancing, CatalogOffer, PublicCatalogFacts } from '@roofline/shared';
import { publicCopy } from '../../copy/public.ts';
import { CheckIcon } from './icons.tsx';
import styles from './Catalog.module.css';

/*
 * What a company's window catalog adds to its homeowner pages (the instant quote page and the browser measuring flow):
 * the offer banner, the financing line, what every window includes, the names of its three levels, and the line that
 * colours and grids are chosen at the visit. Each part draws nothing when the company entered nothing for it.
 */

/** A slim banner with the offer's words and, when it has one, a link to its terms. */
export function OfferBanner({ offer }: { offer: CatalogOffer | null | undefined }) {
  if (!offer) return null;
  return (
    <div className={styles.offer} role="note" aria-label={publicCopy.offerLabel} data-offer="">
      <span className={styles.offerTitle}>{offer.title}</span>
      {offer.termsUrl !== null ? (
        <a className={styles.offerLink} href={offer.termsUrl} target="_blank" rel="noopener noreferrer">
          {publicCopy.offerTerms}
        </a>
      ) : null}
    </div>
  );
}

/** One quiet line about financing, linked when the company gave an address. */
export function FinancingLine({ financing }: { financing: CatalogFinancing | null | undefined }) {
  if (!financing) return null;
  return (
    <p className={styles.financing} data-financing="">
      {financing.text}
      {financing.url !== null ? (
        <>
          {' '}
          <a href={financing.url} target="_blank" rel="noopener noreferrer">
            {publicCopy.financingMore}
          </a>
        </>
      ) : null}
    </p>
  );
}

/** "Every window includes", as a checked list. */
export function IncludedList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <section className={styles.block} data-included="">
      <h2 className={styles.blockTitle}>{publicCopy.includedTitle}</h2>
      <ul className={styles.checks}>
        {items.map((item) => (
          <li key={item} className={styles.check}>
            <CheckIcon size={16} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The company's three levels by name, each with its one-line note. */
export function TierNotes({ tiers }: { tiers: PublicCatalogFacts['tiers'] }) {
  const named = tiers.filter((t) => t.note !== '');
  if (named.length === 0) return null;
  return (
    <section className={styles.block} data-tier-notes="">
      <h2 className={styles.blockTitle}>{publicCopy.tiersTitle}</h2>
      <ul className={styles.tiers}>
        {tiers.map((t) => (
          <li key={t.key} className={styles.tier} data-tier={t.key}>
            <b>{t.label}</b>
            <span>{t.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The honest line under a window price: colours and grids come later. */
export function VisitNote() {
  return <p className={styles.visitNote}>{publicCopy.colorsGrids}</p>;
}

/** All of it for the instant quote page's windows result. */
export function CatalogFacts({ catalog }: { catalog: PublicCatalogFacts }) {
  return (
    <div className={styles.facts} data-catalog-facts="">
      <TierNotes tiers={catalog.tiers} />
      <IncludedList items={catalog.included} />
      <VisitNote />
      <FinancingLine financing={catalog.financing} />
    </div>
  );
}
