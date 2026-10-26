import SwiftUI

/// The app's icon names, each drawn as an SF Symbol. The old hand-drawn set is gone; the cases stay so call sites compile.
/// Every symbol exists in SF Symbols 5 (iOS 17), the app's minimum.
enum WCIcon: String, CaseIterable {
    case home, win, gutter, factory, arrow, check, chevLeft, chevRight, pin, lock, lidar, target, cube, plus, alert, ruler
    case upload, calendar, truck, message, undo, close, phone, camera, clock, refresh, info

    /// The SF Symbol this icon is drawn with.
    var symbol: String {
        switch self {
        case .home: return "house.fill"
        case .win: return "window.vertical.closed"
        case .gutter: return "drop"
        case .factory: return "building.2"
        case .arrow: return "arrow.right"
        case .check: return "checkmark"
        case .chevLeft: return "chevron.backward"
        case .chevRight: return "chevron.forward"
        case .pin: return "mappin.and.ellipse"
        case .lock: return "lock"
        case .lidar: return "camera.metering.matrix"
        case .target: return "scope"
        case .cube: return "cube"
        case .plus: return "plus"
        case .alert: return "exclamationmark.triangle"
        case .ruler: return "ruler"
        case .upload: return "square.and.arrow.up"
        case .calendar: return "calendar"
        case .truck: return "truck.box"
        case .message: return "message"
        case .undo: return "arrow.uturn.backward"
        case .close: return "xmark"
        case .phone: return "phone"
        case .camera: return "camera"
        case .clock: return "clock"
        case .refresh: return "arrow.clockwise"
        case .info: return "info.circle"
        }
    }

    /// The symbol as an `Image`, for `Label`, `Menu` and the like (`Label("Call", systemImage: WCIcon.phone.symbol)` works too).
    var image: Image { Image(systemName: symbol) }
}

/// An icon at `size` points in the current foreground colour, drawn as a hierarchical SF Symbol. `weight` is the old stroke
/// weight (1.7 regular, 2 and over heavier); it picks the symbol weight. Decorative: hidden from VoiceOver, the row says it in words.
struct IconView: View {
    let icon: WCIcon
    var size: CGFloat = 18
    var weight: CGFloat = 1.7

    private var symbolWeight: Font.Weight {
        switch weight {
        case ..<1.95: return .regular
        case ..<2.3: return .medium
        default: return .semibold
        }
    }

    var body: some View {
        Image(systemName: icon.symbol)
            .symbolRenderingMode(.hierarchical)
            .font(.system(size: size * 0.92, weight: symbolWeight))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
