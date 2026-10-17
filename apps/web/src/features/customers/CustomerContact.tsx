import type { CustomerView } from '@roofline/shared';
import { Panel, Tag, UiLink } from '@roofline/ui';
import { customers } from '../../copy/customers.ts';
import { formatPhone } from '../jobs/format.ts';
import { CustomerTag } from './CustomerTag.tsx';
import styles from './CustomerWindow.module.css';

export type CustomerContactProps = { view: CustomerView };

/** How to reach the customer: phones as tel: links, emails as mailto: links and their tags. The texting status is in the page head. */
export function CustomerContact({ view }: CustomerContactProps) {
  const { customer } = view;

  return (
    <Panel title={customers.window.contactHeading} className={styles.contact}>
      <dl className={styles.facts}>
        <dt>{customers.window.phonesHeading}</dt>
        <dd>
          {customer.phones.length === 0 ? (
            <span className={styles.muted}>{customers.window.noPhones}</span>
          ) : (
            <ul className={styles.plainList}>
              {customer.phones.map((phone) => (
                <li key={phone.e164} className={styles.phoneRow}>
                  <UiLink href={`tel:${phone.e164}`} aria-label={customers.window.callLabel(phone.e164)} className={styles.contactLink}>
                    {formatPhone(phone.e164)}
                  </UiLink>
                  {phone.label !== null ? <span className={styles.muted}>{phone.label}</span> : null}
                  {phone.primary ? <Tag>{customers.window.primary}</Tag> : null}
                </li>
              ))}
            </ul>
          )}
        </dd>

        <dt>{customers.window.emailsHeading}</dt>
        <dd>
          {customer.emails.length === 0 ? (
            <span className={styles.muted}>{customers.window.noEmails}</span>
          ) : (
            <ul className={styles.plainList}>
              {customer.emails.map((email) => (
                <li key={email}>
                  <UiLink href={`mailto:${email}`} className={styles.contactLink}>
                    {email}
                  </UiLink>
                </li>
              ))}
            </ul>
          )}
        </dd>

        {customer.tags.length === 0 ? null : (
          <>
            <dt>{customers.window.tagsHeading}</dt>
            <dd>
              <ul className={styles.tagList}>
                {customer.tags.map((tag) => (
                  <li key={tag} className={styles.tagItem}>
                    <CustomerTag>{tag}</CustomerTag>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </Panel>
  );
}
