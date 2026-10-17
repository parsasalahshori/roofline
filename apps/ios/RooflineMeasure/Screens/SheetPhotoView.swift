#if STAFF_APP
import SwiftUI
import WebKit

/// The measuring-sheet method, without a Swift port: the web app's windows screen for this measurement
/// (/estimator/windows/:id, apps/web/src/app/router.tsx) in a web view, signed in with the app's own session cookie.
/// The web screen has no deep link into its photo flow yet, so the rep taps its "Add photos" button there; what the
/// web screen saves goes straight to the server (it does not pass through the phone's outbox).
struct SheetPhotoView: View {
    let measurementId: String
    let onDone: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ZStack {
                SheetWebView(url: pageURL, cookies: HTTPCookieStorage.shared.cookies(for: model.api.baseURL) ?? [], loading: $loading, error: $error)
                if loading { ProgressView() }
                if let error = error {
                    VStack(spacing: 12) {
                        Text(error).multilineTextAlignment(.center)
                        Button("Close") { close() }
                    }
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .padding()
                }
            }
            .navigationTitle("Sheet photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { close() } }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Tap Add photos, then follow the measuring-sheet steps.")
                    .font(.footnote)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
            }
        }
    }

    private var pageURL: URL {
        model.api.baseURL.appendingPathComponent("estimator/windows/\(measurementId)")
    }

    private func close() {
        dismiss()
        onDone()
    }
}

/// WKWebView with the app's session cookies copied into its cookie store before the page loads.
private struct SheetWebView: UIViewRepresentable {
    let url: URL
    let cookies: [HTTPCookie]
    @Binding var loading: Bool
    @Binding var error: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // The web photo screen takes photos with <input type=file capture>; inline media for its camera previews
        config.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        // The web app routes on the client (no page load): watch the address for its sign-in redirect
        context.coordinator.urlObservation = view.observe(\.url, options: [.new]) { [weak coordinator = context.coordinator] web, _ in
            DispatchQueue.main.async { coordinator?.checkSignIn(web) }
        }
        let store = config.websiteDataStore.httpCookieStore
        let group = DispatchGroup()
        for c in cookies {
            group.enter()
            store.setCookie(c) { group.leave() }
        }
        group.notify(queue: .main) {
            MainActor.assumeIsolated { _ = view.load(URLRequest(url: url)) }
        }
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: SheetWebView
        var urlObservation: NSKeyValueObservation?

        init(_ parent: SheetWebView) { self.parent = parent }

        func checkSignIn(_ webView: WKWebView) {
            // Sent to sign-in: the cookie did not carry over. The rep can sign in on the page itself and go on.
            if webView.url?.path == "/sign-in" {
                parent.error = "The web app asked to sign in: the app's session did not carry over. Close this, or sign in on the page and go on."
            } else {
                parent.error = nil
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.loading = false
            checkSignIn(webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.loading = false
            parent.error = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.loading = false
            parent.error = APIClient.networkMessage(error)
        }
    }
}
#endif
