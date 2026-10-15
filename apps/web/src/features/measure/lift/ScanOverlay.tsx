import type { CSSProperties } from 'react';
import styles from './ScanOverlay.module.css';

/** A length over the scanned picture: pixels (a number) or a share of it (`'12.5%'`). */
type Length = number | string;

/** Where the brackets go over the picture, in its own box (the map's or the photo's). */
export type ScanBox = { left: Length; top: Length; width: Length; height: Length };

/**
 * The scan drawn over a picture: yellow corner brackets round `box`, a sweep going down inside them while
 * `sweeping`, and white dots at `points`. It fills its positioned parent and takes no clicks; it is decoration
 * (the card says what the scan is doing). The roof's scan places it over the map, the windows' over the photo.
 */
export function ScanOverlay({ box, sweeping, points = [] }: { box: ScanBox; sweeping: boolean; points?: readonly { x: Length; y: Length }[] }) {
  return (
    <div className={styles.scanLayer} aria-hidden="true" data-scan-overlay="">
      <div className={styles.brackets} style={box as CSSProperties}>
        <span data-corner="tl" />
        <span data-corner="tr" />
        <span data-corner="bl" />
        <span data-corner="br" />
        {sweeping ? (
          <div className={styles.sweepBox}>
            <div className={styles.sweep} />
          </div>
        ) : null}
      </div>
      {points.map((p, i) => (
        <span key={i} className={styles.vertex} style={{ left: p.x, top: p.y }} />
      ))}
    </div>
  );
}
