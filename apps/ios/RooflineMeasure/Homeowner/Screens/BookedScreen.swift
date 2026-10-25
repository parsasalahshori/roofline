import EventKit
import EventKitUI
import RooflineCore
import SwiftUI

/// 14 Booked (ios-hw-14): the visit is on the calendar. The date, the rep, two things to do, Add to Calendar.
/// A native grouped list under a large title: the saved quote as the header, the visit and the rep as rows, the two things to do,
/// and the buttons at the bottom. "My order" is a plain toolbar button.
struct BookedScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var showCalendar = false

    private var zone: TimeZone { store.timeZone }
    private var start: Date? { store.visitStart }

    var body: some View {
        List {
            Section {
                AdaptiveStack(spacing: 14) {
                    if let s = start { CalendarTile(month: VisitTimes.monthShortCaps(s, zone), day: VisitTimes.dayNumber(s, zone)) }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(start.map { VisitTimes.confirmation($0, zone) } ?? "Your visit").font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                        Text("About 30 minutes · \(store.address.split(separator: ",").first.map(String.init) ?? store.address)")
                            .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                AdaptiveStack(spacing: 12) {
                    RepAvatar(size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.repName ?? "A \(store.brand.name) rep").font(.headline).foregroundStyle(Theme.ink)
                        Text("Re-measures your \(store.windowCount) window\(store.windowCount == 1 ? "" : "s") by hand").font(.subheadline).foregroundStyle(Theme.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            } header: {
                Label {
                    Text(savedLine).font(.subheadline).foregroundStyle(Theme.ink2)
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.ok)
                }
                .textCase(nil)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 6)
            }
            Section {
                tip("Open the blinds in each room if you can")
                tip("You can still add windows in the app until then")
            } header: {
                Text("Before your visit").foregroundStyle(Theme.ink2)
            }
            if typeSize.isAccessibilitySize {
                Section { WCScrollFooter() }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.insetGrouped)
        .scrollBounceBehavior(.basedOnSize)
        .wcFooter {
            WCSecondaryButton(title: "Add to Calendar", icon: .calendar) { showCalendar = true }
            if let tel = store.companyPhone.flatMap(CallbackSentScreen.telURL) {
                // The whole line is the link, so there is a full-size target to hit
                Link(destination: tel) {
                    Text(callLine)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, minHeight: Theme.minTap)
                        .contentShape(Rectangle())
                }
            } else {
                Text("Need another time? Contact \(store.brand.name).").foregroundStyle(Theme.ink2)
                    .font(.footnote)
                    .frame(minHeight: Theme.minTap)
            }
        }
        .hiNav(title: "Your visit is booked", display: .large, showsBack: false) {
            NavTextButton(title: "My order") { store.showStatus() }
        }
        .sheet(isPresented: $showCalendar) {
            if let s = start {
                CalendarEventSheet(title: "\(store.brand.name) visit", location: store.address, start: s, end: store.visitEnd ?? s.addingTimeInterval(1800), notes: "A rep re-measures your windows by hand.")
                    .ignoresSafeArea()
            }
        }
    }

    /// "Need another time? Call us." (the second sentence is the link's accent)
    private var callLine: AttributedString {
        var question = AttributedString("Need another time? ")
        question.foregroundColor = Theme.ink2
        var call = AttributedString("Call us.")
        call.foregroundColor = Theme.red
        return question + call
    }

    private var savedLine: String {
        guard let key = store.progress.tierKey, let total = store.progress.tierTotal else { return "Your quote is saved." }
        let label = store.quote?.tier(key)?.label ?? key.capitalized
        let count = store.progress.tierWindowCount ?? store.windowCount
        return "Your quote is saved: \(label), \(count) window\(count == 1 ? "" : "s"), \(Money.dollars(total))."
    }

    private func tip(_ text: String) -> some View {
        Label {
            Text(text).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "checkmark.circle").foregroundStyle(Theme.okText)
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
            Text(month).font(.caption.weight(.bold)).foregroundStyle(.white).frame(maxWidth: .infinity).padding(.vertical, 2).background(Theme.buttonFill)
            Text(day).font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.ink).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 54, height: 54)
        .background(Color(.systemBackground))
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
