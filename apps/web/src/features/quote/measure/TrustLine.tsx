import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';
import q from '../QuotePage.module.css';

/** Reviews, the year the company started and its licence, when the company has entered any (none yet: nothing is drawn). */
export function TrustLine({ trust }: { trust: { reviews?: number; since?: number; license?: string } | null }) {
  const items = [
    trust?.reviews !== undefined ? copy.trustReviews(trust.reviews) : null,
    trust?.since !== undefined ? copy.trustSince(trust.since) : null,
    trust?.license !== undefined ? copy.trustLicense(trust.license) : null,
  ].filter((t): t is string => t !== null);
  if (items.length === 0) return null;
  return (
    <ul className={q.trustRow} data-trust-row="">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}
