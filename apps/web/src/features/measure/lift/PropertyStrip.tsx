import { measure } from '../../../copy/measure.ts';
import { useRequestRows } from './requests.ts';
import styles from './PropertyStrip.module.css';

/** What the strip can show. Anything not known is left out. */
export type PropertyFacts = {
  address: string;
  owner: string;
  material: string | null;
  roofAgeYears: number;
  hailSizeIn: number;
};

/** The header strip over the roof: address, owner and chips, for the open measurement when a request knows it. */
export function PropertyStrip({ measurementId, facts }: { measurementId: string; facts?: Partial<PropertyFacts> }) {
  const { rows } = useRequestRows('');
  const row = rows.find((r) => r.measurementId === measurementId);
  const address = facts?.address ?? row?.address;
  if (address === undefined) return null;
  const owner = facts?.owner ?? row?.name;
  const material = facts?.material ?? row?.material ?? null;
  return (
    <div className={styles.strip}>
      <div className={styles.who}>
        <strong className={styles.address}>{address}</strong>
        {owner !== undefined ? (
          <span className={styles.owner}>
            {measure.ownerLabel}: {owner}
          </span>
        ) : null}
      </div>
      <div className={styles.chips}>
        {material !== null ? <span className={styles.chip}>{material}</span> : null}
        {facts?.roofAgeYears !== undefined ? <span className={styles.chip}>{measure.roofAge(facts.roofAgeYears)}</span> : null}
        {facts?.hailSizeIn !== undefined ? (
          <span className={styles.chip} data-tone="hail">
            {measure.hailSize(facts.hailSizeIn)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
