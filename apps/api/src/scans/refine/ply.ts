/** The vertices of an ascii PLY (`x y z [red green blue]` per line after `end_header`), evenly thinned to at most `max`: [x, y, z, r, g, b] each. */
export function plyPoints(text: string, max = 4000): number[][] {
  const lines = text.split('\n');
  const end = lines.findIndex((l) => l.trim() === 'end_header');
  if (end < 0) return [];
  const declared = Number(lines.slice(0, end).find((l) => l.startsWith('element vertex'))?.split(/\s+/)[2] ?? 0);
  const all: number[][] = [];
  for (let i = end + 1; i < lines.length && all.length < declared; i++) {
    const f = lines[i]!.trim().split(/\s+/);
    if (f.length < 3) continue;
    const [x, y, z] = [Number(f[0]), Number(f[1]), Number(f[2])];
    if (![x, y, z].every(Number.isFinite)) continue;
    all.push([x, y, z, Number(f[3] ?? 150), Number(f[4] ?? 150), Number(f[5] ?? 150)]);
  }
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, i) => all[Math.floor((i * all.length) / max)]!);
}
