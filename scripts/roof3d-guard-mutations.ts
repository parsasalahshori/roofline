// Mutation check for the hidden-edge steps' guards (outline-planes.ts, outline-photo.ts and their orchestration in
// roof-reconstruct/index.ts). Each mutation disables one guard; the guard tests must then fail. A mutation that
// survives (the tests still pass) is a guard no test covers, which is what review found in the outline round: the
// release notes said every move is guarded, and deleting a guard was invisible to the suite.
//
//   npm run roof3d:mutate-guards            # every mutation; exit 1 when any survives
//   npm run roof3d:mutate-guards -- P-yard-visible   # only the named ones
//
// It edits the source files in place, one mutation at a time, and always restores them (also on Ctrl-C). It refuses
// to start when those files have uncommitted changes (--allow-dirty overrides, while developing), so a crash cannot
// leave a mutation behind unnoticed.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLANES = 'packages/shared/src/roof-reconstruct/outline-planes.ts';
const PHOTO = 'packages/shared/src/roof-reconstruct/outline-photo.ts';
const INDEX = 'packages/shared/src/roof-reconstruct/index.ts';
const TESTS = [
  'packages/shared/test/roof-reconstruct-guards.test.ts',
  'packages/shared/test/roof-reconstruct-notch.test.ts',
  'packages/shared/test/roof-reconstruct-hidden-edge-safety.test.ts',
  'packages/shared/test/roof-reconstruct-planes.test.ts',
  'packages/shared/test/roof-reconstruct-photo-edges.test.ts',
];

type Mutation = { id: string; file: string; from: string; to: string };
export const MUTATIONS: Mutation[] = [
  // Planes: per-piece gates.
  { id: 'P-offset', file: PLANES, from: '      rep.minOffsetM < p.minOffsetM ||', to: '      false && (rep.minOffsetM < p.minOffsetM) ||' },
  { id: 'P-offset-inner', file: PLANES, from: '(inner.length > 0 && Math.max(...inner) > p.maxOffsetM) ||', to: 'false ||' },
  { id: 'P-disagrees-visible', file: PLANES, from: 'if (seen.length >= 5 && median(', to: 'if (false && median(' },
  { id: 'P-other-building', file: PLANES, from: '    if (sw.other > 0) {', to: '    if (false) {' },
  { id: 'P-yard-visible', file: PLANES, from: '    if (sw.ground > p.yardShare) {', to: '    if (false) {' },
  { id: 'P-roof-visible', file: PLANES, from: '    if (sw.removed * s * s >= 0.5 && sw.onPlane > p.onPlaneShare) {', to: '    if (false) {' },
  { id: 'P-unconfirmed', file: PLANES, from: '    if (p.minDeepSeenShare > 0 && sw.deep * s * s >= p.maxUnconfirmedM2 && sw.deepSeen < p.minDeepSeenShare) {', to: '    if (false) {' },
  // Planes: whole-ring checks (sound()).
  { id: 'P-area', file: PLANES, from: "    if (Math.abs(signedArea(b.ring) - area0) > p.maxAreaChange * area0) return 'large-change';", to: '' },
  { id: 'P-crease', file: PLANES, from: '|| Math.abs(planeZ(pi, c.at.x, c.at.y) - planeZ(pj, c.at.x, c.at.y)) / gd > p.creaseTolM) return', to: ') return' },
  { id: 'P-chamfer-other', file: PLANES, from: "          if (input.other !== null && input.other[i] === 1) return 'other-building';", to: '' },
  { id: 'P-chamfer-yard', file: PLANES, from: "      if (added > 0 && ground / added > p.yardShare) return 'yard-visible';", to: '' },
  { id: 'P-chamfer-unconfirmed', file: PLANES, from: "deepSeen < p.minDeepSeenShare * deep) return 'unconfirmed';", to: "false) return 'unconfirmed';" },
  // Photo: per-edge gates.
  { id: 'F-not-crown', file: PHOTO, from: '    if (crownN + roughN < p.minCrownShare * hidden.length) {', to: '    if (false) {' },
  { id: 'F-weak-contrast', file: PHOTO, from: '    if (bestK < p.minContrast) {', to: '    if (false) {' },
  { id: 'F-gain', file: PHOTO, from: '    if (k0 !== null && bestK - k0 < p.minGain) {', to: '    if (false) {' },
  { id: 'F-consensus', file: PHOTO, from: '    if (opinions < p.minColumns * cols.length || agree < p.minConsensus * opinions) {', to: '    if (false) {' },
  { id: 'F-ground', file: PHOTO, from: '    if (best > 0 && (swept === 0 || ground > p.maxGroundShare * swept)) {', to: '    if (false) {' },
  { id: 'F-neighbour-roof', file: PHOTO, from: '    if (best > 0 && neighbour > p.maxNeighbourShare * swept) {', to: '    if (false) {' },
  { id: 'F-not-occluded', file: PHOTO, from: '    if (best < 0 && (swept === 0 || occluded < p.minOccluded * swept)) {', to: '    if (false) {' },
  // Photo: whole-ring check.
  {
    id: 'F-area',
    file: PHOTO,
    from: "    else if (Math.abs(Math.abs(signedArea(built.ring)) - Math.abs(area0)) > p.maxAreaChange * Math.abs(area0)) bad = 'large-change';",
    to: '',
  },
  // Orchestration.
  {
    id: 'I-combined-cap',
    file: INDEX,
    from: '    if (stepRings.length > 1 && !combinedChangeOk(stepRings[0]!, stepRings.at(-1)!, { ...HIDDEN_EDGE_LIMITS, ...opts.hiddenEdge?.limits })) {',
    to: '    if (false) {',
  },
  { id: 'I-photo-catch', file: INDEX, from: "          done = { outline: null, record: { method: 'photo', edges: [], moved: [], declined: 'error' } };", to: '          throw new Error();' },
  { id: 'I-roof-inferred', file: INDEX, from: "quality.reasons.push('roof-inferred');", to: ';' },
];

function runTests(): { failed: boolean; line: string } {
  const r = spawnSync('npx', ['vitest', 'run', '--project', '@roofline/shared', ...TESTS], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const line = out.split('\n').find((l) => l.trim().startsWith('Tests ')) ?? '';
  return { failed: r.status !== 0, line: line.trim() };
}

function main(): void {
  const args = process.argv.slice(2);
  const only = args.filter((a) => !a.startsWith('--'));
  const chosen = only.length > 0 ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;
  const files = [...new Set(chosen.map((m) => m.file))];
  if (!args.includes('--allow-dirty')) execFileSync('git', ['diff', '--quiet', '--', ...files], { cwd: ROOT });
  const baseline = runTests();
  if (baseline.failed) throw new Error(`the guard tests fail without any mutation: ${baseline.line}`);
  let current: { file: string; text: string } | null = null;
  const restore = () => {
    if (current !== null) writeFileSync(path.join(ROOT, current.file), current.text);
    current = null;
  };
  process.on('SIGINT', () => {
    restore();
    process.exit(130);
  });
  const survived: string[] = [];
  for (const m of chosen) {
    const text = readFileSync(path.join(ROOT, m.file), 'utf8');
    const n = text.split(m.from).length - 1;
    if (n !== 1) throw new Error(`${m.id}: the mutated text occurs ${n} times in ${m.file} (update the mutation)`);
    current = { file: m.file, text };
    try {
      writeFileSync(path.join(ROOT, m.file), text.replace(m.from, m.to));
      const r = runTests();
      console.log(`${m.id.padEnd(24)} ${r.failed ? 'killed  ' : 'SURVIVED'} ${r.line}`);
      if (!r.failed) survived.push(m.id);
    } finally {
      restore();
    }
  }
  console.log(survived.length === 0 ? `all ${chosen.length} mutations killed` : `${survived.length} of ${chosen.length} survived: ${survived.join(', ')}`);
  if (survived.length > 0) process.exitCode = 1;
}

main();
