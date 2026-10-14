import { measure } from '../../../copy/measure.ts';
import { OwnerRecord } from '../../property-data/OwnerRecord.tsx';
import type { MeasurementPreview } from '../types.ts';
import { useRequestRows } from './requests.ts';
import styles from './PropertyStrip.module.css';

const RECOMMENDED_TIER = 'better';

/**
 * The strip over the roof: the address, the proposal number when the home has one, the customer and town, and
 * chips for the roof material and the largest hail on record. What nothing stores (roof age) is left out.
 * Under it, with the home's id, the Owner records button (the county record, fetched only when pressed).
 */
export function PropertyStrip({
  measurementId,
  propertyId,
  preview,
}: {
  measurementId: string;
  propertyId?: string | undefined;
  preview?: MeasurementPreview | undefined;
}) {
  const { rows } = useRequestRows('');
  const row = rows.find((r) => r.measurementId === measurementId);
  const address = preview?.addressLine ?? row?.address;
  if (address === undefined) return null;
  const name = preview?.customerName ?? row?.name ?? null;
  const town = preview?.city ?? '';
  const better = preview?.options?.find((o) => o.tier === RECOMMENDED_TIER) ?? preview?.options?.[0];
  const material = row?.material ?? (better ? measure.materials[better.material] : null);
  const hail = preview?.hailIn ?? null;
  return (
    <>
      <div className={styles.strip} data-measure-strip="">
        <div className={styles.who}>
          <div className={styles.addressRow}>
            <h3 className={styles.address}>{address}</h3>
            {row?.number !== undefined ? <span className={styles.number}>{row.number}</span> : null}
          </div>
          {name !== null || town !== '' ? <p className={styles.owner}>{measure.whoAndTown(name, town)}</p> : null}
        </div>
        <div className={styles.chips}>
          {material !== null ? <span className={styles.chip}>{material}</span> : null}
          {hail !== null && hail > 0 ? (
            <span className={styles.chip} data-tone="hail">
              {measure.hailSize(hail)}
            </span>
          ) : null}
        </div>
      </div>
      {propertyId !== undefined ? (
        <div className={styles.record}>
          <OwnerRecord propertyId={propertyId} />
        </div>
      ) : null}
    </>
  );
}
