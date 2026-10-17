// Turns cases.json (gen-cases.ts: the real TypeScript's answers) into CardParityData.swift for the Swift check suite.
//   node apps/ios/Core/scripts/card-parity/emit-swift.mjs /tmp/cases.json > apps/ios/Core/Sources/RooflineCoreCheckSuite/CardParityData.swift
import { readFileSync } from 'node:fs';

const d = JSON.parse(readFileSync(process.argv[2], 'utf8'));

/** A JSON number (or the strings NaN, Infinity, -Infinity) as a Swift Double literal. */
const num = (v) => {
  if (v === 'NaN') return '.nan';
  if (v === 'Infinity') return '.infinity';
  if (v === '-Infinity') return '-Double.infinity';
  if (typeof v !== 'number') throw new Error(`not a number: ${v}`);
  return JSON.stringify(v);
};
const opt = (v) => (v === null ? 'nil' : num(v));
const str = (s) => JSON.stringify(s);
const flat = (q) => `[${q.map(([x, y]) => `${num(x)}, ${num(y)}`).join(', ')}]`;
const sizeOf = (s) => (s === null ? 'nil' : `[${[s.widthIn, s.heightIn, s.uncertaintyIn.width, s.uncertaintyIn.height, s.distanceIn, s.viewAngleDeg, s.sizeRatio].map(num).join(', ')}]`);
const reasons = (s) => `[${(s ? s.reasons : []).map(str).join(', ')}]`;

const lines = [];
lines.push(`import Foundation
import RooflineCore

// GENERATED, do not edit by hand. The server's answers for ${d.cases.length} photos, ${d.low.length} option sets and ${d.words.length} numbers in words, from its REAL
// TypeScript (packages/shared/src/window-photo-card.ts, last changed in commit ${d.meta.cardFileCommit}; the API worktree was at ${d.meta.head} on ${d.meta.branch}${d.meta.dirty ? ', with uncommitted changes' : ''}), run with Node 22 and tsx.
//
// Each photo case is what the server's \`sizePhotoWindow\` card branch (apps/api/src/estimator/window-uploads.ts) does with a
// photo of widthPx x heightPx whose EXIF 35 mm focal length is \`focal35mm\` (nil: the photo says nothing):
//
//   const problem = cardProblem({ widthPx, heightPx, cardCorners: card, windowCorners: win, card: { widthMm: 85.6, heightMm: 53.98 } });
//   const focalPx = focalPxFrom35mm(focal35mm ?? 26, widthPx, heightPx);
//   const focalSigmaFrac = focal35mm === null ? SHEET_FOCAL_UNKNOWN_SIGMA : undefined;
//   const size = sizeFromCard({ widthPx, heightPx, focalPx, ...(focalSigmaFrac !== undefined && { focalSigmaFrac }), cardCorners: card, windowCorners: win });
//
// \`problem\` is the sentence a 422 would say (nil: none) and \`size\` is sizeFromCard's answer on the same points, whether or
// not there is a problem (nil: the server cannot size it): widthIn, heightIn, uncertainty width, uncertainty height,
// distanceIn, viewAngleDeg, sizeRatio, then quality and reasons. Corners are x, y pairs in photo pixels (the card in the order
// tapped, the window TL, TR, BR, BL), rounded to 0.01 px. Doubles are JSON.stringify's shortest round-trip text, so the
// literals are the server's doubles exactly.

struct CardParityCase {
    let name: String
    let widthPx: Double
    let heightPx: Double
    let focal35mm: Double?
    let card: [Double]
    let win: [Double]
    let problem: String?
    let size: [Double]?
    let quality: String
    let reasons: [String]

    init(_ name: String, _ widthPx: Double, _ heightPx: Double, _ focal35mm: Double?, card: [Double], win: [Double], problem: String?, size: [Double]?, quality: String, reasons: [String]) {
        self.name = name
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.focal35mm = focal35mm
        self.card = card
        self.win = win
        self.problem = problem
        self.size = size
        self.quality = quality
        self.reasons = reasons
    }

    var cardCorners: [Vec2] { stride(from: 0, to: card.count, by: 2).map { Vec2(card[$0], card[$0 + 1]) } }
    var windowCorners: [Vec2] { stride(from: 0, to: win.count, by: 2).map { Vec2(win[$0], win[$0 + 1]) } }
}

/// The low-level entry point (CardSizing.sizeFromCard) with explicit options: nil is "not given", so the default.
struct CardParityLowLevel {
    let name: String
    let widthPx: Double
    let heightPx: Double
    let focalPx: Double
    let focalSigmaFrac: Double?
    let planeOffsetIn: Double?
    let tapSigmaPx: Double?
    let card: [Double]
    let win: [Double]
    let size: [Double]?
    let quality: String
    let reasons: [String]

    init(_ name: String, _ widthPx: Double, _ heightPx: Double, _ focalPx: Double, focalSigmaFrac: Double?, planeOffsetIn: Double?, tapSigmaPx: Double?, card: [Double], win: [Double], size: [Double]?, quality: String, reasons: [String]) {
        self.name = name
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.focalPx = focalPx
        self.focalSigmaFrac = focalSigmaFrac
        self.planeOffsetIn = planeOffsetIn
        self.tapSigmaPx = tapSigmaPx
        self.card = card
        self.win = win
        self.size = size
        self.quality = quality
        self.reasons = reasons
    }

    var cardCorners: [Vec2] { stride(from: 0, to: card.count, by: 2).map { Vec2(card[$0], card[$0 + 1]) } }
    var windowCorners: [Vec2] { stride(from: 0, to: win.count, by: 2).map { Vec2(win[$0], win[$0 + 1]) } }
}
`);

lines.push('let cardParityCases: [CardParityCase] = [');
for (const c of d.cases) {
  const s = c.server.size;
  lines.push(
    `    CardParityCase(${str(c.name)}, ${num(c.widthPx)}, ${num(c.heightPx)}, ${opt(c.focal35mm)},`,
    `        card: ${flat(c.card)},`,
    `        win: ${flat(c.win)},`,
    `        problem: ${c.server.problem === null ? 'nil' : str(c.server.problem)},`,
    `        size: ${sizeOf(s)}, quality: ${str(s ? s.quality : '')}, reasons: ${reasons(s)}),`,
  );
}
lines.push(']', '');

lines.push('let cardParityLowLevel: [CardParityLowLevel] = [');
for (const c of d.low) {
  const s = c.size;
  lines.push(
    `    CardParityLowLevel(${str(c.name)}, ${num(c.widthPx)}, ${num(c.heightPx)}, ${num(c.focalPx)}, focalSigmaFrac: ${opt(c.focalSigmaFrac)}, planeOffsetIn: ${opt(c.planeOffsetIn)}, tapSigmaPx: ${opt(c.tapSigmaPx)},`,
    `        card: ${flat(c.card)},`,
    `        win: ${flat(c.win)},`,
    `        size: ${sizeOf(s)}, quality: ${str(s ? s.quality : '')}, reasons: ${reasons(s)}),`,
  );
}
lines.push(']', '');

lines.push('/// inchesInWords (the server\'s) for numbers from 0 up to a million.');
lines.push('let cardParityWords: [(Double, String)] = [');
for (const w of d.words) lines.push(`    (${num(w.inches)}, ${str(w.words)}),`);
lines.push(']', '');

process.stdout.write(lines.join('\n'));
