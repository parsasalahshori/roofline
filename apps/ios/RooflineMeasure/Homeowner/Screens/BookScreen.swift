import RooflineCore
import SwiftUI

/// 13 Confirmation visit (ios-hw-13): "Lock in your sizes". Three plain points, the open days and times (in the company's
/// time zone), the rep when the server names one, and the choice: book this time, or "Call me to pick a time".
/// The times are a native grouped list: one section per open day (the day as its header), one row per time with a checkmark on
/// the one picked. (The open days are not a run of dates, so a `DatePicker` does not fit them.)
struct BookScreen: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize

    private var days: [VisitTimes.Day] { store.visitDays }
    private var zone: TimeZone { store.timeZone }
    private var hasTimes: Bool { !days.isEmpty }

    var body: some View {
        List {
            Section {
                point("ruler", bold: "A rep re-measures every window", rest: " by hand, about 30 minutes.")
                point("tag", bold: "Your price stays the same", rest: " unless a size changes, and you see why.")
                point("window.vertical.closed", bold: "Then we build your windows", rest: " and text you each step.")
            } header: {
                HiListHeading(title: "Lock in your sizes")
            }
            if store.loadingSlots && !hasTimes {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Finding open times…").font(.subheadline).foregroundStyle(Theme.ink2)
                    }
                }
            } else if hasTimes {
                if let rep = store.slots?.rep { Section { repRow(rep) } }
                ForEach(days) { day in
                    Section {
                        ForEach(day.slots) { slot in timeRow(slot, day: day) }
                    } header: {
                        Text("\(VisitTimes.weekdayLong(day.date, zone)), \(VisitTimes.monthDay(day.date, zone))").foregroundStyle(Theme.ink2)
                    }
                }
            } else {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(store.company.booking ? "No open times right now." : "Visit times are set by phone.").font(.headline).foregroundStyle(Theme.ink)
                            Text("Ask us to call you and we'll find a time that works.").font(.subheadline).foregroundStyle(Theme.ink2)
                        }
                    } icon: {
                        Image(systemName: WCIcon.calendar.symbol).foregroundStyle(Theme.ink2)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if let e = store.bookError {
                Section {
                    Label {
                        Text(e).font(.subheadline).foregroundStyle(Theme.ink)
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
            if hasTimes, let slot = store.pickedSlot, let start = VisitTimes.parse(slot.start) {
                WCPrimaryButton(title: VisitTimes.bookButton(start, zone), isLoading: store.booking) { Task { await store.bookPicked() } }
                WCSecondaryButton(title: "Call me to pick a time", isEnabled: !store.booking) { Task { await store.askForCall() } }
            } else {
                WCPrimaryButton(title: "Call me to pick a time", isLoading: store.booking) { Task { await store.askForCall() } }
            }
        }
        .hiNav(title: "Confirmation visit")
        .task {
            if store.slots == nil { await store.loadSlots() }
        }
    }

    private func point(_ symbol: String, bold: String, rest: String) -> some View {
        var text = AttributedString(bold)
        text.inlinePresentationIntent = .stronglyEmphasized
        text.foregroundColor = Theme.ink
        var tail = AttributedString(rest)
        tail.foregroundColor = Theme.ink2
        text += tail
        return Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol).foregroundStyle(Theme.ink2)
        }
        .accessibilityElement(children: .combine)
    }

    /// One open time: the clock time and a checkmark when it is the one picked.
    private func timeRow(_ slot: HomeownerSlot, day: VisitTimes.Day) -> some View {
        let on = store.pickedSlot?.start == slot.start
        let start = VisitTimes.parse(slot.start)
        let words = start.map { VisitTimes.clockWithPeriod($0, zone) } ?? slot.start
        return Button {
            store.pickedSlot = slot
            Haptics.tap()
        } label: {
            HStack {
                Text(words).font(.body).monospacedDigit().foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Theme.red).opacity(on ? 1 : 0).accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(VisitTimes.weekdayLong(day.date, zone)), \(VisitTimes.monthDay(day.date, zone)), \(words)")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    private func repRow(_ rep: HomeownerRep) -> some View {
        HStack(spacing: 12) {
            RepAvatar(size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(rep.name).font(.headline).foregroundStyle(Theme.ink)
                Text(rep.area.map { "Your \($0) rep · texts you the day before" } ?? "Your rep · texts you the day before")
                    .font(.subheadline).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
