import EventKit
import EventKitUI
import RooflineCore
import SwiftUI

/// 14 Booked (ios-hw-14): the visit is on the calendar. The date, the rep, two things to do, Add to Calendar.
struct BookedScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var showCalendar = false

    private var zone: TimeZone { store.timeZone }
    private var start: Date? { store.visitStart }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Circle().fill(Theme.ok)
                IconView(icon: .check, size: 24, weight: 1.7).foregroundStyle(.white)
            }
            .frame(width: 56, height: 56)
            .accessibilityHidden(true)
            Text("Your visit is booked").wcHeading(28, .heavy, relativeTo: .title).foregroundStyle(Theme.ink).padding(.top, 20).accessibilityAddTraits(.isHeader)
            Text(savedLine).wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2).padding(.top, 6).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    if let s = start { CalendarTile(month: VisitTimes.monthShortCaps(s, zone), day: VisitTimes.dayNumber(s, zone)) }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(start.map { VisitTimes.confirmation($0, zone) } ?? "Your visit").wc(20, .semibold, relativeTo: .title3).foregroundStyle(Theme.ink)
                        Text("About 30 minutes · \(store.address.split(separator: ",").first.map(String.init) ?? store.address)")
                            .wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .padding(14)
                RowDivider(inset: 14)
                HStack(spacing: 14) {
                    RepAvatar(size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.repName ?? "A \(store.brand.name) rep").wc(18, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                        Text("Re-measures your \(store.windowCount) window\(store.windowCount == 1 ? "" : "s") by hand").wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3)
                    }
                    Spacer(minLength: 0)
                }
                .padding(14)
            }
            .wcCard(radius: 16)
            .padding(.top, 20)
            VStack(alignment: .leading, spacing: 10) {
                tip("Open the blinds in each room if you can")
                tip("You can still add windows in the app until then")
            }
            .padding(.top, 16).padding(.horizontal, 4)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .topTrailing) {
            NavTextButton(title: "My order") { store.showStatus() }
                .padding(.trailing, Theme.gutter)
        }
        .background(Theme.ground.ignoresSafeArea())
        .wcFooter {
            WCSecondaryButton(title: "Add to Calendar", icon: .calendar) { showCalendar = true }
            Group {
                if let tel = store.companyPhone.flatMap(CallbackSentScreen.telURL) {
                    HStack(spacing: 4) {
                        Text("Need another time?").foregroundStyle(Theme.ink3)
                        Link("Call us.", destination: tel).foregroundStyle(Theme.blue)
                    }
                } else {
                    Text("Need another time? Contact \(store.brand.name).").foregroundStyle(Theme.ink3)
                }
            }
            .wc(14, relativeTo: .footnote)
            .frame(minHeight: Theme.minTap)
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showCalendar) {
            if let s = start {
                CalendarEventSheet(title: "\(store.brand.name) visit", location: store.address, start: s, end: store.visitEnd ?? s.addingTimeInterval(1800), notes: "A rep re-measures your windows by hand.")
                    .ignoresSafeArea()
            }
        }
    }

    private var savedLine: String {
        guard let key = store.progress.tierKey, let total = store.progress.tierTotal else { return "Your quote is saved." }
        let label = store.quote?.tier(key)?.label ?? key.capitalized
        let count = store.progress.tierWindowCount ?? store.windowCount
        return "Your quote is saved: \(label), \(count) window\(count == 1 ? "" : "s"), \(Money.dollars(total))."
    }

    private func tip(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconView(icon: .check, size: 18, weight: 2).foregroundStyle(Theme.ok).padding(.top, 1)
            Text(text).wc(16, relativeTo: .body).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The little calendar page: the month in red, the day big.
struct CalendarTile: View {
    let month: String
    let day: String

    var body: some View {
        VStack(spacing: 0) {
            Text(month).wc(15, .bold, relativeTo: .footnote).foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 3).background(Theme.red)
            Text(day).wc(30, .bold, relativeTo: .title).foregroundStyle(Theme.ink).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 54, height: 54)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.line2, lineWidth: 1))
        .accessibilityHidden(true)
    }
}

/// The system's own "add event" sheet, filled in (it asks for calendar access itself, write only).
struct CalendarEventSheet: UIViewControllerRepresentable {
    let title: String
    let location: String
    let start: Date
    let end: Date
    let notes: String
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        event.title = title
        event.location = location
        event.startDate = start
        event.endDate = end
        event.notes = notes
        event.calendar = store.defaultCalendarForNewEvents
        let vc = EKEventEditViewController()
        vc.eventStore = store
        vc.event = event
        vc.editViewDelegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: EKEventEditViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(dismiss: { dismiss() }) }

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let dismiss: () -> Void
        init(dismiss: @escaping () -> Void) { self.dismiss = dismiss }

        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            dismiss()
        }
    }
}
