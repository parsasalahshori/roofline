import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@roofline/ui';
import { homeowner } from '../../copy/homeowner.ts';
import styles from './SignaturePad.module.css';

export type SignaturePadProps = {
  /** Called with the raw base64 of a PNG (no "data:image/png;base64," prefix), or null when empty or cleared. */
  onChange(png: string | null): void;
  disabled?: boolean;
  /** A heading over the pad, with Clear at its right edge. */
  heading?: string;
};

/** The drawing height on screen, in CSS pixels. Matches SignaturePad.module.css. */
const CSS_HEIGHT = 140;
/** The backing store is capped so the exported PNG stays well under 200 KB. */
const MAX_WIDTH = 600;
const MAX_HEIGHT = 240;
const MAX_DPR = 2;
/*
 * What the drawing is made of, in both themes: dark ink on white paper. The PNG that goes into the signed copy is
 * those pixels, so it must not follow the theme; on screen in dark mode the whole canvas is inverted by CSS instead.
 */
const INK = '#2b2620';
const PAPER = '#ffffff';
const DATA_PREFIX = 'data:image/png;base64,';

type Point = { x: number; y: number };

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d');
}

function pointOf(event: ReactPointerEvent<HTMLCanvasElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function capturePointer(canvas: HTMLCanvasElement, pointerId: number): void {
  if (typeof canvas.setPointerCapture !== 'function') return;
  try {
    canvas.setPointerCapture(pointerId);
  } catch {
    // Not an active pointer: drawing still works without capture.
  }
}

/** The PNG of the canvas as raw base64, or null when there is nothing to send. */
function exportPng(canvas: HTMLCanvasElement): string | null {
  const url = String(canvas.toDataURL('image/png'));
  const png = url.startsWith(DATA_PREFIX) ? url.slice(DATA_PREFIX.length) : '';
  return png === '' ? null : png;
}

export function SignaturePad({ onChange, disabled = false, heading }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const last = useRef<Point | null>(null);

  // Size the backing store once, scaled by the screen density, and paper-fill it so the PNG has a white background.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cssWidth = canvas.getBoundingClientRect().width || MAX_WIDTH / MAX_DPR;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.min(MAX_WIDTH, Math.round(cssWidth * dpr));
    canvas.height = Math.min(MAX_HEIGHT, Math.round(CSS_HEIGHT * dpr));
    const ctx = context(canvas);
    if (!ctx) return;
    // Points are in CSS pixels; the transform maps them onto the backing store.
    ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / CSS_HEIGHT, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, cssWidth, CSS_HEIGHT);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const canvas = event.currentTarget;
    capturePointer(canvas, event.pointerId);
    const point = pointOf(event);
    last.current = point;
    const ctx = context(canvas);
    if (ctx) {
      // A zero-length line with round caps leaves a dot for a single tap.
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const from = last.current;
    if (disabled || !from) return;
    const point = pointOf(event);
    const ctx = context(event.currentTarget);
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    last.current = point;
  }

  function endStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!last.current) return;
    last.current = null;
    onChange(exportPng(event.currentTarget));
  }

  function clear() {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = context(canvas);
      if (ctx) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
    }
    last.current = null;
    onChange(null);
  }

  return (
    <div className={styles.pad}>
      <div className={styles.head}>
        {heading ? <h3 className={styles.heading}>{heading}</h3> : <span />}
        <Button type="button" variant="ghost" className={styles.clear} disabled={disabled} onClick={clear}>
          {homeowner.clearDrawing}
        </Button>
      </div>
      <div className={styles.well}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          data-testid="signature-pad"
          role="img"
          aria-label={homeowner.drawLabel}
          aria-disabled={disabled ? true : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
        <span className={styles.base} aria-hidden="true" />
        <span className={styles.cross} aria-hidden="true">
          {'\u00d7'}
        </span>
      </div>
    </div>
  );
}
