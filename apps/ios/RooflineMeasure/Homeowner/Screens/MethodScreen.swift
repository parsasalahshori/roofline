import RooflineCore
import SwiftUI

/// 06 Method (ios-hw-06): how do you want to measure this window? Three ways, each with how exact it is, in the phone's own
/// words (no "LiDAR", no "ID-1"). A method this phone cannot do is greyed out and says why.
/// A native grouped list of rows (a symbol, the way, how it works, how exact it is), one chosen with a checkmark.
struct MethodScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let room: String

    private var windowNumberInRoom: Int {
        store.windowRows.filter { $0.room.caseInsensitiveCompare(room) == .orderedSame }.count + 1
    }

    var body: some View {
        List {
            Section {
                // Apple's room scan first on a phone with a depth sensor: the quickest way, one wall or the whole room
                if store.capabilities.roomScan {
                    MethodRow(method: .roomCloseups, selected: store.method == .roomCloseups) { store.method = .roomCloseups }
                    MethodRow(method: .quickScan, selected: store.method == .quickScan) { store.method = .quickScan }
                    MethodRow(method: .roomScan, selected: store.method == .roomScan) { store.method = .roomScan }
                }
                MethodRow(method: .corners, selected: store.method == .corners) { store.method = .corners }
                if !store.capabilities.roomScan {
                    MethodRow(method: .roomScan, selected: store.method == .roomScan) { store.method = .roomScan }
                }
                MethodRow(method: .card, selected: store.method == .card) { store.method = .card }
            } header: {
                HiListHeading(title: "How do you want to measure?", subtitle: store.capabilities.methodsSentence)
            }
            if store.capabilities.methodCount == 0 {
                Section {
                    Label {
                        Text("Measuring needs an iPhone with a camera. Your request is saved. Open WinChoice on your iPhone to measure.").font(.subheadline).foregroundStyle(Theme.ink)
                    } icon: {
                        Image(systemName: WCIcon.alert.symbol).foregroundStyle(Theme.warn)
                    }
                }
            }
            if typeSize.isAccessibilitySize {
                Section { WCScrollFooter() }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.insetGrouped)
        .wcFooter {
            WCPrimaryButton(title: "Start", isEnabled: store.isAvailable(store.method)) { store.startMeasuring(room: room) }
        }
        .hiNav(title: "\(room) · window \(windowNumberInRoom)")
        .onAppear {
            store.selectStartingMethod()
        }
    }
}

private struct MethodRow: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let method: MeasureMethod
    let selected: Bool
    let action: () -> Void

    private var available: Bool { store.isAvailable(method) }

    private var title: String {
        switch method {
        case .corners: return "Tap the 4 corners"
        case .roomScan: return "Scan the whole room"
        case .quickScan: return "Quick scan (Apple)"
        case .roomCloseups: return "Scan the room, then close-ups"
        case .card: return "Photo with a bank card"
        }
    }

    private var detail: String {
        switch method {
        case .corners: return "Point your phone at the window and tap each corner of the frame."
        case .roomScan: return "Walk slowly around the room. We find every window in it."
        case .quickScan: return "Point at the wall with the window and pan for a few seconds. We find the windows on it."
        case .roomCloseups: return "Pan the room to find the windows, take a close-up of each corner, then tap Measure and check."
        case .card: return "Hold any bank card flat on the glass and take one photo. Works on any iPhone."
        }
    }

    private var unavailable: String {
        switch method {
        case .corners: return "Needs an iPhone with a camera."
        case .roomScan, .quickScan, .roomCloseups: return "Needs an iPhone with a depth sensor (a Pro model)."
        case .card: return "Needs an iPhone with a camera."
        }
    }

    /// The row's symbol, in a quiet tile like a Settings row's.
    @ViewBuilder private var glyph: some View {
        Group {
            switch method {
            case .corners: Image(systemName: WCIcon.target.symbol).font(.title3).foregroundStyle(Theme.ink)
            case .roomScan: Image(systemName: WCIcon.cube.symbol).font(.title3).foregroundStyle(Theme.ink)
            case .quickScan: Image(systemName: WCIcon.lidar.symbol).font(.title3).foregroundStyle(Theme.ink)
            case .roomCloseups: Image(systemName: "viewfinder.rectangular").font(.title3).foregroundStyle(Theme.ink)
            case .card: BankCardGlyph(width: 28)
            }
        }
        .symbolRenderingMode(.hierarchical)
        .frame(width: 40, height: 40)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityHidden(true)
    }

    var body: some View {
        let accuracy = store.methodAccuracy(method)
        Button(action: {
            if available {
                Haptics.tap()
                action()
            }
        }) {
            HStack(alignment: .top, spacing: 12) {
                if !typeSize.isAccessibilitySize { glyph }
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline).foregroundStyle(Theme.ink)
                    Text(detail).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    if available {
                        let tag = store.methodTag(method)
                        CapsuleLabel(text: tag.text, kind: tag.best ? .ok : .plain).padding(.top, 2)
                        if method.isRoomPlan {
                                                        Text("\(accuracy.text).").font(.footnote).foregroundStyle(Theme.ink2)
                        } else if method == .roomCloseups {
                            Text("A window you skip keeps Apple's size.").font(.footnote).foregroundStyle(Theme.ink2)
                        } else if tag.text != accuracy.text {
                            Text("Accuracy: \(accuracy.text)").font(.footnote).foregroundStyle(Theme.ink2)
                        }
                    } else {
                        Text(unavailable).font(.footnote.weight(.medium)).foregroundStyle(Theme.warnText).padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "checkmark")
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.red)
                    .opacity(selected && available ? 1 : 0)
                    .frame(width: 22, alignment: .trailing)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .opacity(available ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(detail) \(available ? store.methodTag(method).text + (method.isRoomPlan ? ". " + accuracy.text + "." : (method == .roomCloseups ? ". A window you skip keeps Apple's size." : ". Accuracy: " + accuracy.text)) : unavailable)")
        .accessibilityValue(selected && available ? "Selected" : "")
        .accessibilityAddTraits(.isButton)
    }
}
