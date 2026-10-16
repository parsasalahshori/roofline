import { Banner, Button, Field, Select } from '@roofline/ui';
import type { CalibrationSheet, SheetPaper } from '@roofline/shared';
import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState } from 'react';
import { windowPhotos as copy } from '../../../copy/measureWindows.ts';
import { usePhotoEngine } from './photoEngine.tsx';
import { PRINT_SCALE_RANGE, readPrintScale, SHEET_RULER, writePrintScale } from './photoModel.ts';
import styles from './SheetPrint.module.css';

const PAPERS: SheetPaper[] = ['letter', 'a4'];
const WHICH = ['A', 'B'] as const;
type Which = (typeof WHICH)[number];
type SheetMaker = (paper: SheetPaper, which?: Which) => CalibrationSheet;

/** After printing: the person measures the ruler; what they got over its length is the printer's scale, kept per paper. */
function PrintCheck({ paper }: { paper: SheetPaper }) {
  const ruler = SHEET_RULER[paper];
  const [text, setText] = useState(() => String(Math.round(readPrintScale(paper) * ruler.length * 1000) / 1000));
  const [saved, setSaved] = useState<number | null>(null);
  const measured = Number.parseFloat(text);
  const scale = Number.isFinite(measured) && measured > 0 ? measured / ruler.length : null;
  const off = scale !== null && (scale < PRINT_SCALE_RANGE[0] || scale > PRINT_SCALE_RANGE[1]);
  const pct = scale === null ? '' : (scale * 100).toFixed(1);
  return (
    <fieldset className={styles.check} data-print-check={paper}>
      <legend className={styles.checkTitle}>{copy.printCheckTitle}</legend>
      <p className={styles.intro}>{copy.printCheckHint(ruler.length, ruler.unit)}</p>
      <Field
        label={copy.printCheckField(ruler.unit)}
        type="number"
        inputMode="decimal"
        step={ruler.unit === 'in' ? 0.0625 : 0.1}
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setSaved(null);
        }}
      />
      {scale !== null && !off ? <p className={styles.intro}>{copy.printCheckScale(pct)}</p> : null}
      {off ? <Banner tone="warning">{copy.printCheckOff}</Banner> : null}
      <Button
        variant="ghost"
        className={styles.action}
        disabled={scale === null || off}
        onClick={() => {
          if (scale === null || off) return;
          writePrintScale(paper, scale);
          setSaved(scale);
        }}
      >
        {copy.save}
      </Button>
      {saved !== null ? (
        <p role="status" className={styles.intro}>
          {copy.printCheckSaved((saved * 100).toFixed(1))}
        </p>
      ) : null}
    </fieldset>
  );
}

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
  const [which, setWhich] = useState<Which>('A');
  // Sheet A and sheet B (two sheets for a big window) when the engine prints distinct sheets
  const make = engine.cv === null ? null : (engine.cv.calibrationSheet as SheetMaker);
  const hasB = make !== null && make.length >= 2;
  const sheet = useMemo(() => (make === null ? null : hasB ? make(paper, which) : make(paper)), [make, hasB, paper, which]);
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
      <p className={styles.intro}>{copy.bigWindow}</p>
      {hasB ? (
        <div className={styles.which} role="radiogroup" aria-label={copy.sheetPick}>
          {WHICH.map((w, i) => (
            <Button key={w} variant="ghost" role="radio" aria-checked={which === w} className={styles.whichButton} data-selected={which === w ? 'true' : undefined} onClick={() => setWhich(w)}>
              {copy.sheetLetters[i]}
            </Button>
          ))}
        </div>
      ) : null}
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
              <a className={styles.download} href={href} download={copy.downloadName(hasB ? `${paper}-${which.toLowerCase()}` : paper)}>
                {copy.download}
              </a>
            ) : null}
          </div>
          <Banner tone="info">{copy.printRulerCheck}</Banner>
          <PrintCheck key={paper} paper={paper} />
          <PrintPage sheet={sheet} />
        </>
      )}
      <Button variant="ghost" className={styles.action} onClick={onClose}>
        {copy.back}
      </Button>
    </section>
  );
}
