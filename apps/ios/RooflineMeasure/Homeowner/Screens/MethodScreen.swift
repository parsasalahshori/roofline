import RooflineCore
import SwiftUI

/// 06 Method (ios-hw-06): how do you want to measure this window? Three ways, each with how exact it is, in the phone's own
/// words (no "LiDAR", no "ID-1"). A method this phone cannot do is greyed out and says why.
struct MethodScreen: View {
    @Environment(HomeownerStore.self) private var store
    let room: String

    private var windowNumberInRoom: Int {
        store.windowRows.filter { $0.room.caseInsensitiveCompare(room) == .orderedSame }.count + 1
    }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            WCNavBar(title: "\(room) · window \(windowNumberInRoom)", onBack: { store.pop() })
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    WCHeadline(text: "How do you want to measure?", subtitle: store.capabilities.methodsSentence).padding(.bottom, 4)
                    // Apple's room scan first on a phone with a depth sensor: the quickest way, one wall or the whole room
                    if store.capabilities.roomScan {
                        MethodCard(method: .quickScan, selected: store.method == .quickScan) { store.method = .quickScan }
                        MethodCard(method: .roomScan, selected: store.method == .roomScan) { store.method = .roomScan }
                    }
                    MethodCard(method: .corners, selected: store.method == .corners) { store.method = .corners }
                    if !store.capabilities.roomScan {
                        MethodCard(method: .roomScan, selected: store.method == .roomScan) { store.method = .roomScan }
                    }
                    MethodCard(method: .card, selected: store.method == .card) { store.method = .card }
                    if store.capabilities.methodCount == 0 {
                        InfoPanel(icon: .alert, text: "Measuring needs an iPhone with a camera. Your request is saved. Open WinChoice on your iPhone to measure.", tint: Theme.warnTint, iconColor: Theme.warn)
                    }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
        }
        .wcFooter {
            WCPrimaryButton(title: "Start", isEnabled: store.isAvailable(store.method)) { store.startMeasuring(room: room) }
        }
        .wcScreenChrome()
        .onAppear {
            if !store.isAvailable(store.method) { store.method = store.defaultMethod }
        }
    }
}

private struct MethodCard: View {
    @Environment(HomeownerStore.self) private var store
    let method: MeasureMethod
    let selected: Bool
    let action: () -> Void

    private var available: Bool { store.isAvailable(method) }

    private var title: String {
        switch method {
        case .corners: return "Tap the 4 corners"
        case .roomScan: return "Scan the whole room"
        case .quickScan: return "Quick scan (Apple)"
        case .card: return "Photo with a bank card"
        }
    }

    private var detail: String {
        switch method {
        case .corners: return "Point your phone at the window and tap each corner of the frame."
        case .roomScan: return "Walk slowly around the room. We find every window in it."
        case .quickScan: return "Point at the wall with the window and pan for a few seconds. We find the windows on it."
        case .card: return "Hold any bank card flat on the glass and take one photo. Works on any iPhone."
        }
    }

    private var unavailable: String {
        switch method {
        case .corners: return "Needs an iPhone with a camera."
        case .roomScan, .quickScan: return "Needs an iPhone with a depth sensor (a Pro model)."
        case .card: return "Needs an iPhone with a camera."
        }
    }

    var body: some View {
        let accuracy = store.methodAccuracy(method)
        Button(action: {
            if available {
                Haptics.tap()
                action()
            }
        }) {
            HStack(alignment: .center, spacing: 14) {
                Group {
                    switch method {
                    case .corners: IconView(icon: .target, size: 26).foregroundStyle(Theme.blue)
                    case .roomScan: IconView(icon: .cube, size: 26).foregroundStyle(Theme.ink)
                    case .quickScan: IconView(icon: .lidar, size: 26).foregroundStyle(Theme.blue)
                    case .card: BankCardGlyph(width: 32)
                    }
                }
                .frame(width: 48, height: 48)
                .background(selected ? Theme.surface : Theme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).wc(19, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    Text(detail).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                    if available {
                        let tag = store.methodTag(method)
                        WCTag(text: tag.text, kind: tag.best ? .ok : .blue, radius: 5)
                            .padding(.top, 4)
                        if method.isRoomPlan {
                            // Apple's scan gives a quote-grade size, not a number of inches: the visit settles the exact one
                            Text("\(accuracy.text). We confirm the exact size at your visit.").wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3)
                        } else if tag.text != accuracy.text {
                            Text("Accuracy: \(accuracy.text)").wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3)
                        }
                    } else {
                        Text(unavailable).wc(13, .medium, relativeTo: .footnote).foregroundStyle(Theme.warn).padding(.top, 4)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                WCRadio(isOn: selected && available, size: 24)
            }
            .padding(14)
            .wcCard(selected: selected && available, radius: 16)
            .opacity(available ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(detail) \(available ? store.methodTag(method).text + (method.isRoomPlan ? ". " + accuracy.text + "." : ". Accuracy: " + accuracy.text) : unavailable)")
        .accessibilityValue(selected && available ? "Selected" : "")
        .accessibilityAddTraits(.isButton)
    }
}
