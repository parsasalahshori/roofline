import { Button, Segmented, Sheet, Skeleton, type SegmentedOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { errors } from '../../copy/errors.ts';
import { setup } from '../../copy/setup.ts';
import { useCompany } from '../settings/api.ts';
import { useLocateCompany, useServiceArea } from './api.ts';
import styles from './CompanyBasicsSheet.module.css';

/** The miles the area you work in can be set to. */
const RADIUS_OPTIONS = [10, 20, 40, 60] as const;
/** What the area is when the company has not set one yet. */
const DEFAULT_RADIUS = 40;

/** The words for a failed request: the API's own message for an ApiError, the generic line otherwise. */
function messageOf(error: unknown): string | undefined {
  if (!error) return undefined;
  return error instanceof ApiError ? error.message : errors.generic;
}

type CompanyBasicsSheetProps = {
  open: boolean;
  onClose: () => void;
};

/** The company's map placement and service-area radius, opened from the Setup row "Check details". */
export function CompanyBasicsSheet({ open, onClose }: CompanyBasicsSheetProps) {
  return (
    <Sheet open={open} title={setup.sheet.title} onClose={onClose} closeLabel={setup.sheet.close}>
      {open ? <BasicsBody onClose={onClose} /> : null}
    </Sheet>
  );
}

/** The sheet's content. Mounted only while the sheet is open, so the company is read only then. */
function BasicsBody({ onClose }: { onClose: () => void }) {
  const company = useCompany();
  const locate = useLocateCompany();
  const area = useServiceArea();
  const data = company.data;

  if (company.error && !data) {
    return (
      <p role="alert" className={styles.alert}>
        {messageOf(company.error)}
      </p>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true">
        <Skeleton lines={2} />
      </div>
    );
  }

  const current = data.serviceAreaMiles ?? DEFAULT_RADIUS;
  const radiusOptions: SegmentedOption[] = RADIUS_OPTIONS.map((miles) => ({ value: String(miles), label: setup.radius(miles) }));
  // A radius the company already has, but that is not on the list, still shows as the current choice
  if (!RADIUS_OPTIONS.some((miles) => miles === current)) {
    radiusOptions.unshift({ value: String(current), label: setup.radius(current) });
  }

  const locateError = messageOf(locate.error);

  return (
    <div className={styles.body}>
      {data.located ? (
        <p role="status" className={styles.placed}>
          {setup.sheet.placed}
        </p>
      ) : (
        <div className={styles.place}>
          <Button variant="primary" busy={locate.isPending} onClick={() => locate.mutate()}>
            {setup.sheet.placeOnMap}
          </Button>
          {locateError ? (
            <p role="alert" className={styles.alert}>
              {locateError}
            </p>
          ) : null}
        </div>
      )}
      {/* A few fixed choices, so a track of segments rather than a list that opens: the sheet is a modal dialog, and a list
          opens in a popover outside it */}
      <div className={styles.radius}>
        <p className={styles.radiusLabel}>{setup.sheet.radiusLabel}</p>
        <Segmented
          label={setup.sheet.radiusLabel}
          value={String(current)}
          onChange={(value) => area.mutate(Number(value))}
          options={radiusOptions}
          className={styles.track}
        />
        {messageOf(area.error) ? (
          <p role="alert" className={styles.alert}>
            {messageOf(area.error)}
          </p>
        ) : null}
      </div>
      <Button variant="ghost" href="/settings/company" onClick={onClose}>
        {setup.sheet.editDetails}
      </Button>
    </div>
  );
}
