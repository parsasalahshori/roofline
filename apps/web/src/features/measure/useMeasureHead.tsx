import type { UseQueryResult } from '@tanstack/react-query';
import { Tag } from '@roofline/ui';
import type { ReactNode } from 'react';
import { measure } from '../../copy/measure.ts';
import { splitAddress } from './address.ts';
import { useMeasurementPreview } from './api.ts';
import { useRequestRows, type RequestRow } from './lift/requests.ts';
import type { MeasurementPreview, MeasurementView } from './types.ts';

const RECOMMENDED_TIER = 'better';

/** What the roof and gutters pages say about the home in their head. */
export type MeasureHead = {
  /** The prices as the saved numbers make them: the head and the quote read the same answer. */
  preview: UseQueryResult<MeasurementPreview>;
  /** The home's address, whole; null until something says it (or nothing is open). */
  address: string | null;
  /** "Karen White, Omaha": who the roof is for and where. */
  who: string | null;
  /** The proposal number, the roof material and (when `hail`) the largest hail on record, as tags for the head's right. */
  chips: (options?: { hail?: boolean }) => ReactNode;
  row: RequestRow | undefined;
};

/**
 * The address, customer and town of the open measurement, from its preview or its request (whichever answers first),
 * for the page title and the line under it. Nothing is invented: what no answer carries is left out.
 */
export function useMeasureHead(measurementId: string, m: MeasurementView | undefined): MeasureHead {
  const e = m?.estimate;
  // Asked once the measurement has loaded; with an empty id the query stays off
  const preview = useMeasurementPreview(m !== undefined ? measurementId : '', e === undefined ? '' : [e.surfaceSqFt, e.pitchX12, e.edgeFt, e.ridgeFt, e.valleyFt].join(':'));
  const { rows } = useRequestRows('');
  const row = rows.find((r) => r.measurementId === measurementId);
  const address = measurementId === '' ? null : (preview.data?.addressLine ?? row?.address ?? null);
  const name = preview.data?.customerName ?? row?.name ?? null;
  const town = preview.data?.city ?? (address !== null ? splitAddress(address).rest : '');
  const who = address !== null && (name !== null || town !== '') ? measure.whoAndTown(name, town) : null;
  const better = preview.data?.options?.find((o) => o.tier === RECOMMENDED_TIER) ?? preview.data?.options?.[0];
  const material = row?.material ?? (better ? measure.materials[better.material] : null);
  const hail = preview.data?.hailIn ?? null;
  const chips = ({ hail: withHail = true }: { hail?: boolean } = {}): ReactNode => {
    const showHail = withHail && hail !== null && hail > 0;
    if (row?.number === undefined && material === null && !showHail) return null;
    return (
      <>
        {row?.number !== undefined ? <Tag>{row.number}</Tag> : null}
        {material !== null ? <Tag>{material}</Tag> : null}
        {showHail ? (
          <Tag tone="warn" icon="storm">
            {measure.hailSize(hail)}
          </Tag>
        ) : null}
      </>
    );
  };
  return { preview, address, who, chips, row };
}
