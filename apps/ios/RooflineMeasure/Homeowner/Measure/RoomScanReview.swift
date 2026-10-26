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
    /// The scan's photo of this window with its outline; nil when no kept photo saw all four corners.
    var photo: ScanPhoto?

    var widthIn: Double { widthM * inchesPerMetre }
    var heightIn: Double { heightM * inchesPerMetre }

    /// "35 3/8 × 47 1/4 in": inches to the eighth, like every other size in the app.
    var sizeText: String { SizeWording.sizeText(widthIn: widthIn, heightIn: heightIn) }

    /// The window as the store saves it. The size, the confidence and the corners are the scan's own, unchanged: what the person
    /// saw in the review is what goes to the outbox. A name only when there are several ("Kitchen, window B").
    func scannedWindow(multiple: Bool, photo shot: (jpeg: Data, widthPx: Int, heightPx: Int, corners: [Vec2])?) -> ScannedWindow {
        ScannedWindow(name: multiple ? "\(room), window \(letter)" : "", widthM: widthM, heightM: heightM, confidence: confidence,
                      jpeg: shot?.jpeg, imageWidthPx: shot?.widthPx ?? 0, imageHeightPx: shot?.heightPx ?? 0, corners: shot?.corners, room: room)
    }
}

/// What the review edits: which windows are kept, and which room they go in. Plain values, so the rules are tested without a screen.
struct ScanReviewModel: Equatable {
    var roomName: String
    var rows: [ScanReviewRow]

    var included: [ScanReviewRow] { rows.filter { $0.included } }

    /// Leave a window out, or take it back in.
    mutating func toggle(_ id: UUID) {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[i].included.toggle()
    }

    /// One window goes in another room (touch and hold).
    mutating func move(_ id: UUID, to room: String) {
        guard let name = RoomNames.clean(room), let i = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[i].room = name
    }

    /// The scan goes in another room (a name picked or typed). Windows that were still in the old room follow it; one that was
    /// moved elsewhere stays where it was put. A blank name changes nothing.
    @discardableResult
    mutating func rename(to typed: String) -> Bool {
        guard let name = RoomNames.clean(typed) else { return false }
        let old = roomName
        for i in rows.indices where rows[i].room.caseInsensitiveCompare(old) == .orderedSame { rows[i].room = name }
        roomName = name
        return true
    }

    /// "We found 2 windows".
    var title: String { ScanWording.foundTitle(rows.count) }

    var addTitle: String {
        included.isEmpty ? "Add windows to \(roomName)" : "Add \(included.count) window\(included.count == 1 ? "" : "s") to \(roomName)"
    }
}

/// 07b Room scan result (ios-hw-07b): each window the scan found with its photo and outline, its size to the eighth and how sure Apple is,
/// and one red button to add them to the room. A window can be left out (tap it) or moved to another room (touch and hold), and the
/// room can be named. The whole-room scan also draws the room from a corner or from above, each window lettered.
struct RoomScanReview: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let mode: RoomScanMode
    let seconds: Int
    let plan: ScanPlan
    @State private var model: ScanReviewModel
    let onAdd: ([ScanReviewRow]) -> Void
    let onCorners: () -> Void
    let onCancel: () -> Void
    @State private var diagramMode = Mode.threeD
    @State private var askRoom = false
    @State private var typedRoom = ""

    enum Mode: String, CaseIterable { case threeD = "3D", plan = "Plan" }

    init(mode: RoomScanMode = .wholeRoom, room: String, seconds: Int, plan: ScanPlan, rows: [ScanReviewRow],
         onAdd: @escaping ([ScanReviewRow]) -> Void, onCorners: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.mode = mode
        self.seconds = seconds
        self.plan = plan
        _model = State(initialValue: ScanReviewModel(roomName: room, rows: rows))
        self.onAdd = onAdd
        self.onCorners = onCorners
        self.onCancel = onCancel
    }

    private var rows: [ScanReviewRow] { model.rows }

    /// The rooms to pick from: the one this scan is in, then the others.
    private var roomChoices: [String] {
        var seen = Set<String>(), out: [String] = []
        for r in [model.roomName] + store.rooms where seen.insert(r.lowercased()).inserted { out.append(r) }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                if mode == .wholeRoom { Section { diagramCard } }
                Section {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                        foundRow(row, index: i)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                        Text(ScanWording.confirmLine).font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                    .textCase(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 4)
                } footer: {
                    Text("Tap a window to leave it out. Touch and hold to move it to another room.").foregroundStyle(Theme.ink2)
                }
                Section { roomRow }
                Section {
                    Label {
                        Text("Good for your estimate. Want it closer now? Tap the 4 corners of each window.")
                            .font(.subheadline).foregroundStyle(Theme.ink2)
                    } icon: {
                        Image(systemName: WCIcon.info.symbol).foregroundStyle(Theme.ink2)
                    }
                    .accessibilityElement(children: .combine)
                }
                if typeSize.isAccessibilitySize {
                    Section { WCScrollFooter() }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.insetGrouped)
            .wcFooter {
                WCPrimaryButton(title: model.addTitle, icon: .check, iconLeading: true, isEnabled: !model.included.isEmpty) { onAdd(model.included) }
                WCSecondaryButton(title: "Tap corners for each one", action: onCorners)
            }
            .navigationTitle(model.roomName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", action: onCancel)
                }
            }
            .alert("Name this room", isPresented: $askRoom) {
                TextField("Room name", text: $typedRoom)
                Button("Save") { model.rename(to: typedRoom) }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    // MARK: Room

    /// "Room · Bedroom 1": pick another of the home's rooms or type a new name.
    private var roomRow: some View {
        Menu {
            ForEach(roomChoices, id: \.self) { r in
                Button { model.rename(to: r) } label: { Label(r, systemImage: model.roomName.caseInsensitiveCompare(r) == .orderedSame ? "checkmark" : "door.left.hand.open") }
            }
            Divider()
            Button { typedRoom = ""; askRoom = true } label: { Label("Another name…", systemImage: "pencil") }
        } label: {
            HStack(spacing: 10) {
                Text("Room").font(.body).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text(model.roomName).font(.body).foregroundStyle(Theme.ink2).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.footnote.weight(.semibold)).foregroundStyle(Theme.red)
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Room, \(model.roomName)")
        .accessibilityHint("Double tap to pick or name the room")
    }

    // MARK: Picture

    private var diagramCard: some View {
        VStack(spacing: 8) {
            HStack(alignment: .center) {
                Label("Scanned in \(seconds) seconds", systemImage: WCIcon.cube.symbol)
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink2)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Picker("View", selection: $diagramMode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 104)
            }
            // the picture is a drawing of a fixed size: its labels stop at the largest ordinary size
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            RoomDiagram(plan: plan, mode: diagramMode, letters: Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.letter) }), included: Set(model.included.map { $0.id }))
                .frame(height: 190)
        }
        .padding(.vertical, 4)
    }

    // MARK: Rows

    private func foundRow(_ row: ScanReviewRow, index: Int) -> some View {
        Button {
            model.toggle(row.id)
            Haptics.tap()
        } label: {
            HStack(alignment: typeSize.isAccessibilitySize ? .top : .center, spacing: 12) {
                ScanThumb(photo: row.photo, on: row.included)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(row.letter).font(.footnote.weight(.bold)).monospacedDigit().foregroundStyle(row.included ? Theme.ink : Theme.ink2)
                            .frame(width: 26, height: 26).background(Theme.surface2, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        Text(row.name).font(.headline).foregroundStyle(row.included ? Theme.ink : Theme.ink2).strikethrough(!row.included)
                    }
                    SizeText(widthIn: row.widthIn, heightIn: row.heightIn, size: 20, weight: .bold, unit: true, color: row.included ? Theme.ink : Theme.ink2, relativeTo: .title3)
                    if row.included {
                        Text(looksLike(row)).font(.subheadline).foregroundStyle(Theme.ink2).lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                        Text(ScanWording.sourceLine(row.confidence)).font(.subheadline)
                            .foregroundStyle(Theme.ink2)
                    } else {
                        Text("Left out. Tap to add it.").font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                tick(row.included)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            ForEach(roomChoices, id: \.self) { r in
                Button { model.move(row.id, to: r) } label: { Label(r, systemImage: row.room.caseInsensitiveCompare(r) == .orderedSame ? "checkmark" : "door.left.hand.open") }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Window \(row.letter), \(row.name). \(SizeWording.spokenSize(widthIn: row.widthIn, heightIn: row.heightIn)). \(ScanWording.sourceLine(row.confidence)). \(row.included ? "Will be added" : "Left out")")
        .accessibilityHint("Double tap to \(row.included ? "leave it out" : "add it")")
        .accessibilityAddTraits(.isButton)
    }

    /// The round tick at the end of a row: the accent checkmark when the window will be added, an empty circle when it is left out.
    private func tick(_ on: Bool) -> some View {
        Image(systemName: on ? "checkmark.circle.fill" : "circle")
            .font(.title2)
            .foregroundStyle(on ? Theme.red : Theme.decor)
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)
    }

    private func looksLike(_ row: ScanReviewRow) -> String {
        let moved = row.room.caseInsensitiveCompare(model.roomName) == .orderedSame ? "" : " · goes in \(row.room)"
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

// MARK: - The scan's photo of a window

/// The photo that saw the window best, small, with the window's outline drawn on it; a plain tile when no kept photo saw all four corners.
struct ScanThumb: View {
    let photo: ScanPhoto?
    let on: Bool
    static let width: CGFloat = 76

    var body: some View {
        Group {
            if let photo = photo {
                Image(uiImage: photo.image)
                    .resizable()
                    .aspectRatio(photo.image.size, contentMode: .fit)
                    .frame(width: Self.width)
                    .overlay { ScanOutline(points: photo.outline).opacity(on ? 1 : 0.4) }
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .opacity(on ? 1 : 0.5)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.surface2)
                    Image(systemName: WCIcon.win.symbol).font(.title).foregroundStyle(Theme.ink2)
                }
                .frame(width: Self.width, height: Self.width * 4 / 3)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The window's four corners (shares of the picture) as an outline, light with a dark edge so it shows on any wall.
struct ScanOutline: View {
    let points: [CGPoint]

    var body: some View {
        GeometryReader { geo in
            let path = Path { p in
                guard points.count == 4 else { return }
                p.move(to: CGPoint(x: points[0].x * geo.size.width, y: points[0].y * geo.size.height))
                for q in points.dropFirst() { p.addLine(to: CGPoint(x: q.x * geo.size.width, y: q.y * geo.size.height)) }
                p.closeSubpath()
            }
            path.stroke(Color.black.opacity(0.55), style: StrokeStyle(lineWidth: 4, lineJoin: .round))
            path.stroke(Theme.tape, style: StrokeStyle(lineWidth: 2.2, lineJoin: .round))
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
        ctx.fill(Path(roundedRect: r, cornerRadius: 6), with: .color(on ? Theme.red : Theme.ink2))
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
            ctx.stroke(p, with: .color(o.isDoor ? Theme.surface : (on ? Theme.red : Theme.ink2)), style: StrokeStyle(lineWidth: o.isDoor ? 6 : 6, lineCap: .butt))
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
        ctx.draw(Text("\(FeetInches.text(metres: e.y)) × \(FeetInches.text(metres: e.x))").font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.ink2), at: CGPoint(x: size.width / 2, y: size.height - 16))
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
                ctx.fill(q, with: .color(o.isDoor ? Theme.surface : Theme.redTint))
                ctx.stroke(q, with: .color(o.isDoor ? Theme.ink2 : (on ? Theme.red : Theme.ink2)), lineWidth: o.isDoor ? 1.5 : 2.2)
                if !o.isDoor, let letter = letters[o.id] {
                    let m = o.segment.mid
                    badge(&ctx, letter, at: CGPoint(x: pt(m.x, m.y, o.sill).x, y: pt(m.x, m.y, o.sill).y + 16), on: on)
                }
            }
        }
        let e = plan.extent
        // The left wall runs along y, the right one along x
        ctx.draw(Text(FeetInches.text(metres: e.y)).font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.ink2), at: CGPoint(x: size.width * 0.28, y: size.height - 26))
        ctx.draw(Text(FeetInches.text(metres: e.x)).font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.ink2), at: CGPoint(x: size.width * 0.74, y: size.height - 26))
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
