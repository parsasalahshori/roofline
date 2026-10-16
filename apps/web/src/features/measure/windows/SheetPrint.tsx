import { Banner, Button, Select } from '@roofline/ui';
import type { CalibrationSheet, SheetPaper } from '@roofline/shared';
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { windowPhotos as copy } from '../../../copy/measureWindows.ts';
import { usePhotoEngine } from './photoEngine.tsx';
import styles from './SheetPrint.module.css';

const PAPERS: SheetPaper[] = ['letter', 'a4'];

/** A printed page of exactly this paper with no margins (the sheet fills it at 100%). */
const pageRule = (paper: SheetPaper) => `@page { size: ${paper === 'a4' ? 'A4' : 'letter'} portrait; margin: 0; }`;

/**
 * The sheet as it prints: only this is on the page when printing (the print stylesheet hides the app), at its real
 * size in inches, on a page of exactly that paper with no margins, so the printer has nothing to fit or scale.
 */
function PrintPage({ sheet }: { sheet: CalibrationSheet }) {
  return createPortal(
    <div className={styles.printPage} data-print-sheet={sheet.paper} aria-hidden="true">
      <style>{pageRule(sheet.paper)}</style>
      <div className={styles.printSvg} style={{ width: `${sheet.widthIn}in`, height: `${sheet.heightIn}in` }} dangerouslySetInnerHTML={{ __html: sheet.svg }} />
    </div>,
    document.body,
  );
}

/** "Print the measuring sheet": pick the paper, see the sheet, print it at 100% or download it; check its ruler. */
export function SheetPrint({ onClose }: { onClose: () => void }) {
  const engine = usePhotoEngine(true);
  const [paper, setPaper] = useState<SheetPaper>('letter');
  const sheet = useMemo(() => (engine.cv === null ? null : engine.cv.calibrationSheet(paper)), [engine.cv, paper]);
  const href = useMemo(
    () => (sheet === null || typeof URL.createObjectURL !== 'function' ? null : URL.createObjectURL(new Blob([sheet.svg], { type: 'image/svg+xml' }))),
    [sheet],
  );
  useEffect(
    () => () => {
      if (href !== null) URL.revokeObjectURL?.(href);
    },
    [href],
  );

  return (
    <section className={styles.print} aria-labelledby="sheet-print-title" data-sheet-print="">
      <h3 id="sheet-print-title" className={styles.title}>
        {copy.printTitle}
      </h3>
      <p className={styles.intro}>{copy.printIntro}</p>
      <Select label={copy.printPaper} value={paper} options={PAPERS.map((p) => ({ value: p, label: copy.printPapers[p] }))} onChange={(v) => setPaper(v as SheetPaper)} />
      {engine.status === 'unavailable' ? (
        <Banner tone="warning">{copy.engineUnavailable}</Banner>
      ) : sheet === null ? (
        <p role="status">{copy.printLoading}</p>
      ) : (
        <>
          <div className={styles.preview} role="img" aria-label={copy.printPreview} style={{ aspectRatio: `${sheet.widthIn} / ${sheet.heightIn}` }} dangerouslySetInnerHTML={{ __html: sheet.svg }} />
          <div className={styles.actions}>
            <Button className={styles.action} onClick={() => window.print()}>
              {copy.print}
            </Button>
            {href !== null ? (
              <a className={styles.download} href={href} download={copy.downloadName(paper)}>
                {copy.download}
              </a>
            ) : null}
          </div>
          <Banner tone="info">{copy.printRulerCheck}</Banner>
          <PrintPage sheet={sheet} />
        </>
      )}
      <Button variant="ghost" className={styles.action} onClick={onClose}>
        {copy.back}
      </Button>
    </section>
  );
}
