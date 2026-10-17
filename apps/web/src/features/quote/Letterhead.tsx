import { formatPhone } from '../../lib/phone.ts';
import { homeownerMeasure as copy } from '../../copy/homeownerMeasure.ts';
import styles from './QuotePage.module.css';

/** The company's name or logo, and its phone, at the top of the public quote pages. */
export function Letterhead({ logoUrl, companyName, phone }: { logoUrl: string | null; companyName: string; phone: string | null }) {
  return (
    <header className={styles.brand}>
      {logoUrl ? <img className={styles.logo} src={logoUrl} alt={companyName} /> : <span className={styles.companyName}>{companyName}</span>}
      {phone ? (
        <a className={styles.phone} href={`tel:${phone}`}>
          {formatPhone(phone)}
        </a>
      ) : null}
    </header>
  );
}

/** Reviews, the year the company started and its licence, when the company has entered any (none yet: nothing is drawn). */
export function TrustRow({ trust }: { trust: { reviews?: number; since?: number; license?: string } | null }) {
  const items = [
    trust?.reviews !== undefined ? copy.trustReviews(trust.reviews) : null,
    trust?.since !== undefined ? copy.trustSince(trust.since) : null,
    trust?.license !== undefined ? copy.trustLicense(trust.license) : null,
  ].filter((t): t is string => t !== null);
  if (items.length === 0) return null;
  return (
    <ul className={styles.trustRow} data-trust-row="">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}
