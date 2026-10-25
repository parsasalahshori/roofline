import RooflineCore
import SwiftUI

/// 01b What to measure: windows or roof, one per request. A tap on a card goes straight on to the address.
struct ServiceScreen: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: store.brand.wordmark, wordmark: true, onBack: { store.pop() }) { StepDots(filled: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    WCHeadline(text: "What do you want to measure?", subtitle: "Pick one. You can measure the other one after.")
                        .padding(.bottom, 8)
                    ForEach(store.offeredServices, id: \.self) { service in
                        ServiceChoice(service: service) { store.chooseService(service) }
                    }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
        }
        .wcScreenChrome()
    }
}

/// One big card per service: icon tile, title, one line, a chevron. The whole card is the button.
struct ServiceChoice: View {
    let service: HomeownerService
    let action: () -> Void

    private var icon: WCIcon {
        switch service {
        case .windows: return .win
        case .roof: return .roof
        case .gutters: return .gutter // never listed: gutters are not offered to homeowners
        }
    }

    private var title: String {
        switch service {
        case .windows: return "Windows"
        case .roof: return "Roof"
        case .gutters: return "Gutters"
        }
    }

    private var line: String {
        switch service {
        case .windows: return "Measure each window with your iPhone and get your price."
        case .roof: return "We measure your roof from above and show you a price range."
        case .gutters: return "Priced at your free visit."
        }
    }

    var body: some View {
        Button(action: {
            Haptics.tap()
            action()
        }) {
            HStack(spacing: 14) {
                IconTile(icon: icon, size: 52, iconSize: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).wc(19, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                    Text(line).wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                IconView(icon: .chevRight, size: 18, weight: 2).foregroundStyle(Theme.ink3)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 18)
            .frame(minHeight: 92)
            .wcCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(line)")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("service.\(service.rawValue)")
    }
}
