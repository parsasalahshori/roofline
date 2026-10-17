import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** The dark modules of a QR code for `value`, as the d attribute of one SVG path (one 1 x 1 square per module). */
export function qrPath(value: string): { path: string; size: number } {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
  }
  return { path, size };
}

/** A QR code for a link, drawn as inline SVG: black on white with a 4-module quiet zone, readable on any background. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { path, size } = useMemo(() => qrPath(value), [value]);
  const quiet = 4;
  return (
    <svg
      className={className}
      viewBox={`${-quiet} ${-quiet} ${size + 2 * quiet} ${size + 2 * quiet}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-qr=""
    >
      <rect x={-quiet} y={-quiet} width={size + 2 * quiet} height={size + 2 * quiet} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
