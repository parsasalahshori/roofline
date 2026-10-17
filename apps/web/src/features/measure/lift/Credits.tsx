import { IconButton } from '@roofline/ui';
import { useState, type ReactNode } from 'react';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import styles from './RoofView.module.css';

/** A circled "i": the map's credits, as the map libraries draw them. */
function InfoGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.6v.01" />
    </svg>
  );
}

/**
 * The credits for the photo and the outlines, in a corner of the map and never over the roof. Where the map is wide they
 * are one line along the bottom edge, under the measure card. Where it is narrow (a phone) they fold into a round "i" in
 * the top corner that opens them, so they cannot cover the roof or its street labels. Each credit is a span of its own.
 */
export function Credits({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.credits} data-open={open ? 'true' : 'false'} data-credits="">
      <IconButton label={liftMeasure.creditsToggle} icon={<InfoGlyph />} className={styles.creditsToggle} aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      <p className={styles.creditsText}>{children}</p>
    </div>
  );
}
