import type { JobView } from '@roofline/shared';
import { Button, Icon, Tag, UiLink, type IconName } from '@roofline/ui';
import { doors } from '../../copy/doors.ts';
import { job } from '../../copy/job.ts';
import { useJobClaim } from '../claims/api.ts';
import { formatPhone } from '../jobs/format.ts';
import { MoveJobMenu } from '../jobs/MoveJobMenu.tsx';
import { isIos } from '../storm/routes/navigate.ts';
import styles from './JobHeader.module.css';

/** Directions open in a new tab. Button's own type has no target, so these go on as a spread. */
const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' };

type Target = { key: 'call' | 'text' | 'directions'; href: string; label: string; icon: IconName; newTab: boolean };

/** Apple Maps on an iPhone or iPad, Google Maps everywhere else: the same rule the route screen follows. */
function directionsUrl(address: string): string {
  const base = isIos(navigator.userAgent) ? doors.navigateAppleBase : doors.navigateGoogleBase;
  return `${base}${encodeURIComponent(address)}`;
}

/** Where each of Call, Text and Directions goes. A target with nothing to go to is left out: never a button that does nothing. */
export function contactTargets(view: JobView): Target[] {
  const { customer, home } = view;
  const targets: Target[] = [];
  const phone = customer.phone?.trim() ?? '';
  if (phone !== '') {
    targets.push({ key: 'call', href: `tel:${phone}`, label: job.call, icon: 'phone', newTab: false });
    targets.push({ key: 'text', href: `sms:${phone}`, label: job.text, icon: 'msg', newTab: false });
  }
  if (home.addressLine.trim() !== '') {
    const address = job.addressFull(home.addressLine, home.city, home.state, home.zip);
    targets.push({ key: 'directions', href: directionsUrl(address), label: job.directions, icon: 'route', newTab: true });
  }
  return targets;
}

function ContactButtons({ view, tiles = false }: { view: JobView; tiles?: boolean }) {
  return (
    <>
      {contactTargets(view).map((target) => (
        <Button
          key={target.key}
          href={target.href}
          variant="default"
          className={tiles ? styles.tile : undefined}
          data-contact={target.key}
          {...(target.newTab ? NEW_TAB : {})}
        >
          <Icon name={target.icon} size={tiles ? 22 : 16} />
          {target.label}
        </Button>
      ))}
    </>
  );
}

/** The line under the customer's name: the address (a link to the map), the phone, and what is special about the job. */
export function JobSubtitle({ view, phone }: { view: JobView; phone: boolean }) {
  const { job: current, customer, home } = view;
  const claim = useJobClaim(current.id);
  // A claim on the job, or the Front Desk's intake that said there is one
  const insured = claim.data !== undefined && (claim.data.claim !== null || claim.data.intake !== null);
  const number = customer.phone?.trim() ?? '';

  return (
    <span className={styles.meta}>
      <span className={styles.place}>
        <Icon name="pin" size={16} />
        <span>
          <UiLink href={`/?focus=${current.propertyId}`} aria-label={job.addressLink(home.addressLine)} className={styles.address}>
            {home.addressLine}
          </UiLink>
          {job.addressRest(home.city, home.state, home.zip)}
        </span>
      </span>
      {/* A phone has the Call tile; the number itself is for a desktop, where it is read or copied */}
      {!phone && number !== '' ? (
        <UiLink href={`tel:${number}`} className={styles.number}>
          {formatPhone(number)}
        </UiLink>
      ) : null}
      {insured ? <Tag>{job.insuranceClaim}</Tag> : null}
      {current.archived ? <Tag>{job.archivedChip}</Tag> : null}
    </span>
  );
}

/** The buttons at the right of the title on a desktop: reach the customer, then the quick move with its menu. */
export function JobActions({ view }: { view: JobView }) {
  const { job: current, can } = view;
  return (
    <div role="group" aria-label={job.actionsLabel} className={styles.actions}>
      <ContactButtons view={view} />
      {can.edit ? <MoveJobMenu job={current} archived={current.archived} split prominent /> : null}
    </div>
  );
}

/** Call, Text and Directions as large tiles under the stage steps: a phone is used with a thumb. */
export function ContactTiles({ view }: { view: JobView }) {
  if (contactTargets(view).length === 0) return null;
  return (
    <div role="group" aria-label={job.tilesLabel} className={styles.tiles}>
      <ContactButtons view={view} tiles />
    </div>
  );
}
