import SwiftUI

/// A small SVG path reader (M L H V C S Q A Z, absolute and relative), so the mockups' own icon and illustration paths
/// can be used as they are: the mockups' look is the spec, and redrawing 25 icons by hand would drift from it.
enum SVGPath {
    /// The path for the data string, in the SVG's own units.
    static func path(_ d: String) -> Path {
        var p = Path()
        var tokens = Tokenizer(d)
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?
        var lastCommand: Character = " "

        func point(_ t: inout Tokenizer, relative: Bool) -> CGPoint? {
            guard let x = t.number(), let y = t.number() else { return nil }
            return relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
        }

        while let cmd = tokens.command() {
            let relative = cmd.isLowercase
            let upper = Character(cmd.uppercased())
            var first = true
            // A command letter may be followed by several coordinate sets
            repeat {
                let before = tokens.position
                switch upper {
                case "M":
                    guard let pt = point(&tokens, relative: relative) else { break }
                    if first {
                        p.move(to: pt)
                        start = pt
                    } else {
                        p.addLine(to: pt)
                    }
                    current = pt
                    lastControl = nil
                case "L":
                    guard let pt = point(&tokens, relative: relative) else { break }
                    p.addLine(to: pt)
                    current = pt
                    lastControl = nil
                case "H":
                    guard let x = tokens.number() else { break }
                    current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                    p.addLine(to: current)
                    lastControl = nil
                case "V":
                    guard let y = tokens.number() else { break }
                    current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                    p.addLine(to: current)
                    lastControl = nil
                case "C":
                    guard let c1 = point(&tokens, relative: relative), let c2 = point(&tokens, relative: relative), let end = point(&tokens, relative: relative) else { break }
                    p.addCurve(to: end, control1: c1, control2: c2)
                    current = end
                    lastControl = c2
                case "S":
                    let c1 = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                    guard let c2 = point(&tokens, relative: relative), let end = point(&tokens, relative: relative) else { break }
                    p.addCurve(to: end, control1: c1, control2: c2)
                    current = end
                    lastControl = c2
                case "Q":
                    guard let c = point(&tokens, relative: relative), let end = point(&tokens, relative: relative) else { break }
                    p.addQuadCurve(to: end, control: c)
                    current = end
                    lastControl = c
                case "A":
                    guard let rx = tokens.number(), let ry = tokens.number(), let rot = tokens.number(),
                          let large = tokens.flag(), let sweep = tokens.flag(), let end = point(&tokens, relative: relative) else { break }
                    addArc(&p, from: current, to: end, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                    current = end
                    lastControl = nil
                case "Z":
                    p.closeSubpath()
                    current = start
                    lastControl = nil
                default:
                    break
                }
                first = false
                lastCommand = cmd
                // Malformed data that makes no progress ends the command instead of looping
                if tokens.position == before { break }
            } while upper != "Z" && tokens.nextIsNumber()
        }
        _ = lastCommand
        return p
    }

    /// SVG's elliptical arc (endpoint form) as cubic curves (SVG 1.1 implementation notes, F.6.5).
    private static func addArc(_ p: inout Path, from a: CGPoint, to b: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        guard a != b else { return }
        var rx = abs(rxIn), ry = abs(ryIn)
        guard rx > 0, ry > 0 else {
            p.addLine(to: b)
            return
        }
        let phi = rotation * .pi / 180
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (a.x - b.x) / 2, dy = (a.y - b.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy
        // Radii too small: scale them up
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            let s = lambda.squareRoot()
            rx *= s
            ry *= s
        }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = den == 0 ? 0 : (max(0, num / den)).squareRoot()
        if large == sweep { coef = -coef }
        let cxp = coef * (rx * y1 / ry)
        let cyp = coef * (-(ry * x1 / rx))
        let cx = cosPhi * cxp - sinPhi * cyp + (a.x + b.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (a.y + b.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = (ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot()
            var ang = acos(max(-1, min(1, dot / len)))
            if ux * vy - uy * vx < 0 { ang = -ang }
            return ang
        }
        let theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
        var delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        // Split into segments of at most a quarter turn
        let segments = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
        let step = delta / CGFloat(segments)
        let t = 4.0 / 3.0 * tan(step / 4)
        var th = theta1
        for _ in 0..<segments {
            let c1 = cos(th), s1 = sin(th)
            let c2 = cos(th + step), s2 = sin(th + step)
            func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: cosPhi * rx * x - sinPhi * ry * y + cx, y: sinPhi * rx * x + cosPhi * ry * y + cy)
            }
            let p1 = map(c1 - t * s1, s1 + t * c1)
            let p2 = map(c2 + t * s2, s2 - t * c2)
            let end = map(c2, s2)
            p.addCurve(to: end, control1: p1, control2: p2)
            th += step
        }
    }

    /// Splits a path string into commands, numbers and (for arcs) single-digit flags that may be glued to what follows.
    struct Tokenizer {
        private let chars: [Character]
        private var i = 0

        init(_ s: String) { chars = Array(s) }

        var position: Int { i }

        private mutating func skipSeparators() {
            while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\t" { i += 1 }
        }

        mutating func command() -> Character? {
            skipSeparators()
            guard i < chars.count, chars[i].isLetter else { return nil }
            defer { i += 1 }
            return chars[i]
        }

        mutating func nextIsNumber() -> Bool {
            skipSeparators()
            guard i < chars.count else { return false }
            let c = chars[i]
            return c.isNumber || c == "-" || c == "+" || c == "."
        }

        mutating func number() -> CGFloat? {
            skipSeparators()
            guard i < chars.count else { return nil }
            var s = ""
            var sawDot = false
            var sawExp = false
            if chars[i] == "-" || chars[i] == "+" {
                s.append(chars[i])
                i += 1
            }
            while i < chars.count {
                let c = chars[i]
                if c.isNumber {
                    s.append(c)
                } else if c == ".", !sawDot, !sawExp {
                    sawDot = true
                    s.append(c)
                } else if (c == "e" || c == "E"), !sawExp, i + 1 < chars.count, chars[i + 1].isNumber || chars[i + 1] == "-" || chars[i + 1] == "+" {
                    sawExp = true
                    s.append(c)
                    i += 1
                    if i < chars.count, chars[i] == "-" || chars[i] == "+" { s.append(chars[i]); i += 1 }
                    continue
                } else {
                    break
                }
                i += 1
            }
            return Double(s).map { CGFloat($0) }
        }

        /// An arc flag: one character, 0 or 1.
        mutating func flag() -> Bool? {
            skipSeparators()
            guard i < chars.count, chars[i] == "0" || chars[i] == "1" else { return nil }
            defer { i += 1 }
            return chars[i] == "1"
        }
    }
}
