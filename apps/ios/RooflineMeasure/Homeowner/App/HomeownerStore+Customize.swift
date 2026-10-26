import Foundation
import RooflineCore

// "Customize your windows": after the estimate, the homeowner walks through their windows one by one in the visualizer (type, grid,
// color, glass). Each choice is kept on the phone as they go; at the end the styles go to the server (the price follows from them),
// and each window's look goes to the CRM (PATCH .../windows/:id/look) so the company sees what the homeowner chose.

extension HomeownerStore {
    /// "Customize your windows": the visualizer on the first window, then the others one after another.
    func startCustomizing() {
        let ids = windowRows.map { $0.id }
        guard let first = ids.first else { return }
        customizeIds = ids
        selectTier(selectedTier)
        openVisualizer(first, from: .customize)
    }

    /// "Window 2 of 5": this window's place in the walk, nil when it is not part of one.
    func customizePlace(of windowId: String) -> (number: Int, count: Int)? {
        guard let i = customizeIds.firstIndex(of: windowId) else { return nil }
        return (i + 1, customizeIds.count)
    }

    /// Keeps a window's choice on the phone (nothing goes to the server yet).
    func keepLook(_ look: WindowVisualLook, colorKey: String, for windowId: String) {
        progress.visuals[windowId] = look
        progress.colors[windowId] = colorKey
        saveProgress()
    }

    /// "Next": keeps this window's choice and shows the next window, or finishes after the last.
    func customizeNext(after windowId: String, look: WindowVisualLook, colorKey: String) async {
        keepLook(look, colorKey: colorKey, for: windowId)
        if let i = customizeIds.firstIndex(of: windowId), i + 1 < customizeIds.count {
            path.append(.visualize(windowId: customizeIds[i + 1], from: .customize))
        } else {
            await finishCustomizing()
        }
    }

    /// "Use for all windows": the same choice for every window, then the end of the walk.
    func customizeAll(look: WindowVisualLook, colorKey: String) async {
        for id in customizeIds { keepLook(look, colorKey: colorKey, for: id) }
        await finishCustomizing()
    }

    /// The end of the walk: every window gets the style its kind is quoted under (the price follows), the looks go to the CRM, and the
    /// ready screen shows the result. A window that does not change needs nothing sent.
    func finishCustomizing() async {
        applyingLooks = true
        defer { applyingLooks = false }
        for id in customizeIds {
            guard let look = progress.visuals[id] else { continue }
            await setStyle(styleMapping(for: look.type).key, for: id)
        }
        await prepareQuote()
        _ = await sendLooks()
        customizeIds = []
        path = stack(to: .ready)
        noteStep(.ready)
        Haptics.success()
    }

    // MARK: To the CRM

    /// What this window's look is, as the server takes it: the kind, grid and glass chosen, and the frame colour's key.
    func lookBody(for windowId: String) -> HomeownerWindowLookBody? {
        guard let look = progress.visuals[windowId] else { return nil }
        return HomeownerWindowLookBody(look: look, colorKey: progress.colors[windowId] ?? brand.windowColors.first?.key ?? "white")
    }

    /// Sends every chosen look the server does not have yet (the phone keeps what was sent, so a look is sent once, and again only when it
    /// changes or an earlier try failed). Returns false when the phone could not reach the server, so the caller can try again later.
    @discardableResult
    func sendLooks() async -> Bool {
        guard let s = session else { return true }
        var reached = true
        for window in view?.windows ?? [] {
            guard let body = lookBody(for: window.id), progress.looksSent[window.id] != body else { continue }
            do {
                accept(try await api.setLook(s, windowId: window.id, look: body))
                progress.looksSent[window.id] = body
            } catch let e as HomeownerAPIError where (e.status ?? 500) < 500 && e.status != 429 {
                // The server answered and said no (an older server without the route, a window it no longer has): not a reason to hold anything back
                continue
            } catch {
                reached = false
            }
        }
        saveProgress()
        return reached
    }

    /// "Get my estimate" on the ready screen (and "Skip and get my estimate" on the estimate): the interest form.
    func requestCallFromEstimate() {
        selectTier(selectedTier)
        push(.contact)
    }
}
