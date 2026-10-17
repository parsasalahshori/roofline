import { fractionInches } from '@roofline/shared';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { measureWindows as copy } from '../../../copy/measureWindows.ts';
import styles from './ElevationDrawing.module.css';
import { wallDrawn, windowShownAt } from './PhotoStage.tsx';
import type { DrawnWindow } from './rows.ts';

const DEFAULT_SIZE = { w: 800, h: 268 };
/** Room round the house for the dimension lines and the labels. */
const PAD = { left: 56, right: 84, top: 44, bottom: 46 };
/** A phone's drawing is narrow: the dimension lines get less room. */
const PAD_NARROW = { left: 18, right: 62, top: 40, bottom: 40 };
/** The narrowest drawing that gets the roomy padding, px. */
const NARROW_BELOW = 520;
/** Between windows and from the wall's ends, px. */
const MIN_GAP = 10;
const END_MARGIN = 18;
/** A window narrower than this loses its tag (the selected one keeps it), px. */
const TAG_MIN_W = 24;
/** An unsurveyed wall's height per floor, feet (the estimate's own assumption). */
export const FLOOR_FT = 9;

export type Box = { key: string; tag: string; widthIn: number; x: number; y: number; w: number; h: number; status: DrawnWindow['status']; estimated: boolean; rowKey: string };

/**
 * The windows laid along a wall, left to right in table order, floor by floor (the ground floor first). Each is drawn to
 * scale (inches times `pxPerIn`); where one sits along the wall is not recorded, so the gaps are even. Returns what
 * fits and how many did not.
 */
export function layoutWindows(args: {
  windows: readonly DrawnWindow[];
  wall: { x: number; ground: number; width: number; height: number; floors: number };
  pxPerIn: number;
}): { boxes: Box[]; hidden: number } {
  const { wall, pxPerIn } = args;
  const floorH = wall.height / wall.floors;
  const rows: DrawnWindow[][] = Array.from({ length: wall.floors }, () => []);
  const usable = wall.width - 2 * END_MARGIN;
  const used = new Array<number>(wall.floors).fill(0);
  let hidden = 0;
  let floor = 0;
  for (const w of args.windows) {
    const wpx = w.widthIn * pxPerIn;
    // The next floor takes what does not fit on this one
    while (floor < wall.floors && used[floor]! > 0 && used[floor]! + wpx + MIN_GAP > usable) floor += 1;
    if (floor >= wall.floors || wpx > usable) {
      hidden += 1;
      continue;
    }
    rows[floor]!.push(w);
    used[floor] = used[floor]! + wpx + MIN_GAP;
  }
  const boxes: Box[] = [];
  rows.forEach((row, f) => {
    const total = row.reduce((sum, w) => sum + w.widthIn * pxPerIn, 0);
    const gap = (usable - total) / (row.length + 1);
    const bandBottom = wall.ground - f * floorH;
    let x = wall.x + END_MARGIN + gap;
    for (const w of row) {
      const wpx = w.widthIn * pxPerIn;
      const hpx = Math.min(w.heightIn * pxPerIn, floorH - 8);
      const y = bandBottom - floorH * 0.5 - hpx / 2;
      boxes.push({ key: `${w.rowKey}:${w.tag}`, tag: w.tag, widthIn: w.widthIn, x, y, w: wpx, h: hpx, status: w.status, estimated: w.estimated, rowKey: w.rowKey });
      x += wpx + gap;
    }
  });
  return { boxes, hidden };
}

/** The element's size in px, kept up to date (a fixed size where there is no layout: a test, a server). */
function useBox(ref: RefObject<Element | null>): { w: number; h: number } {
  const [size, setSize] = useState(DEFAULT_SIZE);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

type Frame = { W: number; H: number };

/** The windows' boxes, their tags, and the dimension of the selected one: what both layouts draw the same way. */
function Windows({ boxes, selectedKey, progress, onSelect, ground }: { boxes: readonly Box[]; selectedKey: string | null; progress: number; onSelect: (rowKey: string) => void; ground: number }): ReactNode {
  const shown = boxes.filter((_, i) => progress >= 1 || progress >= windowShownAt(i, boxes.length));
  const selected = progress >= 1 ? (boxes.find((b) => b.rowKey === selectedKey && b.status !== 'out') ?? null) : null;
  // The size over the picked window, or under it where the top of the drawing has no room
  const above = selected !== null && selected.y - 58 >= 4;
  const dimY = selected === null ? 0 : above ? selected.y - 34 : Math.min(ground + 6, selected.y + selected.h + 12);
  const chipY = above ? dimY - 24 : dimY + 6;
  return (
    <>
      {shown.map((b) => {
        const on = b.rowKey === selectedKey;
        return (
          <g
            key={b.key}
            className={styles.window}
            data-drawn-window=""
            data-drawn-row={b.rowKey}
            data-status={b.status}
            data-estimated={b.estimated ? 'true' : undefined}
            data-selected={on ? 'true' : undefined}
            onClick={() => onSelect(b.rowKey)}
          >
            <rect x={b.x} y={b.y} width={b.w} height={b.h} className={styles.frame} />
            {b.estimated ? null : <rect x={b.x + 3} y={b.y + 3} width={Math.max(0, b.w - 6)} height={Math.max(0, b.h - 6)} className={styles.glass} />}
            {b.w >= TAG_MIN_W || on ? (
              <g className={styles.tag} data-status={b.status} data-selected={on ? 'true' : undefined}>
                <rect x={b.x + b.w / 2 - 17} y={b.y - 24} width={34} height={18} rx={3} />
                <text x={b.x + b.w / 2} y={b.y - 11} textAnchor="middle">
                  {b.tag}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
      {selected !== null && !selected.estimated ? (
        <>
          <path className={styles.dim} d={`M${selected.x} ${dimY}H${selected.x + selected.w}M${selected.x} ${dimY - 6}v12M${selected.x + selected.w} ${dimY - 6}v12`} />
          <g className={styles.sizeChip}>
            <rect x={selected.x + selected.w / 2 - 40} y={chipY} width={80} height={20} rx={3} />
            <text x={selected.x + selected.w / 2} y={chipY + 14} textAnchor="middle">
              {copy.elevation.inches(fractionInches(selected.widthIn))}
            </text>
          </g>
        </>
      ) : null}
    </>
  );
}

/**
 * "+2 more": the windows that did not fit. It sits in the drawing's lower corner, outside the house: on the wall it ran into
 * the tallest windows (and their tags), and on a phone it cut across the last window's outline. Below the right-hand end of the
 * ground line nothing else is drawn, so it can never cover anything.
 */
function Unseen({ frame, hidden }: { frame: Frame; hidden: number }): ReactNode {
  return (
    <text x={frame.W - 8} y={frame.H - 8} textAnchor="end" className={styles.more} data-unseen-windows="">
      {copy.elevation.more(hidden)}
    </text>
  );
}

/** The house: a roof, the front wall with its length and height, the ground. The windows go on it at their sizes. */
function House({ frame, wallFt, eave, floors, windows, progress, selectedKey, onSelect }: { frame: Frame; wallFt: number; eave: number; floors: number; windows: readonly DrawnWindow[]; progress: number; selectedKey: string | null; onSelect: (rowKey: string) => void }): ReactNode {
  const { W, H } = frame;
  const pad = W < NARROW_BELOW ? PAD_NARROW : PAD;
  const availW = W - pad.left - pad.right;
  const availH = H - pad.top - pad.bottom;
  const roofH = Math.min(62, Math.max(26, availH * 0.28));
  const wallMaxH = Math.max(40, availH - roofH);
  const perFt = Math.max(1, Math.min(availW / wallFt, wallMaxH / eave));
  const ww = wallFt * perFt;
  const wh = eave * perFt;
  const wx = pad.left + (availW - ww) / 2;
  const ground = H - pad.bottom;
  const top = ground - wh;
  const inset = Math.min(80, Math.max(14, ww * 0.12));
  const drawn = progress >= 1 ? 1 : wallDrawn(progress);
  const done = drawn >= 1;
  const { boxes, hidden } = layoutWindows({ windows, wall: { x: wx, ground, width: ww, height: wh, floors }, pxPerIn: perFt / 12 });
  const lap = Math.min(20, Math.max(12, wh / 6));
  const laps: number[] = [];
  for (let y = top + lap; y < ground - 4; y += lap) laps.push(y);
  const dimY = ground + 22;
  const sideX = wx + ww + 30;
  const roofPath = `M${wx - 10} ${top} L${wx + inset} ${top - roofH} H${wx + ww - inset} L${wx + ww + 10} ${top} Z`;
  return (
    <>
      {/* Nothing is drawn before the scan begins: a ground line alone would poke out from under the card that asks for it */}
      {drawn > 0 ? (
        <>
          <path d={roofPath} className={styles.roof} pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - Math.min(1, drawn * 2) }} />
          <rect x={wx} y={top} width={ww} height={wh} className={styles.wall} pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - drawn }} />
          <path d={`M${Math.max(8, wx - 70)} ${ground}H${Math.min(W - 8, wx + ww + 70)}`} className={styles.ground} />
        </>
      ) : null}
      {done ? <path d={laps.map((y) => `M${wx} ${y}H${wx + ww}`).join('')} className={styles.laps} /> : null}
      <Windows boxes={boxes} selectedKey={selectedKey} progress={progress} onSelect={onSelect} ground={ground} />
      {done ? (
        <>
          <path className={styles.dim} d={`M${wx} ${dimY}H${wx + ww}M${wx} ${dimY - 8}v16M${wx + ww} ${dimY - 8}v16M${sideX} ${top}V${ground}M${sideX - 8} ${top}h16M${sideX - 8} ${ground}h16`} />
          <g className={styles.dimLabel}>
            <rect x={wx + ww / 2 - 30} y={dimY - 10} width={60} height={20} />
            <text x={wx + ww / 2} y={dimY + 5} textAnchor="middle">
              {copy.elevation.feet(Math.round(wallFt))}
            </text>
            <rect x={sideX + 8} y={top + wh / 2 - 10} width={52} height={20} />
            <text x={sideX + 14} y={top + wh / 2 + 5}>
              {copy.elevation.feet(Math.round(eave))}
            </text>
          </g>
          {hidden > 0 ? <Unseen frame={frame} hidden={hidden} /> : null}
        </>
      ) : null}
    </>
  );
}

/** The walls are not known: the windows alone, in a row on the ground line, at their sizes. */
function Row({ frame, windows, progress, selectedKey, onSelect }: { frame: Frame; windows: readonly DrawnWindow[]; progress: number; selectedKey: string | null; onSelect: (rowKey: string) => void }): ReactNode {
  const { W, H } = frame;
  const pad = W < NARROW_BELOW ? PAD_NARROW : PAD;
  const availW = W - Math.min(pad.left, 24) - Math.min(pad.right, 24);
  const availH = H - pad.top - pad.bottom;
  const widthIn = windows.reduce((sum, w) => sum + w.widthIn, 0);
  const tallest = Math.max(1, ...windows.map((w) => w.heightIn));
  const perIn = Math.min(Math.max(0.3, (availW - (windows.length + 1) * MIN_GAP) / Math.max(widthIn, 1)), (availH * 0.78) / tallest, 2.4);
  const ground = H - pad.bottom;
  const x = (W - availW) / 2;
  const { boxes, hidden } = layoutWindows({ windows, wall: { x, ground, width: availW, height: availH, floors: 1 }, pxPerIn: perIn });
  return (
    <>
      <path d={`M${Math.max(8, x)} ${ground}H${Math.min(W - 8, x + availW)}`} className={styles.ground} />
      <Windows boxes={boxes} selectedKey={selectedKey} progress={progress} onSelect={onSelect} ground={ground} />
      {hidden > 0 && progress >= 1 ? <Unseen frame={frame} hidden={hidden} /> : null}
    </>
  );
}

/**
 * The windows drawn to scale on grid paper from what was measured. With the walls known it is the front of the house:
 * the wall's length and the eave height (feet, from the outline and the height map) in tape-yellow dimension lines, each
 * window at its measured size, an estimated one dashed at its class's usual size. Without the walls it is the windows
 * alone in a row. The picked window is tape yellow with its width over it. While the scan plays the wall draws itself
 * and the windows come in one by one.
 */
export function ElevationDrawing({
  wallFt,
  heightFt,
  floors,
  windows,
  progress,
  selectedKey,
  onSelect,
  label,
}: {
  /** The front wall's length, feet; null when the walls are not known. */
  wallFt: number | null;
  heightFt: number | null;
  floors: number | null;
  windows: readonly DrawnWindow[];
  /** 0..1: how far the scan has drawn it. 1 shows everything. */
  progress: number;
  selectedKey: string | null;
  onSelect: (rowKey: string) => void;
  label: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { w: W, h: H } = useBox(hostRef);
  const floorCount = Math.min(3, Math.max(1, Math.floor(floors ?? 1)));
  const eave = heightFt !== null && heightFt > 0 ? heightFt : floorCount * FLOOR_FT;
  const house = wallFt !== null && wallFt > 0;
  const empty = !house && windows.length === 0;
  return (
    <div ref={hostRef} className={styles.paper} data-mode={house ? 'house' : empty ? 'empty' : 'row'}>
      <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label} focusable="false">
        {house ? (
          <House frame={{ W, H }} wallFt={wallFt} eave={eave} floors={floorCount} windows={windows} progress={progress} selectedKey={selectedKey} onSelect={onSelect} />
        ) : empty ? null : (
          <Row frame={{ W, H }} windows={windows} progress={progress} selectedKey={selectedKey} onSelect={onSelect} />
        )}
      </svg>
      {empty ? <p className={styles.unknown}>{copy.elevation.noWalls}</p> : null}
    </div>
  );
}
