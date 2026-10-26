import RooflineCore
import SwiftUI
import UIKit

/// "See it in your home": the homeowner's own photo of one window with a new window drawn in its place, a before/after compare, and
/// the choices that change it (kind, grid, frame colour, glass). "Use this window" sets the window's style (and colour) through the
/// existing flow; grid and glass stay on the phone with the window.
struct VisualizeScreen: View {
    let windowId: String
    let origin: VisualizeOrigin

    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var model = VisualizeModel()
    @State private var compare = 0.0
    @State private var working = false
    @State private var showAll = false

    private var row: WindowRow? { store.windowRows.first { $0.id == windowId } }
    private var windowCount: Int { store.windowRows.count }

    var body: some View {
        GeometryReader { geo in
        VStack(spacing: 0) {
            picture
                .frame(width: geo.size.width, height: pictureHeight(geo))
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    typeSection
                    gridSection
                    colorSection
                    glassSection
                    Text("Colors, grids and glass are just to show your look.")
                        .font(.footnote).foregroundStyle(Theme.ink2)
                        .padding(.horizontal, Theme.gutter)
                    if typeSize.isAccessibilitySize { WCScrollFooter() }
                }
                .padding(.vertical, 16)
            }
            .background(Theme.ground)
        }
        .task {
            await model.start(store: store, windowId: windowId, aspect: geo.size.width / pictureHeight(geo))
            #if DEBUG
            if let d = store.debugVisualLook { compare = d.compare }
            #endif
        }
        }
        .background(Theme.ground)
        .hiNav(title: row?.title ?? "Your window") {
            if let after = model.after {
                ShareLink(item: shareItem, preview: SharePreview("My new window", image: Image(uiImage: after))) {
                    Image(systemName: WCIcon.upload.symbol)
                }
                .accessibilityLabel("Share this picture")
            }
        }
        .wcFooter {
            WCPrimaryButton(title: "Use this window", isLoading: working) { Task { await use(all: false) } }
            if windowCount > 1 {
                WCSecondaryButton(title: "Use for all \(windowCount) windows", isEnabled: !working) { Task { await use(all: true) } }
            }
        }
        .sheet(isPresented: $showAll) {
            TypeGallerySheet(selected: model.look.type, quote: { store.styleMapping(for: $0).quoteLine }) { type in
                model.set(type: type)
                showAll = false
            }
        }
    }

    // MARK: The picture

    /// The picture area: as wide as the screen and about half its height (the choices and the buttons need the rest).
    private func pictureHeight(_ geo: GeometryProxy) -> CGFloat {
        min(geo.size.width, max(geo.size.height * 0.52, 200))
    }

    private var picture: some View {
        ZStack {
            Color(.secondarySystemBackground)
            if let before = model.before, let after = model.after {
                BeforeAfterView(before: before, after: after, position: $compare)
            } else if let before = model.before {
                Image(uiImage: before).resizable().scaledToFill()
            }
            if model.phase == .loading || (model.after == nil && model.before != nil) {
                ProgressView().controlSize(.large).padding(18).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            if model.drawnWall {
                VStack {
                    Spacer()
                    Label("A drawn wall. This window's photo isn't on this phone.", systemImage: "info.circle")
                        .font(.footnote).foregroundStyle(Theme.ink)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Theme.surface, in: Capsule())
                        .padding(.bottom, 10)
                }
            }
        }
        .clipped()
    }

    // MARK: Choices

    private var typeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Window type").font(.headline).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Button {
                    showAll = true
                } label: {
                    Text("See all \(VisualWindowType.gallery.count)")
                        .font(.subheadline.weight(.medium)).foregroundStyle(Theme.red)
                        .frame(minWidth: Theme.minTap, minHeight: Theme.minTap, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .accessibilityHint("Opens every kind of window in one list")
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, -10)
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 10) {
                        ForEach(VisualWindowType.gallery) { type in
                            TypeCard(type: type, selected: model.look.type == type) {
                                Haptics.tap()
                                model.set(type: type)
                            }
                            .id(type)
                        }
                    }
                    .padding(.horizontal, Theme.gutter)
                }
                .onAppear { proxy.scrollTo(model.look.type, anchor: .center) }
                .onChange(of: model.phase) { _, _ in proxy.scrollTo(model.look.type, anchor: .center) }
            }
            let mapping = store.styleMapping(for: model.look.type)
            VStack(alignment: .leading, spacing: 6) {
                Text(model.look.type.summary).font(.subheadline).foregroundStyle(Theme.ink)
                Label(mapping.quoteLine, systemImage: mapping.atVisit ? "calendar.badge.clock" : "checkmark.circle")
                    .font(.footnote).foregroundStyle(Theme.ink2)
            }
            .padding(.horizontal, Theme.gutter)
            .accessibilityElement(children: .combine)
        }
    }

    private var gridSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("Grids", value: model.look.grid.title)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(VisualGrid.allCases) { grid in
                        let selected = model.look.grid == grid
                        Button {
                            Haptics.tap()
                            model.set(grid: grid)
                        } label: {
                            HStack(spacing: 8) {
                                GridGlyph(grid: grid, ink: selected ? Theme.onRed : Theme.ink).frame(width: 22, height: 28)
                                Text(grid.title).font(.subheadline.weight(.medium))
                            }
                            .foregroundStyle(selected ? Theme.onRed : Theme.ink)
                            .padding(.horizontal, 14)
                            .frame(minHeight: Theme.minTap)
                            .background(selected ? Theme.buttonFill : Theme.surface, in: Capsule())
                            .overlay(Capsule().strokeBorder(Theme.line, lineWidth: selected ? 0 : 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(grid.title). \(grid.summary)")
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
        }
    }

    private var colorSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("Frame color", value: model.colorLabel)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(store.brand.windowColors) { c in
                        let selected = model.colorKey == c.key
                        Button {
                            Haptics.tap()
                            model.set(colorKey: c.key)
                        } label: {
                            VStack(spacing: 6) {
                                Circle().fill(Color(hex: c.hex)).frame(width: 40, height: 40)
                                    .overlay(Circle().strokeBorder(Color.primary.opacity(0.18), lineWidth: 1))
                                    .overlay { if selected { Circle().strokeBorder(Theme.red, lineWidth: 2.5).padding(-5) } }
                                    .padding(5)
                                Text(c.label).font(.caption.weight(selected ? .semibold : .regular)).foregroundStyle(selected ? Theme.ink : Theme.ink2)
                            }
                            .frame(minWidth: 64, minHeight: Theme.minTap)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(c.label)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(.horizontal, Theme.gutter - 4)
            }
        }
    }

    private var glassSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("Glass", value: model.look.glass.title)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(VisualGlass.allCases) { glass in
                        let selected = model.look.glass == glass
                        Button {
                            Haptics.tap()
                            model.set(glass: glass)
                        } label: {
                            HStack(spacing: 8) {
                                GlassGlyph(glass: glass).frame(width: 22, height: 22)
                                Text(glass.title).font(.subheadline.weight(.medium))
                            }
                            .foregroundStyle(selected ? Theme.onRed : Theme.ink)
                            .padding(.horizontal, 14)
                            .frame(minHeight: Theme.minTap)
                            .background(selected ? Theme.buttonFill : Theme.surface, in: Capsule())
                            .overlay(Capsule().strokeBorder(Theme.line, lineWidth: selected ? 0 : 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(glass.title) glass. \(glass.summary)")
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
            Text(model.look.glass.summary).font(.footnote).foregroundStyle(Theme.ink2).padding(.horizontal, Theme.gutter)
            Toggle(isOn: Binding(get: { model.look.cleanGlass }, set: { model.set(cleanGlass: $0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Clean glass").font(.body)
                    Text("Hides your old bars and blinds with a soft sky.").font(.footnote).foregroundStyle(Theme.ink2)
                }
            }
            .tint(Theme.buttonFill)
            .padding(.horizontal, Theme.gutter)
            .frame(minHeight: Theme.minTap)
            .disabled(model.look.glass == .frosted)
        }
    }

    private func sectionHeader(_ title: String, value: String?) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.headline).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            if let v = value { Text(v).font(.subheadline).foregroundStyle(Theme.ink2) }
        }
        .padding(.horizontal, Theme.gutter)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: Using it

    private func use(all: Bool) async {
        working = true
        if all {
            await store.useVisualForAll(model.look, colorKey: model.colorKey)
        } else {
            await store.useVisual(model.look, colorKey: model.colorKey, for: windowId)
        }
        // A changed style changes the price
        if origin == .quote { await store.prepareQuote() }
        working = false
        Haptics.success()
        store.pop()
    }

    private var shareItem: VisualizerShareImage {
        let source = model.source, w = row?.widthIn, h = row?.heightIn, look = model.look, hex = model.colorHex
        return VisualizerShareImage { VisualizeModel.exportJPEG(source: source, widthIn: w, heightIn: h, look: look, colorHex: hex) }
    }
}

/// The picture to share: drawn when the share sheet asks, from the whole photo.
struct VisualizerShareImage: Transferable {
    let make: @Sendable () -> Data?

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .jpeg) { item in
            let data = await Task.detached(priority: .userInitiated) { item.make() }.value
            guard let data = data else { throw CocoaError(.fileWriteUnknown) }
            return data
        }
    }
}

// MARK: - Pieces

/// Every kind of window in one list, grouped, each with how it is quoted.
private struct TypeGallerySheet: View {
    @Environment(\.dismiss) private var dismiss
    let selected: VisualWindowType
    let quote: (VisualWindowType) -> String
    let choose: (VisualWindowType) -> Void

    private let groups: [(title: String, types: [VisualWindowType])] = [
        ("Hung and sliding", [.doubleHung, .singleHung, .slider2, .slider3]),
        ("Swing out and tilt", [.casement, .casementPair, .awning, .hopper]),
        ("Fixed", [.picture, .pictureCasements]),
        ("Reaching out from the wall", [.bay, .bow, .garden]),
        ("Shapes", [.arch, .halfRound, .circle, .specialty]),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    ForEach(groups, id: \.title) { group in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(group.title).font(.headline).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)], alignment: .leading, spacing: 14) {
                                ForEach(group.types) { type in
                                    TypeCard(type: type, selected: selected == type, note: quote(type), fill: true) { choose(type) }
                                }
                            }
                        }
                    }
                }
                .padding(Theme.gutter)
            }
            .background(Theme.ground)
            .navigationTitle("Window types")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.large])
    }
}

/// A window kind in the gallery: its drawing, its name, and the accent when it is the one shown.
private struct TypeCard: View {
    let type: VisualWindowType
    let selected: Bool
    var note: String?
    /// Fill the width it is given (the list of every kind) instead of the strip's fixed card.
    var fill = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                WindowThumbnail(type: type, ink: selected ? Theme.red : Theme.ink)
                    .frame(width: fill ? nil : 84, height: fill ? 96 : 72)
                    .frame(maxWidth: fill ? .infinity : nil)
                    .padding(8)
                    .background(selected ? Theme.redTint : Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(selected ? Theme.red : Theme.line, lineWidth: selected ? 2 : 1))
                    .overlay(alignment: .topTrailing) {
                        if selected {
                            Image(systemName: "checkmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(Theme.onRed, Theme.buttonFill)
                                .font(.title3).padding(6)
                        }
                    }
                Text(type.title)
                    .accessibilityHidden(true)
                    .font(.caption.weight(selected ? .semibold : .regular))
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: fill ? nil : 100)
                    .frame(maxWidth: fill ? .infinity : nil)
                if let note = note {
                    Text(note).font(.caption2).foregroundStyle(Theme.ink2).multilineTextAlignment(.center).lineLimit(2)
                        .frame(width: fill ? nil : 100)
                        .frame(maxWidth: fill ? .infinity : nil)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(type.title). \(type.summary)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A little window with the grid in it, for the grid chips (a double-hung, so each pattern shows on both sashes).
private struct GridGlyph: View {
    let grid: VisualGrid
    let ink: Color

    var body: some View {
        WindowThumbnail(type: .doubleHung, grid: grid, ink: ink, glassTint: ink)
    }
}

/// A small pane for the glass chips: how each glass looks.
private struct GlassGlyph: View {
    let glass: VisualGlass

    var body: some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(fill)
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.primary.opacity(0.35), lineWidth: 1))
            .overlay {
                if glass == .frosted {
                    Canvas { ctx, size in
                        for i in 0..<14 {
                            let x = CGFloat((i * 37) % 19) / 19 * size.width, y = CGFloat((i * 53) % 23) / 23 * size.height
                            ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 2, height: 2)), with: .color(.white.opacity(0.85)))
                        }
                    }
                }
            }
    }

    private var fill: LinearGradient {
        switch glass {
        case .clear: return LinearGradient(colors: [Color(.systemBlue).opacity(0.10), Color(.systemBlue).opacity(0.04)], startPoint: .top, endPoint: .bottom)
        case .lowE: return LinearGradient(colors: [Color(.systemTeal).opacity(0.42), Color(.systemTeal).opacity(0.18)], startPoint: .top, endPoint: .bottom)
        case .frosted: return LinearGradient(colors: [Color(.systemGray4), Color(.systemGray5)], startPoint: .top, endPoint: .bottom)
        }
    }
}

/// The before and after of one photo with a divider to drag (Apple's own compare idiom: a thin line and a round handle).
/// The left of the divider shows the photo as it was and the right shows the new window; it starts at the far left (all "after").
struct BeforeAfterView: View {
    let before: UIImage
    let after: UIImage
    @Binding var position: Double

    @State private var dragged = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let x = min(max(position, 0), 1) * w
            ZStack {
                Image(uiImage: after).resizable().scaledToFill().frame(width: w, height: h).clipped()
                Image(uiImage: before).resizable().scaledToFill().frame(width: w, height: h).clipped()
                    .mask(alignment: .leading) { Rectangle().frame(width: x) }
                // The divider
                Rectangle().fill(.white).frame(width: 2, height: h)
                    .shadow(color: .black.opacity(0.35), radius: 2)
                    .position(x: x, y: h / 2)
                    .opacity(position > 0.01 ? 1 : 0)
                Image(systemName: "arrow.left.and.right")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.primary)
                    .frame(width: 40, height: 40)
                    .background(.regularMaterial, in: Circle())
                    .overlay(Circle().strokeBorder(.white.opacity(0.7), lineWidth: 1))
                    .shadow(color: .black.opacity(0.25), radius: 4, y: 1)
                    .position(x: min(max(x, 26), w - 26), y: h / 2)
                    .accessibilityHidden(true)
                // Labels
                VStack {
                    HStack {
                        if position > 0.22 { tag("Before") }
                        Spacer()
                        if position < 0.88 { tag("After") }
                    }
                    Spacer()
                    if !dragged {
                        Text("Drag to compare")
                            .font(.footnote.weight(.medium)).foregroundStyle(Theme.ink)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Theme.surface.opacity(0.94), in: Capsule())
                            .transition(.opacity)
                    }
                }
                .padding(10)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        position = min(max(value.location.x / max(w, 1), 0), 1)
                        if !dragged { withAnimation(.easeOut(duration: 0.2)) { dragged = true } }
                    }
            )
            .accessibilityElement()
            .accessibilityLabel("Before and after")
            .accessibilityValue("\(Int((position * 100).rounded())) percent before")
            .accessibilityHint("Swipe up or down to move the divider")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: position = min(position + 0.1, 1)
                case .decrement: position = max(position - 0.1, 0)
                @unknown default: break
                }
            }
        }
    }

    private func tag(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Theme.surface.opacity(0.94), in: Capsule())
    }
}
