import { Button, Field, Icon } from '@roofline/ui';
import { fractionInches, MAX_PO_LENGTH, type WindowOrderSettings, type WindowOrderStatus } from '@roofline/shared';
import { windowOrder as copy } from '../../../../copy/windowOrder.ts';
import { sheetCsvHref, sheetPdfHref } from './api.ts';
import styles from './OrderWindow.module.css';

// A plain download link (same origin, cookie auth): Button passes the download attribute through to the anchor.
const DOWNLOAD = { download: true };

/** The order's status as a word, never colour alone. Big on the ticket's stub. */
export function OrderStatusPill({ status }: { status: WindowOrderStatus }) {
  return (
    <span className={styles.status} data-status={status}>
      <span className="visually-hidden">{copy.statusLabel}</span>
      {copy.status[status]}
    </span>
  );
}

/** The rule the order size follows, in the company's own numbers: the fit allowance (one or two) and the rounding step. */
export function orderRule(settings: WindowOrderSettings): string {
  const step = fractionInches(settings.roundingIn);
  const width = fractionInches(settings.widthDeductionIn);
  const height = fractionInches(settings.heightDeductionIn);
  return width === height ? copy.rule(width, step) : copy.ruleSplit(width, height, step);
}

type Props = {
  id: string;
  address: string;
  status: WindowOrderStatus;
  poNumber: string;
  lineCount: number;
  locked: boolean;
  onPo: (po: string) => void;
  windowsHref: string;
};

/**
 * The order's ticket: the stub with what it is and where it stands, a dashed tear line, then the address, the PO number
 * (typed here while it is a draft) and how many lines; the way back and the printed sheet at the right.
 */
export function OrderTicket({ id, address, status, poNumber, lineCount, locked, onPo, windowsHref }: Props) {
  const draft = status === 'draft';
  return (
    <section className={styles.ticket} aria-label={copy.ticketLabel} data-ticket="">
      <div className={styles.stub}>
        <span className={styles.eyebrow}>{copy.title}</span>
        <OrderStatusPill status={status} />
      </div>
      <div className={styles.cells}>
        <div className={styles.cell} data-cell="address">
          <span className={styles.cellLabel}>{copy.ticket.address}</span>
          <span className={styles.cellValue} title={address}>
            {address}
          </span>
        </div>
        <div className={styles.cell} data-cell="po">
          {locked ? (
            poNumber !== '' ? (
              <>
                <span className={styles.cellLabel}>{copy.poLabel}</span>
                <span className={styles.cellValue}>{poNumber}</span>
              </>
            ) : null
          ) : (
            <Field className={styles.poField} label={copy.poLabel} placeholder={copy.poPlaceholder} value={poNumber} maxLength={MAX_PO_LENGTH} onChange={(e) => onPo(e.currentTarget.value)} />
          )}
        </div>
        <div className={styles.cell} data-cell="lines">
          <span className={styles.cellLabel}>{copy.ticket.lines}</span>
          <span className={`${styles.cellValue} ${styles.mono}`}>{lineCount}</span>
        </div>
      </div>
      <div className={styles.ticketActions}>
        <Button variant="ghost" href={windowsHref} className={styles.back}>
          <Icon name="chevl" size={16} />
          {copy.back}
        </Button>
        {!draft ? (
          <Button variant="default" href={sheetCsvHref(id)} {...DOWNLOAD}>
            <Icon name="sheet" size={16} />
            {copy.downloadCsv}
          </Button>
        ) : null}
        <Button variant="default" href={sheetPdfHref(id)} {...DOWNLOAD}>
          <Icon name="doc" size={16} />
          {draft ? copy.draftPdf : copy.downloadPdf}
        </Button>
      </div>
    </section>
  );
}
