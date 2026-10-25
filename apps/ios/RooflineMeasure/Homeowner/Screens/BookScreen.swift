import RooflineCore
import SwiftUI

/// 13 Confirmation visit (ios-hw-13): "Lock in your sizes". Three plain points, the open days and times (in the company's
/// time zone), the rep when the server names one, and the choice: book this time, or "Call me to pick a time".
struct BookScreen: View {
    @Environment(HomeownerStore.self) private var store
    @State private var dayId: String?

    private var days: [VisitTimes.Day] { store.visitDays }
    private var day: VisitTimes.Day? { days.first { $0.id == dayId } ?? days.first }
    private var zone: TimeZone { store.timeZone }
    private var hasTimes: Bool { !days.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: "Confirmation visit", onBack: { store.pop() })
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    WCHeadline(text: "Lock in your sizes")
                    VStack(alignment: .leading, spacing: 12) {
                        point(1, bold: "A rep re-measures every window", rest: " by hand, about 30 minutes.")
                        point(2, bold: "Your price stays the same", rest: " unless a size changes, and you see why.")
                        point(3, bold: "Then we build your windows", rest: " and text you each step.")
                    }
                    .padding(.top, 14)
                    if store.loadingSlots && !hasTimes {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Finding open times…").wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink2)
                        }
                        .padding(.top, 24)
                    } else if hasTimes {
                        dayStrip.padding(.top, 20)
                        timeChips.padding(.top, 10)
                        if let rep = store.slots?.rep { repCard(rep).padding(.top, 14) }
                    } else {
                        InfoPanel(icon: .calendar, lead: store.company.booking ? "No open times right now." : "Visit times are set by phone.",
                                  text: "Ask us to call you and we'll find a time that works.").padding(.top, 20)
                    }
                    if let e = store.bookError {
                        InfoPanel(icon: .alert, text: e, tint: Theme.warnTint, iconColor: Theme.warn).padding(.top, 14)
                    }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
        }
        .wcFooter {
            if hasTimes, let slot = store.pickedSlot, let start = VisitTimes.parse(slot.start) {
                WCPrimaryButton(title: VisitTimes.bookButton(start, zone), isLoading: store.booking) { Task { await store.bookPicked() } }
                WCSecondaryButton(title: "Call me to pick a time", isEnabled: !store.booking) { Task { await store.askForCall() } }
            } else {
                WCPrimaryButton(title: "Call me to pick a time", isLoading: store.booking) { Task { await store.askForCall() } }
            }
        }
        .wcScreenChrome()
        .task {
            if store.slots == nil { await store.loadSlots() }
            syncDay()
        }
        .onChange(of: store.slots) { _, _ in syncDay() }
    }

    private func syncDay() {
        if let picked = store.pickedSlot, let d = days.first(where: { $0.slots.contains(picked) }) { dayId = d.id } else { dayId = days.first?.id }
    }

    private func point(_ n: Int, bold: String, rest: String) -> some View {
        var text = AttributedString(bold)
        text.inlinePresentationIntent = .stronglyEmphasized
        text.foregroundColor = Theme.ink
        text += AttributedString(rest)
        return HStack(alignment: .top, spacing: 14) {
            Text("\(n)").wcMono(16, .bold, relativeTo: .body).foregroundStyle(Theme.blue)
                .frame(width: 34, height: 34).background(Theme.blueTint, in: Circle())
            Text(text).wc(17, relativeTo: .body).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 5)
        }
        .accessibilityElement(children: .combine)
    }

    /// The open days: up to five fill the row (as in the mockup), more scroll sideways.
    @ViewBuilder private var dayStrip: some View {
        if days.count <= 5 {
            HStack(spacing: 8) { ForEach(days) { dayButton($0, flexible: true) } }
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) { ForEach(days) { dayButton($0, flexible: false) } }
                    .padding(.horizontal, 1)
            }
        }
    }

    private func dayButton(_ d: VisitTimes.Day, flexible: Bool) -> some View {
        let on = d.id == (day?.id ?? "")
        return Button {
            dayId = d.id
            store.pickedSlot = d.slots.first
            Haptics.tap()
        } label: {
            VStack(spacing: 2) {
                Text(VisitTimes.weekdayShort(d.date, zone)).wc(15, relativeTo: .subheadline).foregroundStyle(on ? Color.white : Theme.ink3)
                Text(VisitTimes.dayNumber(d.date, zone)).wc(22, .bold, relativeTo: .title3).foregroundStyle(on ? Color.white : Theme.ink)
            }
            .frame(maxWidth: flexible ? .infinity : 66, minHeight: 64)
            .frame(width: flexible ? nil : 66)
            .background(on ? Theme.buttonFill : Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(on ? Color.clear : Theme.line2, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(VisitTimes.weekdayLong(d.date, zone)), \(VisitTimes.monthDay(d.date, zone))")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var timeChips: some View {
        HStack(spacing: 12) {
            ForEach(day?.slots ?? []) { slot in
                let on = store.pickedSlot?.start == slot.start
                let start = VisitTimes.parse(slot.start)
                Button {
                    store.pickedSlot = slot
                    Haptics.tap()
                } label: {
                    Text(start.map { VisitTimes.clock($0, zone) } ?? slot.start)
                        .wcMono(19, on ? .bold : .regular, relativeTo: .title3)
                        .foregroundStyle(on ? Theme.blue : Theme.ink)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(on ? Theme.blueTint : Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? Theme.blue : Theme.line2, lineWidth: on ? 2 : 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(start.map { VisitTimes.clockWithPeriod($0, zone) } ?? slot.start)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    private func repCard(_ rep: HomeownerRep) -> some View {
        HStack(spacing: 14) {
            RepAvatar(size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(rep.name).wc(18, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Text(rep.area.map { "Your \($0) rep · texts you the day before" } ?? "Your rep · texts you the day before")
                    .wc(15, relativeTo: .subheadline).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .wcCard(radius: 16)
        .accessibilityElement(children: .combine)
    }
}
