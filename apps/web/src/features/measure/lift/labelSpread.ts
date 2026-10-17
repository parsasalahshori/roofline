/** Where a label point sits on the screen, in pixels. */
export type ScreenPoint = { x: number; y: number };

/**
 * Pushes labels apart until none is closer than `min` pixels to another, and returns how far each moved, as the
 * offsets to give its marker. Two labels that share a spot split sideways, in order. Labels that are already clear
 * of each other do not move; the push is as small as it can be (each of a pair takes half), a few passes at most.
 */
export function spreadLabels(at: readonly ScreenPoint[], min: number): [number, number][] {
  const pos = at.map((p) => ({ x: p.x, y: p.y }));
  for (let pass = 0; pass < 24; pass += 1) {
    let moved = false;
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = i + 1; j < pos.length; j += 1) {
        const a = pos[i]!;
        const b = pos[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.01) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (min - d) / 2 + 0.5;
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pos.map((p, i) => [Math.round(p.x - at[i]!.x), Math.round(p.y - at[i]!.y)]);
}
