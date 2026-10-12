import type { CustomerView } from '@roofline/shared';
import { Pill, UiLink } from '@roofline/ui';
import { useId } from 'react';
import { customers } from '../../copy/customers.ts';
import { ConsentChip } from './ConsentChip.tsx';
import styles from './CustomerWindow.module.css';

export type CustomerHeaderProps = { view: CustomerView };

/** The customer's name, texting status, and how to reach them: phones as tel: links, emails as mailto: links, and tags. */
export function CustomerHeader({ view }: CustomerHeaderProps) {
  const { customer } = view;
  const phonesId = useId();
  const emailsId = useId();
  const tagsId = useId();

  return (
    <header className={styles.header}>
      <h2 className={styles.name}>{customer.displayName}</h2>
      <div className={styles.chips}>
        <ConsentChip status={customer.consent} />
        {customer.doNotContact ? <Pill tone="neutral">{customers.doNotContact}</Pill> : null}
      </div>

      <section aria-labelledby={phonesId} className={styles.group}>
        <h3 id={phonesId} className={styles.groupHeading}>
          {customers.window.phonesHeading}
        </h3>
        {customer.phones.length === 0 ? (
          <p className={styles.muted}>{customers.window.noPhones}</p>
        ) : (
          <ul className={styles.list}>
            {customer.phones.map((phone) => (
              <li key={phone.e164} className={styles.item}>
                <UiLink href={`tel:${phone.e164}`} aria-label={customers.window.callLabel(phone.e164)} className={styles.contact}>
                  {phone.e164}
                </UiLink>
                {phone.label !== null ? <span className={styles.muted}>{phone.label}</span> : null}
                {phone.primary ? <Pill tone="neutral">{customers.window.primary}</Pill> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {customer.emails.length === 0 ? null : (
        <section aria-labelledby={emailsId} className={styles.group}>
          <h3 id={emailsId} className={styles.groupHeading}>
            {customers.window.emailsHeading}
          </h3>
          <ul className={styles.list}>
            {customer.emails.map((email) => (
              <li key={email} className={styles.item}>
                <UiLink href={`mailto:${email}`} className={styles.contact}>
                  {email}
                </UiLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      {customer.tags.length === 0 ? null : (
        <section aria-labelledby={tagsId} className={styles.group}>
          <h3 id={tagsId} className={styles.groupHeading}>
            {customers.window.tagsHeading}
          </h3>
          <ul className={styles.list}>
            {customer.tags.map((tag) => (
              <li key={tag}>
                <Pill tone="neutral">{tag}</Pill>
              </li>
            ))}
          </ul>
        </section>
      )}
    </header>
  );
}
