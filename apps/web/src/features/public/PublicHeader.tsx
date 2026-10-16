import { publicCopy } from '../../copy/public.ts';
import { formatPhone } from '../../lib/phone.ts';
import { PhoneIcon } from './icons.tsx';
import styles from './PublicHeader.module.css';

/**
 * The top of a homeowner page: the company's own logo, or its name as a text wordmark when it has none (nothing
 * is drawn for a company that gave no logo), and a Call pill when it has a phone. Nothing here is Roofline's.
 */
export function PublicHeader({ name, logoUrl, phone }: { name: string; logoUrl: string | null | undefined; phone: string | null | undefined }) {
  return (
    <header className={styles.site} data-logo={logoUrl ? true : undefined}>
      <div className={styles.mark}>
        {logoUrl ? <img className={styles.logo} src={logoUrl} alt={name} /> : <span className={styles.wordmark}>{name}</span>}
      </div>
      {phone ? (
        <a className={styles.call} href={`tel:${phone}`} aria-label={publicCopy.callAria(formatPhone(phone))}>
          <PhoneIcon size={16} />
          <span>{publicCopy.call}</span>
        </a>
      ) : null}
    </header>
  );
}
