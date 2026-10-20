import RooflineCore
import SwiftUI

/// One window the scan found, as the review lists it.
struct ScanReviewRow: Identifiable, Equatable {
    var id: UUID
    var letter: String
    var name: String
    var room: String
    var included: Bool
    var widthM: Double
    var heightM: Double
    var confidence: RoomPlanConfidence
    /// The style the shape suggests ("double-hung").
    var styleKey: String?

    var widthIn: Double { widthM * inchesPerMetre }
    var heightIn: Double { heightM * inchesPerMetre }
}

/// 07b Room scan result (ios-hw-07b): the room drawn from a corner or from above with each window lettered, the list of what
/// was found with its size ("about ±1 in"), and one red button to add them to the room. A window can be left out (tap it) or
/// moved to another room (touch and hold).
struct RoomScanReview: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let room: String
    let seconds: Int
    let plan: ScanPlan
    @State var rows: [ScanReviewRow]
    let onAdd: ([ScanReviewRow]) -> Void
    let onCorners: () -> Void
    let onCancel: () -> Void
    @State private var mode = Mode.threeD

    enum Mode: String, CaseIterable { case threeD = "3D", plan = "Plan" }

    private var included: [ScanReviewRow] { rows.filter { $0.included } }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel", action: onCancel).wc(17, relativeTo: .body).foregroundStyle(Theme.blue).frame(minWidth: Theme.minTap, minHeight: Theme.minTap, alignment: .leading)
                Spacer()
                Text(room).wc(17, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                    .lineLimit(1).minimumScaleFactor(0.7)
                Spacer()
                Color.clear.frame(width: 60, height: 1)
            }
            .padding(.horizontal, Theme.gutter)
            // the title row stops growing at the first accessibility size, like the system's bars
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    diagramCard
                    AdaptiveStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(rows.isEmpty ? "We didn't find a window" : "We found \(rows.count) window\(rows.count == 1 ? "" : "s")")
                            .wc(19, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let u = rows.map({ RoomPlanLimits.uncertaintyIn($0.confidence) }).max() {
                            Text(SizeWording.plusMinusEach(u)).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3)
                        }
                    }
                    .padding(.top, 18).padding(.horizontal, 6)
                    if !rows.isEmpty {
                        GroupCard {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                                foundRow(row, index: i)
                                if i < rows.count - 1 { RowDivider(inset: 56) }
                            }
                        }
                        .padding(.top, 10)
                    }
                    if rows.count > 0 {
                        SmallNote(text: "Tap a window to leave it out. Touch and hold to move it to another room.").padding(.top, 8).padding(.horizontal, 6)
                    }
                    InfoPanel(icon: .alert, text: "Good enough for your quote. Want it closer? Tap the 4 corners of each window (about 1/4 inch). Your rep checks every size anyway.", tint: Theme.infoTint, iconColor: Theme.info).padding(.top, 14)
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 8)
                .padding(.bottom, 20)
            }
        }
        .background(Theme.ground.ignoresSafeArea())
        .wcFooter {
            WCPrimaryButton(title: included.isEmpty ? "Add windows to \(room)" : "Add \(included.count) window\(included.count == 1 ? "" : "s") to \(room)", icon: .check, iconLeading: true, isEnabled: !included.isEmpty) { onAdd(included) }
            WCSecondaryButton(title: "Tap corners for each one", action: onCorners)
        }
    }

    // MARK: Picture

    private var diagramCard: some View {
        ZStack(alignment: .top) {
            RoomDiagram(plan: plan, mode: mode, letters: Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.letter) }), included: Set(included.map { $0.id }))
                .padding(.top, 36).padding(.bottom, 8)
            HStack(alignment: .top) {
                HStack(spacing: 6) {
                    IconView(icon: .cube, size: 16, weight: 1.9)
                    Text("Scanned in \(seconds) seconds").wc(14, .semibold, relativeTo: .footnote).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(Theme.blue)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.blueTint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                Spacer()
                Picker("View", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 104)
            }
            .padding(12)
            // the picture is a drawing of a fixed size: its labels stop at the largest ordinary size
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        .frame(height: 205)
        .frame(maxWidth: .infinity)
        .wcCard(radius: 20)
    }

    // MARK: Rows

    private func foundRow(_ row: ScanReviewRow, index: Int) -> some View {
        Button {
            rows[index].included.toggle()
            Haptics.tap()
        } label: {
            HStack(alignment: typeSize.isAccessibilitySize ? .top : .center, spacing: 12) {
                Text(row.letter).wcMono(16, .bold, relativeTo: .body).foregroundStyle(row.included ? Theme.blue : Theme.ink3)
                    .frame(width: 30, height: 30).background(row.included ? Theme.blueTint : Theme.surface2, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(.top, typeSize.isAccessibilitySize ? 4 : 0)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.name).wc(17, .semibold, relativeTo: .body).foregroundStyle(row.included ? Theme.ink : Theme.ink3).strikethrough(!row.included)
                    Text(row.included ? looksLike(row) : "Left out. Tap to add it.").wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3).lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    // with large text the size goes under the name instead of beside it
                    if typeSize.isAccessibilitySize { sizeBlock(row, alignment: .leading) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !typeSize.isAccessibilitySize { sizeBlock(row, alignment: .trailing) }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            ForEach(store.rooms, id: \.self) { r in
                Button { rows[index].room = r } label: { Label(r, systemImage: rows[index].room == r ? "checkmark" : "door.left.hand.open") }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Window \(row.letter), \(row.name). \(SizeWording.spokenSize(widthIn: row.widthIn.rounded(), heightIn: row.heightIn.rounded())), \(SizeWording.spokenAccuracy(RoomPlanLimits.uncertaintyIn(row.confidence))). \(row.included ? "Will be added" : "Left out")")
        .accessibilityHint("Double tap to \(row.included ? "leave it out" : "add it")")
        .accessibilityAddTraits(.isButton)
    }

    private func sizeBlock(_ row: ScanReviewRow, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 1) {
            SizeText(widthIn: row.widthIn.rounded(), heightIn: row.heightIn.rounded(), size: 20, weight: .bold, color: row.included ? Theme.ink : Theme.ink3, relativeTo: .title3)
            Text(SizeWording.plusMinus(RoomPlanLimits.uncertaintyIn(row.confidence))).wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3)
        }
    }

    private func looksLike(_ row: ScanReviewRow) -> String {
        let moved = row.room.caseInsensitiveCompare(room) == .orderedSame ? "" : " · goes in \(row.room)"
        guard let key = row.styleKey else { return "Window" + moved }
        return "Looks like \(Self.description(key))" + moved
    }

    /// "double-hung", "a slider", "an awning": the way the scan row says it.
    static func description(_ key: String) -> String {
        switch key {
        case "double-hung", "single-hung": return key
        case "slider-2", "slider-3": return "a slider"
        case "picture": return "a picture window"
        case "casement": return "a casement"
        case "awning": return "an awning"
        case "arch": return "an arch window"
        case "circle": return "a round window"
        default: return key.replacingOccurrences(of: "-", with: " ")
        }
    }
}

// MARK: - The room, drawn

/// The scanned room from a corner (3D) or from above (Plan), with each window marked by its letter.
struct RoomDiagram: View {
    let mode: RoomScanReview.Mode
    let letters: [UUID: String]
    let included: Set<UUID>
    private let plan: ScanPlan

    init(plan: ScanPlan, mode: RoomScanReview.Mode, letters: [UUID: String], included: Set<UUID>) {
        self.plan = plan.forDrawing()
        self.mode = mode
        self.letters = letters
        self.included = included
    }

    var body: some View {
        Canvas { ctx, size in
            switch mode {
            case .plan: drawPlan(&ctx, size)
            case .threeD: drawIso(&ctx, size)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(summary)
    }

    /// What the drawing shows, in words: the room's size and which windows are marked.
    private var summary: String {
        let b = bounds
        let size = "\(FeetInches.text(metres: b.maxY - b.minY)) by \(FeetInches.text(metres: b.maxX - b.minX))"
        let marked = letters.sorted { $0.value < $1.value }.map { "\($0.value)\(included.contains($0.key) ? "" : " (left out)")" }
        let windows = marked.isEmpty ? "No windows marked." : "Windows marked: \(marked.joined(separator: ", "))."
        return "Drawing of the room you scanned, \(size). \(windows)"
    }

    private var bounds: (minX: Double, maxX: Double, minY: Double, maxY: Double) {
        let xs = plan.walls.flatMap { [$0.ax, $0.bx] }, ys = plan.walls.flatMap { [$0.ay, $0.by] }
        return (xs.min() ?? 0, xs.max() ?? 1, ys.min() ?? 0, ys.max() ?? 1)
    }

    private func badge(_ ctx: inout GraphicsContext, _ letter: String, at p: CGPoint, on: Bool) {
        let r = CGRect(x: p.x - 13, y: p.y - 11, width: 26, height: 22)
        ctx.fill(Path(roundedRect: r, cornerRadius: 6), with: .color(on ? Theme.blue : Theme.ink3))
        ctx.draw(Text(letter).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundColor(.white), at: p)
    }

    // MARK: Plan

    private func drawPlan(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let b = bounds
        let w = b.maxX - b.minX, h = b.maxY - b.minY
        guard w > 0, h > 0 else { return }
        let pad: CGFloat = 46
        let k = min((size.width - pad * 2) / w, (size.height - pad * 2) / h)
        let ox = (size.width - w * k) / 2, oy = (size.height - h * k) / 2
        func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: ox + (x - b.minX) * k, y: oy + (y - b.minY) * k) }
        // Floor
        var floor = Path()
        for (i, s) in plan.walls.enumerated() {
            if i == 0 { floor.move(to: pt(s.ax, s.ay)) }
            floor.addLine(to: pt(s.bx, s.by))
        }
        floor.closeSubpath()
        ctx.fill(floor, with: .color(Theme.surface2))
        // Walls
        for s in plan.walls {
            var p = Path()
            p.move(to: pt(s.ax, s.ay)); p.addLine(to: pt(s.bx, s.by))
            ctx.stroke(p, with: .color(Theme.ink), style: StrokeStyle(lineWidth: 4, lineCap: .square))
        }
        // Openings
        for o in plan.openings {
            var p = Path()
            p.move(to: pt(o.segment.ax, o.segment.ay)); p.addLine(to: pt(o.segment.bx, o.segment.by))
            let on = o.isDoor || included.contains(o.id)
            ctx.stroke(p, with: .color(o.isDoor ? Theme.surface : (on ? Theme.blue : Theme.ink3)), style: StrokeStyle(lineWidth: o.isDoor ? 6 : 6, lineCap: .butt))
            if !o.isDoor, let letter = letters[o.id] {
                let m = o.segment.mid
                // The badge sits on the inside of the room
                let c = (x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2)
                let dx = c.x - m.x, dy = c.y - m.y
                let len = max((dx * dx + dy * dy).squareRoot(), 0.001)
                let inward = CGPoint(x: dx / len * 22, y: dy / len * 22)
                let base = pt(m.x, m.y)
                badge(&ctx, letter, at: CGPoint(x: base.x + inward.x, y: base.y + inward.y), on: on)
            }
        }
        // The two sides, labelled
        let e = plan.extent
        ctx.draw(Text("\(FeetInches.text(metres: e.y)) × \(FeetInches.text(metres: e.x))").font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.ink3), at: CGPoint(x: size.width / 2, y: size.height - 16))
    }

    // MARK: 3D (isometric)

    private func drawIso(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let b = bounds
        let c30 = cos(Double.pi / 6), s30 = sin(Double.pi / 6)
        // Plan (x, y) and height z -> screen, before fitting
        func raw(_ x: Double, _ y: Double, _ z: Double) -> CGPoint {
            CGPoint(x: (x - y) * c30, y: (x + y) * s30 - z)
        }
        var pts: [CGPoint] = []
        for s in plan.walls {
            for (x, y) in [(s.ax, s.ay), (s.bx, s.by)] {
                pts.append(raw(x, y, 0))
                pts.append(raw(x, y, plan.wallHeight))
            }
        }
        guard let minX = pts.map({ $0.x }).min(), let maxX = pts.map({ $0.x }).max(), let minY = pts.map({ $0.y }).min(), let maxY = pts.map({ $0.y }).max(), maxX > minX, maxY > minY else { return }
        let pad: CGFloat = 40
        let k = min((size.width - pad * 2) / (maxX - minX), (size.height - pad * 1.6) / (maxY - minY))
        let ox = (size.width - (maxX - minX) * k) / 2 - minX * k, oy = (size.height - (maxY - minY) * k) / 2 - minY * k + 6
        func pt(_ x: Double, _ y: Double, _ z: Double) -> CGPoint {
            let r = raw(x, y, z)
            return CGPoint(x: ox + r.x * k, y: oy + r.y * k)
        }
        // Floor
        var floor = Path()
        for (i, s) in plan.walls.enumerated() {
            if i == 0 { floor.move(to: pt(s.ax, s.ay, 0)) }
            floor.addLine(to: pt(s.bx, s.by, 0))
        }
        floor.closeSubpath()
        ctx.fill(floor, with: .color(Theme.surface2))
        ctx.stroke(floor, with: .color(Theme.ink.opacity(0.85)), lineWidth: 1.6)
        // Walls that face into the picture (their inside seen from the corner), back to front
        let centre = (x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2)
        let walls = plan.walls.enumerated().filter { _, s in
            // The wall's inward normal points toward the viewer when its midpoint is nearer the back corner (smaller x + y)
            let m = s.mid
            return (m.x + m.y) < (centre.x + centre.y) - 0.01
        }.sorted { ($0.element.mid.x + $0.element.mid.y) < ($1.element.mid.x + $1.element.mid.y) }
        for (_, s) in walls {
            var quad = Path()
            quad.move(to: pt(s.ax, s.ay, 0)); quad.addLine(to: pt(s.bx, s.by, 0))
            quad.addLine(to: pt(s.bx, s.by, plan.wallHeight)); quad.addLine(to: pt(s.ax, s.ay, plan.wallHeight)); quad.closeSubpath()
            ctx.fill(quad, with: .color(Theme.sunken))
            ctx.stroke(quad, with: .color(Theme.ink.opacity(0.85)), lineWidth: 1.6)
            for o in plan.openings where !o.isDoor || true {
                guard onWall(o, s) else { continue }
                var q = Path()
                q.move(to: pt(o.segment.ax, o.segment.ay, o.sill)); q.addLine(to: pt(o.segment.bx, o.segment.by, o.sill))
                q.addLine(to: pt(o.segment.bx, o.segment.by, o.head)); q.addLine(to: pt(o.segment.ax, o.segment.ay, o.head)); q.closeSubpath()
                let on = o.isDoor || included.contains(o.id)
                ctx.fill(q, with: .color(o.isDoor ? Theme.surface : Theme.blueTint))
                ctx.stroke(q, with: .color(o.isDoor ? Theme.ink3 : (on ? Theme.blue : Theme.ink3)), lineWidth: o.isDoor ? 1.5 : 2.2)
                if !o.isDoor, let letter = letters[o.id] {
                    let m = o.segment.mid
                    badge(&ctx, letter, at: CGPoint(x: pt(m.x, m.y, o.sill).x, y: pt(m.x, m.y, o.sill).y + 16), on: on)
                }
            }
        }
        let e = plan.extent
        // The left wall runs along y, the right one along x
        ctx.draw(Text(FeetInches.text(metres: e.y)).font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.ink3), at: CGPoint(x: size.width * 0.28, y: size.height - 26))
        ctx.draw(Text(FeetInches.text(metres: e.x)).font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.ink3), at: CGPoint(x: size.width * 0.74, y: size.height - 26))
        // A window on a wall the picture does not draw: its letter on the floor line
        for o in plan.openings where !o.isDoor && !plan.onBackWall(o) {
            guard let letter = letters[o.id] else { continue }
            let m = o.segment.mid
            let p = pt(m.x, m.y, 0)
            badge(&ctx, letter, at: CGPoint(x: p.x, y: p.y + 4), on: included.contains(o.id))
        }
    }

    /// The opening lies on this wall (both its ends within a hair of the wall's line).
    private func onWall(_ o: ScanPlan.Opening, _ w: ScanPlan.Segment) -> Bool {
        func dist(_ x: Double, _ y: Double) -> Double {
            let dx = w.bx - w.ax, dy = w.by - w.ay
            let len = max((dx * dx + dy * dy).squareRoot(), 0.001)
            return abs((x - w.ax) * dy - (y - w.ay) * dx) / len
        }
        return dist(o.segment.ax, o.segment.ay) < 0.25 && dist(o.segment.bx, o.segment.by) < 0.25
    }
}
