import RooflineCore
import SwiftUI

/// 15 My order (ios-hw-15): where the order is, in five steps, and how to reach someone. Three tabs: My order, Windows, Messages.
/// Each tab is a grouped list under a large title in the app's navigation bar (a root: no back button). The tab bar sits under the
/// list, not over it: iOS 26's own floating `TabView` bar lets the list scroll beneath it, and the accessibility audit (which looks at
/// the screen before it is scrolled) then reads the rows behind the glass as failing contrast.
struct StatusScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var tab = "order"

    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch tab {
                case "windows": WindowsTab()
                case "messages": MessagesTab()
                default: OrderTab()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            WCTabBar(items: [
                .init(id: "order", title: "My order", icon: .truck),
                .init(id: "windows", title: "Windows", icon: .win),
                .init(id: "messages", title: "Messages", icon: .message),
            ], selection: $tab)
        }
        .hiNav(title: title, display: .large, showsBack: false)
        .task { await store.loadStatus() }
    }

    /// The bar's title is the tab's own.
    private var title: String {
        switch tab {
        case "windows": return "Windows"
        case "messages": return "Messages"
        default: return "My order"
        }
    }
}

private struct OrderTab: View {
    @Environment(HomeownerStore.self) private var store

    private var stage: HomeownerStage { store.status?.stage ?? .requested }
    private var zone: TimeZone { store.timeZone }

    private var steps: [OrderTimeline.Step] {
        let city = store.address.split(separator: ",").dropFirst().first.map { $0.trimmingCharacters(in: .whitespaces) }
        let visit = store.status?.dates["visit"].flatMap(VisitTimes.parse).map { VisitTimes.weekdayMonthDay($0, zone) } ?? store.visitStart.map { VisitTimes.weekdayMonthDay($0, zone) }
        return OrderTimeline.steps(stage: stage, dates: store.status?.dates ?? [:], windowCount: store.windowCount, city: city, visitDate: visit)
    }

    private var addressLine: String {
        "\(store.address.split(separator: ",").first.map(String.init) ?? store.address) · \(store.windowCount) window\(store.windowCount == 1 ? "" : "s")"
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(OrderTimeline.headline(stage)).font(.title2.weight(.bold)).foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text(OrderTimeline.subhead(stage)).font(.body).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
                if let eta = store.status?.eta.flatMap(VisitTimes.parse) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Image(systemName: WCIcon.truck.symbol).foregroundStyle(Theme.red).accessibilityHidden(true)
                        Text("Expected to ship \(VisitTimes.monthDay(eta, zone))").foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                VStack(alignment: .leading, spacing: 2) {
                    Text([store.brand.wordmark, store.status?.orderNumber.map { "Order \($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .fontWeight(.semibold)
                    Text(addressLine)
                }
                .font(.footnote)
                .foregroundStyle(Theme.ink2)
                .textCase(nil)
                .accessibilityElement(children: .combine)
            }
            Section {
                ForEach(steps) { step in TimelineRow(step: step, zone: zone) }
            } header: {
                Text("Progress").foregroundStyle(Theme.ink2)
            }
            Section {
                if let sms = store.companyPhone.flatMap({ URL(string: "sms:\($0.filter { $0.isNumber || $0 == "+" })") }) {
                    Link(destination: sms) { questionsRow(icon: .message, title: "Questions? Text the office") }
                } else {
                    questionsRow(icon: .phone, title: "Questions? Call the \(store.brand.name) office")
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await store.loadStatus() }
    }
}

extension OrderTab {
    /// "Questions?" as one row: a symbol, the ask, and who answers.
    fileprivate func questionsRow(icon: WCIcon, title: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Theme.ink)
                Text(store.repName.map { "Text \($0) or the \(store.brand.name) office" } ?? "Text or call the \(store.brand.name) office")
                    .font(.footnote).foregroundStyle(Theme.ink2)
            }
        } icon: {
            Image(systemName: icon.symbol).foregroundStyle(Theme.red)
        }
    }
}

/// One step of the order as a list row with a status symbol: a green checkmark when done, the accent dot for the step in
/// progress, an empty circle for what is coming up; its date after it.
private struct TimelineRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let step: OrderTimeline.Step
    let zone: TimeZone

    private var dateText: String? {
        guard let d = step.date else { return nil }
        if let parsed = VisitTimes.parse(d) { return VisitTimes.monthDay(parsed, zone) }
        // "2026-10-03" or "now" / "you pick"
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        if let day = f.date(from: d) {
            f.dateFormat = "MMM d"
            return f.string(from: day)
        }
        return d
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            marker.font(.title3).frame(width: 28, height: 28)
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 2) { texts; date }
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                texts.frame(maxWidth: .infinity, alignment: .leading)
                date
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(step.title). \(step.detail). \(stateWords)\(dateText.map { ". \($0)" } ?? "")")
    }

    private var texts: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(step.title).font(.headline).foregroundStyle(step.state == .now ? Theme.red : Theme.ink)
            Text(step.detail).font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var date: some View {
        if let d = dateText { Text(d).font(.subheadline).monospacedDigit().foregroundStyle(Theme.ink2).padding(.top, 2) }
    }

    private var stateWords: String {
        switch step.state {
        case .done: return "Done"
        case .now: return "In progress"
        case .pending: return "Coming up"
        }
    }

    @ViewBuilder private var marker: some View {
        switch step.state {
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.ok)
        case .now:
            Image(systemName: "circle.inset.filled").foregroundStyle(Theme.red)
        case .pending:
            Image(systemName: "circle").foregroundStyle(Theme.decor)
        }
    }
}

/// The Windows tab: the same windows as the list, read-only, with a way to add more.
private struct WindowsTab: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        let rows = store.windowRows
        List {
            Section {
                ForEach(rows, id: \.id) { row in
                    WindowListRow(row: row) {}
                        .listRowInsets(EdgeInsets())
                }
            } header: {
                HiListHeading(title: "\(rows.count) window\(rows.count == 1 ? "" : "s")", subtitle: "Sizes are the inside of each frame, in inches. A rep re-measures every one.")
            }
            Section {
                Button {
                    store.path = store.stack(to: .rooms)
                    store.noteStep(.rooms)
                } label: {
                    Label("Add a window", systemImage: WCIcon.plus.symbol)
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

/// The Messages tab: there is no chat in the app, so this says how to reach the company: text or call.
private struct MessagesTab: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        List {
            Section {
                if let phone = store.companyPhone {
                    let digits = phone.filter { $0.isNumber || $0 == "+" }
                    if let sms = URL(string: "sms:\(digits)"), let tel = URL(string: "tel:\(digits)") {
                        Link(destination: sms) { actionRow(icon: .message, title: "Text us", detail: PhoneDisplay.pretty(phone)) }
                        Link(destination: tel) { actionRow(icon: .phone, title: "Call us", detail: PhoneDisplay.pretty(phone)) }
                    }
                } else {
                    Label {
                        Text("We'll show the office's number here once your company has added one.").font(.subheadline).foregroundStyle(Theme.ink2)
                    } icon: {
                        Image(systemName: WCIcon.info.symbol).foregroundStyle(Theme.ink2)
                    }
                }
            } header: {
                HiListHeading(title: "Questions?", subtitle: "Text or call the \(store.brand.name) office about your order. Say your address so we can find it.")
            }
        }
        .listStyle(.insetGrouped)
    }

    private func actionRow(icon: WCIcon, title: String, detail: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(detail).font(.footnote).monospacedDigit().foregroundStyle(Theme.ink2)
            }
        } icon: {
            Image(systemName: icon.symbol).foregroundStyle(Theme.red)
        }
    }
}

enum PhoneDisplay {
    /// "+15015550100" -> "(501) 555-0100"; anything else as is.
    static func pretty(_ phone: String) -> String {
        guard let d = PhoneFormat.digits(phone) else { return phone }
        return PhoneFormat.display(d)
    }
}
