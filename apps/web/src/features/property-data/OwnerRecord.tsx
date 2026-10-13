import { useId, useState } from 'react';
import type { PropertyRecordView, StreetImageView } from '@roofline/shared';
import { Button } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { propertyData as copy } from '../../copy/propertyData.ts';
import { usePropertyRecord } from './api.ts';
import styles from './OwnerRecord.module.css';

/**
 * A home's public county record (owner, mailing address, year built, last sale) and a street photo, opened on
 * request: each lookup can cost money, so nothing is asked until a person presses Owner records.
 */
export function OwnerRecord({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className={styles.wrap} data-owner-record="">
      <Button variant="ghost" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
        {open ? copy.hide : copy.open}
      </Button>
      {open ? (
        <section id={panelId} className={styles.panel} aria-label={copy.title}>
          <RecordBody propertyId={propertyId} />
        </section>
      ) : null}
    </div>
  );
}

function RecordBody({ propertyId }: { propertyId: string }) {
  const query = usePropertyRecord(propertyId, true);
  if (query.isPending) return <p className={styles.muted}>{copy.loading}</p>;
  if (query.isError) {
    return (
      <div className={styles.row}>
        <p className={styles.muted} role="alert">
          {query.error instanceof ApiError ? query.error.message : copy.failed}
        </p>
        <Button variant="ghost" busy={query.isFetching} onClick={() => void query.refetch()}>
          {copy.retry}
        </Button>
      </div>
    );
  }
  const { configured, record, streetImage } = query.data;
  if (!configured) return <p className={styles.muted}>{copy.notSetUp}</p>;
  return (
    <>
      {streetImage !== null ? <StreetPhoto image={streetImage} /> : null}
      {record === null ? <p className={styles.muted}>{copy.noRecord}</p> : <Facts record={record} />}
    </>
  );
}

function occupiedText(value: boolean | null): string {
  if (value === true) return copy.occupiedYes;
  if (value === false) return copy.occupiedNo;
  return copy.occupiedUnknown;
}

function Facts({ record }: { record: PropertyRecordView }) {
  const sale = copy.sale(record.lastSaleDate, record.lastSaleCents);
  const rows: [string, string | null][] = [
    [copy.owners, record.owners.length > 0 ? record.owners.join('; ') : copy.ownerNone],
    [copy.occupied, occupiedText(record.ownerOccupied)],
    [copy.mailing, record.mailingAddress],
    [copy.yearBuilt, record.yearBuilt !== null ? String(record.yearBuilt) : null],
    [copy.livingArea, record.livingSqFt !== null ? copy.sqFt(record.livingSqFt) : null],
    [copy.lastSale, sale !== '' ? sale : null],
    [copy.assessed, record.assessedCents !== null ? copy.money(record.assessedCents) : null],
    [copy.parcel, record.parcelId],
    [copy.county, record.county],
  ];
  const source = [copy.source[record.source], record.sourceUpdatedAt !== null ? copy.updated(record.sourceUpdatedAt) : null]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <>
      <dl className={styles.facts}>
        {rows
          .filter((row): row is [string, string] => row[1] !== null)
          .map(([label, value]) => (
            <div key={label} className={styles.fact}>
              <dt className={styles.label}>{label}</dt>
              <dd className={styles.value}>{value}</dd>
            </div>
          ))}
      </dl>
      <p className={styles.note}>{source}</p>
      <p className={styles.note}>{copy.compliance}</p>
    </>
  );
}

function StreetPhoto({ image }: { image: StreetImageView }) {
  return (
    <figure className={styles.photo}>
      <img className={styles.image} src={image.thumbUrl} alt={copy.photoAlt} loading="lazy" referrerPolicy="no-referrer" />
      <figcaption className={styles.note}>
        <a href={image.pageUrl} target="_blank" rel="noreferrer">
          {copy.photoCredit(image.capturedAt)}
        </a>
      </figcaption>
    </figure>
  );
}
