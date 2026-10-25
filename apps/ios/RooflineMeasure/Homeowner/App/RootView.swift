import SwiftUI

/// The whole app: a navigation stack over the welcome (or a state of the whole app), the measuring covers, a notice banner.
struct RootView: View {
    @Environment(HomeownerStore.self) private var store
    @State private var started = false

    var body: some View {
        @Bindable var store = store
        NavigationStack(path: $store.path) {
            RootContent()
                .navigationDestination(for: Route.self) { route in
                    RouteScreen(route: route)
                }
        }
        .overlay(alignment: .top) { NoticeBanner() }
        .fullScreenCover(item: $store.measureSession) { session in
            MeasureHost(session: session)
                .environment(store)
        }
        .task {
            guard !started else { return }
            started = true
            await store.launch()
        }
    }
}

/// What sits at the bottom of the stack.
private struct RootContent: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        switch store.root {
        case .launching: LaunchScreen()
        case .welcome: WelcomeScreen()
        case .callbackSent: CallbackSentScreen()
        case .booked: BookedScreen()
        case .status: StatusScreen()
        }
    }
}

/// The screens pushed on the stack.
private struct RouteScreen: View {
    let route: Route

    var body: some View {
        switch route {
        case .step(let step):
            switch step {
            case .welcome: WelcomeScreen()
            case .service: ServiceScreen()
            case .address: AddressScreen()
            case .results: ResultsScreen()
            case .callback: CallbackScreen()
            case .callbackSent: CallbackSentScreen()
            case .coaching: CoachingScreen()
            case .rooms: RoomsScreen()
            case .list: ListScreen()
            case .styles: StylesScreen()
            case .quote: QuoteScreen()
            case .contact: ContactScreen()
            case .book: BookScreen()
            case .booked: BookedScreen()
            case .status: StatusScreen()
            }
        case .method(let room):
            MethodScreen(room: room)
        }
    }
}

/// Shown for a moment while the saved request is opened: the plain system background and the wordmark, so nothing flashes.
struct LaunchScreen: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            VStack(spacing: 18) {
                Text(store.brand.wordmark).wcWordmark(.title).foregroundStyle(.primary)
                ProgressView()
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Opening WinChoice")
    }
}

/// A transient message over the top of any screen (a failed call, a window that could not be sent): a material banner.
struct NoticeBanner: View {
    @Environment(HomeownerStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let notice = store.notice {
            HStack(alignment: .top, spacing: 10) {
                IconView(icon: notice.kind == .error ? .alert : .info, size: 18).foregroundStyle(notice.kind == .error ? Theme.bad : Theme.ink2).padding(.top, 12)
                Text(notice.text).font(.subheadline).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true).padding(.vertical, 12)
                Spacer(minLength: 0)
                Button { store.dismissNotice() } label: {
                    Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink2).frame(width: Theme.minTap, height: Theme.minTap)
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.leading, 14)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 8)
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            .task(id: notice.id) {
                // VoiceOver says it when it appears (an error that only shows is missed)
                AccessibilityNotification.Announcement(notice.text).post()
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                if store.notice?.id == notice.id { store.dismissNotice() }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isStaticText)
        }
    }
}

struct PlaceholderScreen: View {
    let name: String

    var body: some View {
        Text(name).font(.title3.weight(.semibold)).frame(maxWidth: .infinity, maxHeight: .infinity).wcScreenChrome()
    }
}
