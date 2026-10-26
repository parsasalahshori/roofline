import ImageIO
import RooflineCore
import SwiftUI
import UIKit

// The result of a guided scan, as a standard list: the best photo with the window's rectangle on it, whether it is Measured (green) or
// "We'll have WinChoice check this one" (amber; never a block), the opening's size and the window's, how sure each corner is, and a strip of
// every photo with its marks. A photo opens a sheet where a mark can be dragged; the answer is worked out again from the marks.

/// Pictures of a scan cut down for the screens, decoded once.
@MainActor
final class ScanThumbs {
    private var full: [String: UIImage] = [:]
    private var small: [String: UIImage] = [:]

    func image(_ shot: ScanShot) -> UIImage? {
        if let hit = full[shot.id] { return hit }
        guard let img = UIImage(data: shot.uprightJPEG) else { return nil }
        full[shot.id] = img
        return img
    }

    func thumb(_ shot: ScanShot) -> UIImage? {
        if let hit = small[shot.id] { return hit }
        guard let src = CGImageSourceCreateWithData(shot.uprightJPEG as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageIfAbsent: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 360]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let img = UIImage(cgImage: cg)
        small[shot.id] = img
        return img
    }
}

/// A photo with the window's outline and the marks on it. With `onMove` the marks can be dragged (a mark nothing confirmed is hollow).
struct ScanPhotoCanvas: View {
    struct Dot: Identifiable {
        let corner: Int
        let point: CGPoint
        let confirmed: Bool
        var id: Int { corner }
    }

    let image: UIImage
    /// The upright photo's size in its own pixels (the outline and the dots are in them).
    let photoSize: CGSize
    var outline: [CGPoint] = []
    var dots: [Dot] = []
    var labels = false
    var onMove: ((Int, CGPoint) -> Void)?
    @State private var dragging: [Int: CGPoint] = [:]

    var body: some View {
        GeometryReader { geo in
            let k = geo.size.width / max(photoSize.width, 1)
            ZStack(alignment: .topLeading) {
                Image(uiImage: image).resizable().frame(width: geo.size.width, height: geo.size.height)
                if outline.count == 4 {
                    Path { p in
                        p.move(to: CGPoint(x: outline[0].x * k, y: outline[0].y * k))
                        for q in outline.dropFirst() { p.addLine(to: CGPoint(x: q.x * k, y: q.y * k)) }
                        p.closeSubpath()
                    }
                    .stroke(Theme.tape, style: StrokeStyle(lineWidth: 2.5, lineJoin: .round))
                    .shadow(color: .black.opacity(0.35), radius: 1.5)
                }
                ForEach(dots) { d in
                    let at = dragging[d.corner] ?? CGPoint(x: d.point.x * k, y: d.point.y * k)
                    let drag = DragGesture(minimumDistance: 0, coordinateSpace: .named("scanCanvas"))
                        .onChanged { dragging[d.corner] = $0.location }
                        .onEnded { v in
                            dragging[d.corner] = nil
                            onMove?(d.corner, CGPoint(x: v.location.x / k, y: v.location.y / k))
                        }
                    dot(d)
                        .position(at)
                        .gesture(drag, including: onMove == nil ? GestureMask.none : GestureMask.all)
                }
            }
            .coordinateSpace(name: "scanCanvas")
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
        }
        .aspectRatio(photoSize, contentMode: .fit)
    }

    private func dot(_ d: Dot) -> some View {
        ZStack {
            Circle().fill(d.confirmed ? Theme.tape : Color.clear).frame(width: 14, height: 14)
            Circle().strokeBorder(Color.white, style: StrokeStyle(lineWidth: 2, dash: d.confirmed ? [] : [3, 3])).frame(width: 18, height: 18)
            if labels {
                Text(ScanCorner.short[d.corner]).font(.caption2.weight(.bold)).foregroundStyle(.white).shadow(radius: 2).offset(x: 0, y: -18)
            }
        }
        .shadow(color: .black.opacity(0.4), radius: 1.5)
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .accessibilityLabel("\(ScanCorner.names[d.corner]) corner, \(d.confirmed ? "marked" : "estimated")")
    }
}

extension GuidedScanModel {
    /// The marks of one photo as dots on its upright picture.
    func dots(for shot: ScanShot) -> [ScanPhotoCanvas.Dot] {
        guard let d = draft else { return [] }
        return d.allMarks.filter { $0.frameId == shot.id }.map { m in
            ScanPhotoCanvas.Dot(corner: m.corner, point: ScanProcessing.photoPoint(m, in: shot), confirmed: m.source != .projected)
        }
    }

    /// The scan's rectangle as seen in one photo.
    func outline(in shot: ScanShot) -> [CGPoint] {
        guard let corners = openingCornersM else { return [] }
        return ScanProcessing.outline(of: corners, in: shot) ?? []
    }

    /// Photos that contributed at least one mark to the answer.
    var photosUsed: Int {
        guard let d = draft else { return 0 }
        return Set(d.usedMarks.map { $0.frameId }).count
    }
}

struct ScanResultView: View {
    let model: GuidedScanModel
    let title: String
    let onUse: () -> Void
    let onAgain: () -> Void
    let onClose: () -> Void
    /// The room-scan hybrid shows each window's result with other words: "Done" instead of "Use this size", and no "Scan again".
    var useTitle = "Use this size"
    var againTitle: String? = "Scan again"
    var navTitle = "Your window"
    @State private var thumbs = ScanThumbs()
    @State private var editing: ScanShot?

    var body: some View {
        NavigationStack {
            List {
                heroSection
                statusSection
                sizeSection
                cornersSection
                photosSection
            }
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", action: onClose) }
            }
            .safeAreaInset(edge: .bottom) { actions }
        }
        .tint(Theme.red)
        .sheet(item: $editing) { shot in
            ScanMarkEditor(model: model, shotId: shot.id, thumbs: thumbs)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
    }

    // MARK: Sections

    @ViewBuilder private var heroSection: some View {
        if let shot = model.bestShot, let image = thumbs.image(shot) {
            Section {
                ScanPhotoCanvas(image: image, photoSize: CGSize(width: shot.view.photoWidthPx, height: shot.view.photoHeightPx),
                                outline: model.outline(in: shot), dots: model.dots(for: shot))
                    .frame(maxHeight: 250)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .frame(maxWidth: .infinity)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Photo of the window with its outline")
            }
        }
    }

    private var statusSection: some View {
        Section {
            if model.isMeasured {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Measured").font(.headline)
                        Text("Measured from \(model.photosUsed) photos").font(.subheadline).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(.green).imageScale(.large)
                }
            } else {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("We'll have WinChoice check this one").font(.headline)
                        Text(reasons).font(.subheadline).foregroundStyle(.secondary)
                        Text("You can still use this size. Someone will check it against your photos.").font(.footnote).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).imageScale(.large)
                }
            }
        }
    }

    private var reasons: String {
        guard let s = model.solution else { return "We couldn't measure from these photos." }
        let r = s.quality.hardFailures.prefix(2).map { ScanCopy.reason($0) }
        if s.fit == nil && r.isEmpty { return "We couldn't find all four corners in enough photos." }
        return r.isEmpty ? "Measured from \(model.photosUsed) photos" : r.joined(separator: ". ")
    }

    private var sizeSection: some View {
        Section {
            if let size = model.size {
                LabeledContent("Opening") {
                    Text(SizeWording.sizeText(widthIn: size.widthIn, heightIn: size.heightIn)).font(.title3.weight(.semibold)).monospacedDigit()
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Opening \(SizeWording.spokenSize(widthIn: size.widthIn, heightIn: size.heightIn))")
                if let w = model.draft?.windowFrame {
                    LabeledContent("Window") {
                        Text(w.text + (w.estimated == true ? " (estimated)" : "")).font(.body).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
                Text("Measured from \(model.photosUsed) photos").font(.footnote).foregroundStyle(.secondary)
            } else {
                Label("No size yet", systemImage: "questionmark.circle").foregroundStyle(.secondary)
            }
        } header: {
            Text("Size")
        }
    }

    private var cornersSection: some View {
        Section {
            ForEach(0..<4, id: \.self) { c in
                let confidence = model.solution?.confidence(corner: c) ?? .check
                let seen = model.solution?.quality.framesPerCorner[safe: c] ?? 0
                LabeledContent {
                    Text(confidence.word).foregroundStyle(color(confidence))
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(ScanCorner.names[c].capitalized).font(.body)
                            Text("In \(seen) photos").font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: symbol(confidence)).foregroundStyle(color(confidence))
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(ScanCorner.names[c]) corner, \(confidence.word), seen in \(seen) photos")
            }
        } header: {
            Text("Corners")
        }
    }

    private var photosSection: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 10) {
                    ForEach(model.shots) { shot in
                        Button { editing = shot } label: { thumb(shot) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(shot.label). Opens it to move a corner")
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 4)
            }
            .listRowInsets(EdgeInsets())
        } header: {
            Text("Photos")
        } footer: {
            Text("Tap a photo to move a corner if it isn't on the window's corner.")
        }
    }

    private func thumb(_ shot: ScanShot) -> some View {
        let big = (model.solution?.markErrors.filter { $0.frameId == shot.id }.map { $0.px }.max() ?? 0) > ScanLimits.reprojMaxPx
        return VStack(spacing: 4) {
            ZStack(alignment: .topTrailing) {
                if let t = thumbs.thumb(shot) {
                    ScanPhotoCanvas(image: t, photoSize: CGSize(width: shot.view.photoWidthPx, height: shot.view.photoHeightPx), outline: model.outline(in: shot), dots: model.dots(for: shot))
                        .frame(width: 84)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(.secondarySystemFill)).frame(width: 84, height: 112)
                }
                if big {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange, Color(.systemBackground)).padding(4)
                }
            }
            Text(shot.kind == .closeup ? "Close-up" : "Photo \(shot.id.dropFirst())").font(.caption2).foregroundStyle(.secondary)
        }
        .frame(minWidth: 44, minHeight: 44)
    }

    private func color(_ c: ScanConfidence) -> Color {
        switch c {
        case .sure: return .green
        case .fair: return .secondary
        case .check: return .orange
        }
    }

    private func symbol(_ c: ScanConfidence) -> String {
        switch c {
        case .sure: return "checkmark.circle.fill"
        case .fair: return "circle.lefthalf.filled"
        case .check: return "exclamationmark.circle.fill"
        }
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button(action: onUse) { Text(useTitle).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.size == nil)
                .accessibilityHint(againTitle == nil ? "" : "Keeps this window and goes on to name it")
            if let again = againTitle {
                Button(action: onAgain) { Text(again).frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).controlSize(.large)
            }
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
        .background(.bar)
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// One photo of the scan, large, with its four marks to drag onto the window's corners.
struct ScanMarkEditor: View {
    let model: GuidedScanModel
    let shotId: String
    let thumbs: ScanThumbs
    @Environment(\.dismiss) private var dismiss

    private var shot: ScanShot? { model.shots.first { $0.id == shotId } }

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                if let shot = shot, let image = thumbs.image(shot) {
                    ScanPhotoCanvas(image: image, photoSize: CGSize(width: shot.view.photoWidthPx, height: shot.view.photoHeightPx), outline: model.outline(in: shot),
                                    dots: model.dots(for: shot), labels: true) { corner, point in
                        model.moveMark(shotId: shot.id, corner: corner, toNative: ScanProcessing.nativePoint(point, in: shot))
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.horizontal, 16)
                    Text(shot.kind == .closeup ? "Drag the dot onto the \(ScanCorner.names[shot.corner ?? 0]) corner of the window." : "Drag any dot that isn't on its corner of the window.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 24)
                    if let s = model.solution {
                        HStack(spacing: 8) {
                            Image(systemName: s.status == .measured ? "checkmark.seal.fill" : "exclamationmark.triangle.fill").foregroundStyle(s.status == .measured ? .green : .orange)
                            Text(s.status == .measured ? "Measured" : "WinChoice will check this one").font(.footnote.weight(.semibold))
                        }
                    }
                } else {
                    ContentUnavailableView("Photo not available", systemImage: "photo")
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 8)
            .navigationTitle(shot?.label ?? "Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.large])
        .tint(Theme.red)
    }
}
