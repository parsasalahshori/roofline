import type { HomeownerCompany } from '@roofline/shared';
import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';
import { Badges } from '../../public/TrustRow.tsx';
import { ratingLine, trustBadges } from '../../public/trust.ts';
import q from '../QuotePage.module.css';

/**
 * What the company says about itself, in one quiet line (the rating with its source and count, the year it started, its
 * licence) and its short badges, each only when the company entered it (none: nothing is drawn).
 */
export function TrustLine({ trust }: { trust: HomeownerCompany['trust'] }) {
  const rating = ratingLine(trust);
  const items = [
    rating,
    trust?.sinceYear != null ? copy.trustSince(trust.sinceYear) : null,
    trust?.license != null ? copy.trustLicense(trust.license.state, trust.license.number) : null,
  ].filter((t): t is string => t !== null);
  const badges = trustBadges(trust);
  if (items.length === 0 && badges.length === 0) return null;
  return (
    <>
      {items.length > 0 ? (
        <ul className={q.trustRow} data-trust-row="">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      <Badges badges={badges} />
    </>
  );
}
