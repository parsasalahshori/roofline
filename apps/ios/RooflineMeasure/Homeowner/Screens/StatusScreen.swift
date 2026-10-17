import RooflineCore
import SwiftUI

/// 15 My order (ios-hw-15): where the order is, in five steps, and how to reach someone. Three tabs: My order, Windows, Messages.
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
        .background(Theme.ground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task { await store.loadStatus() }
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                AdaptiveStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(store.brand.wordmark).wcHeading(20, .heavy, relativeTo: .title3).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                        // the name never breaks across lines
                        .lineLimit(1).minimumScaleFactor(0.6)
                        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let n = store.status?.orderNumber { Text("Order \(n)").wc(15, .regular, relativeTo: .subheadline).foregroundStyle(Theme.ink3) }
                }
                .padding(.top, 10)
                Text("\(store.address.split(separator: ",").first.map(String.init) ?? store.address) · \(store.windowCount) window\(store.windowCount == 1 ? "" : "s")")
                    .wc(15, .semibold, relativeTo: .subheadline).foregroundStyle(Theme.blue).padding(.top, 14)
                Text(OrderTimeline.headline(stage)).wcHeading(32, .heavy, relativeTo: .largeTitle).foregroundStyle(Theme.ink).padding(.top, 4).accessibilityAddTraits(.isHeader)
                Text(OrderTimeline.subhead(stage)).wc(16, relativeTo: .body).foregroundStyle(Theme.ink2).padding(.top, 6).fixedSize(horizontal: false, vertical: true)
                if let eta = store.status?.eta.flatMap(VisitTimes.parse) {
                    HStack(spacing: 10) {
                        IconView(icon: .truck, size: 20).foregroundStyle(Theme.blue)
                        Text("Expected to ship \(VisitTimes.monthDay(eta, zone))").wc(17, .medium, relativeTo: .body).foregroundStyle(Theme.blue)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 44)
                    .background(Theme.blueTint, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .padding(.top, 14)
                    .accessibilityElement(children: .combine)
                }
                timeline.padding(.top, 18)
                questions.padding(.top, 14)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 20)
        }
        .refreshable { await store.loadStatus() }
    }

    private var timeline: some View {
        VStack(spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { i, step in
                TimelineRow(step: step, isLast: i == steps.count - 1, zone: zone)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .wcCard(radius: 20)
    }

    private var questions: some View {
        AdaptiveStack(spacing: 14) {
            IconView(icon: .message, size: 26).foregroundStyle(Theme.ink3)
            VStack(alignment: .leading, spacing: 2) {
                Text("Questions?").wc(18, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Text(store.repName.map { "Text \($0) or the \(store.brand.name) office" } ?? "Text or call the \(store.brand.name) office").wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let sms = store.companyPhone.flatMap({ URL(string: "sms:\($0.filter { $0.isNumber || $0 == "+" })") }) {
                Link(destination: sms) {
                    HStack(spacing: 8) {
                        IconView(icon: .message, size: 18, weight: 1.9)
                        Text("Text").wc(18, .bold, relativeTo: .headline)
                    }
                    .foregroundStyle(Theme.onRed)
                    .padding(.horizontal, 20).frame(minHeight: 50)
                    .background(Theme.red, in: Capsule())
                }
            }
        }
        .padding(14)
        .wcCard(radius: 16)
    }
}

private struct TimelineRow: View {
    let step: OrderTimeline.Step
    let isLast: Bool
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
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                marker.frame(width: 26, height: 26)
                if !isLast { Rectangle().fill(Theme.line2).frame(width: 2).frame(maxHeight: .infinity) }
            }
            .frame(width: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(step.title).wc(17, .semibold, relativeTo: .headline).foregroundStyle(step.state == .now ? Theme.blue : Theme.ink)
                Text(step.detail).wc(14, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, isLast ? 0 : 8)
            if let d = dateText { Text(d).wcMono(14, .regular, relativeTo: .subheadline).foregroundStyle(Theme.ink3).padding(.top, 2) }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(step.title). \(step.detail). \(stateWords)\(dateText.map { ". \($0)" } ?? "")")
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
            ZStack { Circle().fill(Theme.ok); IconView(icon: .check, size: 16, weight: 2.4).foregroundStyle(.white) }
        case .now:
            ZStack { Circle().fill(Theme.blue); Circle().fill(Theme.surface).frame(width: 9, height: 9) }
        case .pending:
            Circle().strokeBorder(Theme.line2, lineWidth: 2)
        }
    }
}

/// The Windows tab: the same windows as the list, read-only, with a way to add more.
private struct WindowsTab: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        let rows = store.windowRows
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                WCHeadline(text: "\(rows.count) window\(rows.count == 1 ? "" : "s")", subtitle: "Sizes are the inside of each frame, in inches. A rep re-measures every one.").padding(.top, 14)
                GroupCard {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                        WindowListRow(row: row) {}
                        if i < rows.count - 1 { RowDivider(inset: 56) }
                    }
                }
                .padding(.top, 16)
                WCSecondaryButton(title: "Add a window", icon: .plus) {
                    store.path = store.stack(to: .rooms)
                    store.noteStep(.rooms)
                }
                .padding(.top, 16)
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 20)
        }
    }
}

/// The Messages tab: there is no chat in the app, so this says how to reach the company: text or call.
private struct MessagesTab: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            WCHeadline(text: "Questions?", subtitle: "Text or call the \(store.brand.name) office about your order. Say your address so we can find it.").padding(.top, 14)
            if let phone = store.companyPhone {
                let digits = phone.filter { $0.isNumber || $0 == "+" }
                if let sms = URL(string: "sms:\(digits)"), let tel = URL(string: "tel:\(digits)") {
                    Link(destination: sms) { actionRow(icon: .message, title: "Text us", detail: PhoneDisplay.pretty(phone)) }
                    Link(destination: tel) { actionRow(icon: .phone, title: "Call us", detail: PhoneDisplay.pretty(phone)) }
                }
            } else {
                InfoPanel(icon: .info, text: "We'll show the office's number here once your company has added one.")
            }
            Spacer()
        }
        .padding(.horizontal, Theme.gutter)
    }

    private func actionRow(icon: WCIcon, title: String, detail: String) -> some View {
        HStack(spacing: 14) {
            IconTile(icon: icon, size: 40, iconSize: 20, selected: true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).wc(17, .semibold, relativeTo: .body).foregroundStyle(Theme.ink)
                Text(detail).wc(14, relativeTo: .footnote).foregroundStyle(Theme.ink3)
            }
            Spacer()
            IconView(icon: .chevRight, size: 16, weight: 2).foregroundStyle(Theme.ink3)
        }
        .padding(14)
        .wcCard(radius: 16)
    }
}

enum PhoneDisplay {
    /// "+15015550100" -> "(501) 555-0100"; anything else as is.
    static func pretty(_ phone: String) -> String {
        guard let d = PhoneFormat.digits(phone) else { return phone }
        return PhoneFormat.display(d)
    }
}
