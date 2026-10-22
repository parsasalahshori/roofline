import Foundation
import Network
import Observation
import RooflineCore
import SwiftUI

/// A screen pushed on the navigation stack: one of the journey's steps, or the method screen of one room.
enum Route: Hashable {
    case step(HomeownerStep)
    case method(room: String)
}

/// The screen at the bottom of the stack: the welcome, or a state of the whole app (booked, My order, call-back sent).
enum RootScreen: Equatable {
    case launching
    case welcome
    case callbackSent
    case booked
    case status
}

/// How a window gets measured (screen 06).
enum MeasureMethod: String, CaseIterable, Identifiable {
    case corners, roomScan, card
    var id: String { rawValue }
}

/// A message to the homeowner that is not a screen: a failed call, a window that could not be sent.
struct Notice: Identifiable, Equatable {
    enum Kind { case error, info }
    let id = UUID()
    var text: String
    var kind: Kind = .error
}

/// The measuring screen that is open (a full-screen cover over the method screen).
struct MeasureSession: Identifiable, Equatable {
    let id = UUID()
    var method: MeasureMethod
    var room: String
    /// This window's number across the whole request ("window 4").
    var number: Int
    /// Replace this window (the homeowner chose "measure again").
    var replacing: String?
}

/// One measured window waiting for its room and name (screen 08), with the photo and the phone's own size for it.
struct PendingWindow: Identifiable {
    let id: String
    var scale: WindowPhotoScale
    var corners: [Vec2]?
    var jpeg: Data?
    var imageWidthPx: Int
    var imageHeightPx: Int
    var preview: WindowPreview?
    var room: String
    var name = ""
    var number: Int
    var replacing: String?
    /// The photo's 35 mm-equivalent focal length (a card photo is sized with it), kept so a restored window shows the same size.
    var focal35mm: Double? = nil
    var method: MeasureMethod = .corners
}

/// Everything the homeowner screens read and do. One instance for the app; the screens never talk to the network.
@MainActor
@Observable
final class HomeownerStore {
    // MARK: Dependencies

    let brand: Brand
    let api: HomeownerAPI
    @ObservationIgnored let vault: SessionVault
    @ObservationIgnored let progressStore: ProgressStore
    @ObservationIgnored let outbox: Outbox
    @ObservationIgnored let pendingDisk: PendingDisk
    @ObservationIgnored let holder = SessionHolder()
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored var now: () -> Date = { Date() }

    var capabilities: MeasureCapabilities

    // MARK: What the server said

    var company: HomeownerCompany
    /// False until GET /company has answered (the brand's own words stand in).
    var companyLoaded = false
    var session: HomeownerSession?
    var view: HomeownerRequestView?
    var home: HomeownerHome?
    var estimate: HomeownerEstimate?
    var callbackReason: String?
    var requestStatus: HomeownerRequestStatus = .ready
    var progress = HomeownerProgress()
    var outboxItems: [OutboxItem] = []
    var slots: HomeownerSlots?
    var status: HomeownerStatus?
    /// The server could not be reached the last time we asked: what is shown comes from this phone.
    var offline = false

    // MARK: Journey

    var root: RootScreen = .launching
    var path: [Route] = []
    /// Nothing is picked until the homeowner taps a card: a pre-ticked card meant a tap on "Windows" unticked it.
    var selectedServices: Set<HomeownerService> = []
    var addressText = ""
    var addressPlace: AddressPlace?
    var contactDraft = HomeownerContact()
    var contactErrors: [ContactField: String] = [:]
    var notice: Notice?
    /// Busy flags, one per action, so a button shows its own spinner.
    var creating = false
    var sendingContact = false
    var booking = false
    var loadingSlots = false
    var loadingQuote = false
    var addressError: String?
    var bookError: String?
    var contactError: String?

    // Measuring
    var method: MeasureMethod = .corners
    var measureSession: MeasureSession?
    var pending: PendingWindow?
    /// The pending window came back from disk after the app was closed: the camera screen is not started behind its sheet.
    var pendingRestored = false
    /// The window saved a moment ago: its row is shown highlighted on the list.
    var justSavedId: String?
    /// "Measure again" on this window: the old one stays until the new one is saved.
    var replaceTarget: String?
    /// The style pass (screen 09): which window it is on.
    var styleIndex = 0

    /// Screen 11: the tier the homeowner is looking at.
    var selectedTier = "better"
    /// The last visit slot picked on screen 13.
    var pickedSlot: HomeownerSlot?
    var bestTime: String?

    // MARK: Init

    init(api: HomeownerAPI, vault: SessionVault, progressStore: ProgressStore, outboxDirectory: URL, brand: Brand = .current,
         capabilities: MeasureCapabilities, transportOverride: OutboxTransport? = nil) {
        self.api = api
        self.vault = vault
        self.progressStore = progressStore
        self.brand = brand
        self.capabilities = capabilities
        self.company = HomeownerStore.brandCompany(brand)
        // The transport hands every window answer to the store; the store does not exist yet, so a sink stands between
        let sink = ViewSink()
        let transport = transportOverride ?? HomeownerOutboxTransport(
            api: api,
            session: { [vault, holder] id in
                if let s = holder.session(for: id) { return s }
                guard let s = vault.load(), s.requestId == id else { return nil }
                return s
            },
            onView: { sink.deliver($0) }
        )
        self.outbox = Outbox(directory: outboxDirectory, transport: transport)
        self.pendingDisk = PendingDisk(outboxDirectory: outboxDirectory)
        sink.store = self
    }

    /// The company as the brand file describes it, until the server answers.
    static func brandCompany(_ brand: Brand) -> HomeownerCompany {
        HomeownerCompany(name: brand.name, brandColor: brand.colors.red, phone: nil, services: HomeownerService.allCases, booking: true,
                         windowStyles: HomeownerStyleOption.plain)
    }

    /// The labels the server gives the nine styles (an older server).
    static func styleLabel(_ key: String) -> String {
        switch key {
        case "double-hung": return "Double-hung"
        case "single-hung": return "Single-hung"
        case "slider-2": return "Slider, 2 panes"
        case "slider-3": return "Slider, 3 panes"
        case "picture": return "Picture (does not open)"
        case "casement": return "Casement (cranks open)"
        case "awning": return "Awning (tilts out)"
        case "arch": return "Arch top"
        case "circle": return "Round"
        default: return key.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    // MARK: Derived

    var requestId: String? { session?.requestId }
    var hasRequest: Bool { session != nil }

    /// The services of the request in hand (or of the welcome's picks before one exists).
    var services: Set<HomeownerService> {
        if let s = session, !s.services.isEmpty { return Set(s.services) }
        return selectedServices
    }

    var windowRows: [WindowRow] {
        WindowRows.merge(server: view?.windows ?? [], outbox: outboxItems.filter { $0.measurementId == requestId }).map { row in
            // A style chosen while the window's send was uncertain shows at once
            guard let key = progress.pendingStyles[row.id] else { return row }
            var r = row
            r.style = key
            return r
        }
    }

    var windowCount: Int { windowRows.count }
    var unstyledCount: Int { windowRows.filter { $0.style == nil }.count }
    var needsCheckCount: Int { windowRows.filter { $0.flagged }.count }
    var unsentCount: Int { outboxItems.filter { $0.measurementId == requestId && $0.state != .done }.count }
    /// Windows actually on their way: not done, not refused, and not held back for a style the homeowner has yet to pick (those
    /// wait on the person, not on the network).
    var sendingCount: Int { outboxItems.filter { $0.measurementId == requestId && $0.state != .done && $0.state != .failed && !$0.isHeld }.count }
    /// Windows kept on the phone until a style is picked (they wait on the person, not the network).
    var heldCount: Int { outboxItems.filter { $0.measurementId == requestId && $0.state != .done && $0.isHeld }.count }
    var failedItems: [OutboxItem] { outboxItems.filter { $0.measurementId == requestId && $0.state == .failed } }
    /// The server's own sentence when it told the phone to wait before sending again (429 with Retry-After), else nil.
    var heldBackNote: String? {
        outboxItems.first { $0.measurementId == requestId && $0.state == .waiting && ($0.retryNotBefore ?? .distantPast) > Date() }?.lastError
    }

    /// The company's window styles as the screens list them (the company's own, else the nine known).
    var styles: [HomeownerStyleOption] {
        company.windowStyles.isEmpty ? Self.brandCompany(brand).windowStyles : company.windowStyles
    }

    var rooms: [String] { progress.rooms }
    var features: HomeownerFeatures { api.features }
    var hasContact: Bool { view?.request.contacted ?? progress.hasContact }
    var hasBooking: Bool { view?.booking != nil || progress.hasBooking }
    var windowEstimate: HomeownerWindowEstimate? { estimate?.windows ?? view?.request.estimate?.windows }
    var roofEstimate: HomeownerRoofEstimate? { estimate?.roof ?? view?.request.estimate?.roof }
    /// The sentence shown in place of the roof price when the satellite pictures cannot be trusted, else nil.
    var roofNote: HomeownerRoofNote? { estimate?.roofNote ?? view?.request.estimate?.roofNote }
    var quote: HomeownerQuote? { view?.quote }
    var nextWindowNumber: Int { windowCount + 1 }

    var address: String { session?.address ?? view?.request.address ?? home?.address ?? addressText }

    var companyPhone: String? { company.phone }

    var timeZone: TimeZone { VisitTimes.zone(slots?.timeZone ?? view?.booking?.timeZone ?? status?.timeZone) }

    #if DEBUG
    /// DEBUG launch arguments: seeds the fake server, then the store opens `debugStep` instead of resuming.
    @ObservationIgnored var debugPlan: ((HomeownerStore) async -> Void)?
    @ObservationIgnored var debugStep: HomeownerStep?
    @ObservationIgnored var debugRoute: Route?
    /// `-debugOpen`: a measuring screen to open over the scenario's screen.
    @ObservationIgnored var debugOpen: String?
    @ObservationIgnored var debugCardSeed: DebugCardSeed?
    /// `-debugServer ... -debugE2E`: run after the app has opened (the scripted journey).
    @ObservationIgnored var debugAfterLaunch: ((HomeownerStore) async -> Void)?
    /// `-debugGo <step>`: where to show the saved request.
    @ObservationIgnored var debugGo: HomeownerStep?
    #endif

    // MARK: Start

    /// The app's first moments: open the saved request, then (DEBUG) the screen a launch argument asked for.
    func launch() async {
        #if DEBUG
        if let plan = debugPlan { await plan(self) }
        #endif
        await bootstrap()
        #if DEBUG
        if let step = debugStep {
            go(to: step)
            if let route = debugRoute { path.append(route) }
            if step == .status || step == .booked { await loadStatus() }
            if step == .book { await loadSlots() }
        }
        if let step = debugGo, session != nil {
            go(to: step)
            if step == .status || step == .booked { await loadStatus() }
            if step == .book { await loadSlots() }
        }
        if let open = debugOpen { openDebug(open) }
        if let after = debugAfterLaunch { await after(self) }
        #endif
    }

    /// Opens the app: the saved request (if any), the company, where to resume.
    func bootstrap() async {
        await startOutbox()
        startMonitor()
        // A reinstalled app finds the old Keychain item (the Keychain outlives the app): it starts fresh
        let defaults = UserDefaults.standard
        if !defaults.bool(forKey: "winchoice.installed") {
            vault.clear()
            defaults.set(true, forKey: "winchoice.installed")
        }
        async let loadedCompany: Void = loadCompany()
        if let saved = vault.load() {
            if saved.isExpired(now: now()) {
                forgetRequest(message: "Your saved request ran out after 60 days. Start a new one when you're ready.", keepWindows: true)
            } else {
                setSession(saved)
                services(from: saved)
                progress = progressStore.load(requestId: saved.requestId)
                if let last = progress.lastMethod.flatMap(MeasureMethod.init(rawValue:)), isAvailable(last) { method = last }
                addressText = saved.address
                await refresh()
                if session != nil { await resume() }
                restorePending()
            }
        }
        _ = await loadedCompany
        if root == .launching { root = .welcome }
    }

    /// The request in use: shown by the screens and readable by the outbox from any thread.
    func setSession(_ s: HomeownerSession?) {
        session = s
        holder.set(s)
    }

    private func services(from s: HomeownerSession) {
        selectedServices = Set(s.services)
    }

    func loadCompany() async {
        do {
            company = try await api.company()
            companyLoaded = true
        } catch {
            // The brand's own words stand in; the next screen that needs the company asks again
            companyLoaded = false
        }
    }

    /// GET /requests/:id: what the server has now. A token it no longer accepts ends the saved request.
    func refresh() async {
        guard let s = session else { return }
        do {
            let v = try await api.view(s)
            offline = false
            accept(v)
        } catch let e as HomeownerAPIError {
            if e.isUnauthorized || e.isGone {
                forgetRequest(message: e.isTokenExpired ? "Your saved request ran out after 60 days. Start a new one when you're ready." : "We couldn't find your saved request. Start a new one when you're ready.", keepWindows: true)
            } else if e.isNetwork {
                offline = true
            } else {
                notice = Notice(text: e.message)
            }
        } catch {
            offline = true
        }
    }

    /// Takes a fresh view (from any call) and keeps the facts the resume router needs.
    func accept(_ v: HomeownerRequestView) {
        view = v
        offline = false
        if let h = v.request.home { home = h }
        if let e = v.request.estimate { estimate = e }
        if let s = v.request.status { requestStatus = s }
        if let r = v.request.callbackReason { callbackReason = r }
        // The rooms the server has seen join the homeowner's list
        for room in v.rooms where !progress.rooms.contains(where: { $0.caseInsensitiveCompare(room) == .orderedSame }) { progress.rooms.append(room) }
        for w in v.windows where !w.room.isEmpty && !progress.rooms.contains(where: { $0.caseInsensitiveCompare(w.room) == .orderedSame }) { progress.rooms.append(w.room) }
        if let b = v.booking { progress.hasBooking = b.isVisit || b.callMe }
        progress.hasContact = v.request.contacted
        progress.windowCount = v.windows.count
        progress.requestStatus = v.request.status ?? requestStatus
        if let st = v.status { status = st }
        saveProgress()
    }

    func saveProgress() {
        guard let id = requestId else { return }
        progress.requestStatus = requestStatus
        progress.callbackReason = callbackReason
        progress.estimateWindows = windowEstimate
        progress.estimateRoof = roofEstimate
        progress.estimateRoofNote = roofNote
        progress.floors = home?.floors
        progressStore.save(progress, requestId: id)
    }

    // MARK: Resume

    private func snapshot() -> ResumeSnapshot {
        ResumeSnapshot(
            requestStatus: view?.request.status ?? progress.requestStatus,
            services: services,
            windowCount: max(windowCount, offline ? progress.windowCount : 0),
            unstyledCount: unstyledCount,
            hasBooking: hasBooking,
            hasContact: hasContact
        )
    }

    /// Where a returning homeowner lands: the last screen they were on, if what it needs is there.
    func resume() async {
        let target = ResumeRouter.target(saved: progress.step, hasSession: session != nil, snapshot: snapshot())
        go(to: target)
        if target == .status || target == .booked { Task { await self.loadStatus() } }
        if let h = progress.estimateWindows, estimate?.windows == nil { estimate = HomeownerEstimate(windows: h, roof: progress.estimateRoof, roofNote: progress.estimateRoofNote) }
    }

    /// Shows a step as if the homeowner had walked there: the back stack is the steps before it.
    func go(to step: HomeownerStep) {
        switch step {
        case .welcome:
            root = .welcome
            path = []
        case .callbackSent:
            root = .callbackSent
            path = []
        case .booked:
            root = .booked
            path = []
        case .status:
            root = .status
            path = []
        default:
            root = .welcome
            path = stack(to: step)
        }
        progress.step = step
        saveProgress()
    }

    /// The routes that lead to `step`. After a booking the root is My order and the stack starts at the rooms.
    func stack(to step: HomeownerStep) -> [Route] {
        var steps = HomeownerFlow.path(to: step, services: services)
        if root != .welcome, root != .launching { steps = Array(steps.drop { $0 != .rooms }) }
        return steps.map { Route.step($0) }
    }

    func push(_ step: HomeownerStep) {
        path.append(.step(step))
        noteStep(step)
    }

    func noteStep(_ step: HomeownerStep) {
        progress.step = step
        saveProgress()
    }

    func pop() {
        guard !path.isEmpty else { return }
        replaceTarget = nil
        path.removeLast()
        if case .step(let s)? = path.last { noteStep(s) } else if path.isEmpty { noteStep(.welcome) }
    }

    /// After a window is saved or removed: the list, with the rooms screen behind it.
    func showList() {
        measureSession = nil
        pending = nil
        path = stack(to: .list)
        noteStep(.list)
    }

    func startOver() {
        forgetRequest(message: nil)
        root = .welcome
        path = []
    }

    /// Drops the saved request (the Keychain item, the progress). The homeowner starting over drops the windows on this phone
    /// too; a request the server no longer knows (`keepWindows`) never takes measured windows with it: they stay, and move to the
    /// new request when the address is confirmed again.
    func forgetRequest(message: String?, keepWindows: Bool = false) {
        let id = session?.requestId
        let oldAddress = session?.address
        let kept = keepWindows && id.map { id in outboxItems.contains { $0.measurementId == id } || pendingDisk.load(requestId: id) != nil } == true
        vault.clear()
        if let id = id {
            if !kept { pendingDisk.clear(requestId: id) }
            progressStore.clear(requestId: id)
            if !kept { Task { try? await outbox.removeAll(measurementId: id) } }
        }
        setSession(nil)
        view = nil
        home = nil
        estimate = nil
        callbackReason = nil
        requestStatus = .ready
        progress = HomeownerProgress()
        status = nil
        slots = nil
        pending = nil
        pendingRestored = false
        replaceTarget = nil
        justSavedId = nil
        measureSession = nil
        contactDraft = HomeownerContact()
        contactErrors = [:]
        pickedSlot = nil
        styleIndex = 0
        selectedTier = "better"
        addressText = kept ? (oldAddress ?? "") : ""
        addressPlace = nil
        path = []
        root = .welcome
        if kept {
            notice = Notice(text: "Your measured windows are still on this phone. Confirm your address again and they go with your new request.", kind: .info)
        } else if let m = message {
            notice = Notice(text: m, kind: .info)
        }
    }

    // MARK: Outbox

    private func startOutbox() async {
        try? await outbox.load()
        await outbox.setObserver { [weak self] items in Task { @MainActor in self?.outboxChanged(items) } }
        await outbox.syncAll()
        scheduleRetryIfNeeded()
    }

    func outboxChanged(_ items: [OutboxItem]) {
        outboxItems = items
        scheduleRetryIfNeeded()
    }

    /// Sends what can be sent, then asks the server how that changed the quote.
    func syncWindows() async {
        await outbox.syncAll()
        if unsentCount == 0 || session != nil { await refresh() }
        if !progress.pendingStyles.isEmpty { await applyPendingStyles() }
        scheduleRetryIfNeeded()
    }

    private func scheduleRetryIfNeeded() {
        retryTask?.cancel()
        let waiting = outboxItems.filter { $0.measurementId == requestId && $0.state == .waiting && !$0.isHeld }
        guard !waiting.isEmpty else { return }
        // Every 15 seconds; when the server said to wait longer (Retry-After) for all of them, not before then
        let now = Date()
        let earliest = waiting.map { $0.retryNotBefore ?? now }.min() ?? now
        let delay = max(15, earliest.timeIntervalSince(now))
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.syncWindows()
        }
    }

    private func startMonitor() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in
                guard let self = self, self.session != nil else { return }
                if self.offline || self.unsentCount > 0 { await self.syncWindows() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "winchoice.network"))
    }

    func appBecameActive() {
        guard session != nil else { return }
        Task { await self.syncWindows() }
    }

    func retry(_ windowId: String) {
        Task {
            try? await outbox.retry(id: windowId)
            await syncWindows()
        }
    }

    func dismissNotice() { notice = nil }
}

/// Carries a window answer from the outbox's transport (any thread) to the store (the main actor).
final class ViewSink: @unchecked Sendable {
    weak var store: HomeownerStore?

    func deliver(_ view: HomeownerRequestView) {
        Task { @MainActor [weak self] in self?.store?.accept(view) }
    }
}
