import Foundation
import RooflineCore

extension HomeownerStore {
    /// Saves the windows of the room-scan hybrid, all in one room, through the same paths as every other measured window: each window into the
    /// outbox (held for its style), and, for a window that was measured further, its scan (photos, marks, answer) into the scan outbox, armed once
    /// the window is saved. A window nobody measured further is just Apple's size, as the room scan has always saved it.
    func saveRoomHybrid(_ list: [HybridSaveItem], room: String) async {
        guard let s = session else { return }
        let cleanRoom = RoomNames.clean(room) ?? room
        var saved = 0
        for w in list {
            let input = PhotoWindowInput(id: w.windowId, uploadId: nil, label: Self.cleanLabel(w.name, max: company.limits.maxLabelLength), windowKey: nil,
                                         corners: w.corners, scale: w.scale, room: cleanRoom, style: nil)
            do {
                _ = try await outbox.enqueue(window: input, measurementId: s.requestId, address: s.address, jpeg: w.jpeg, imageWidthPx: w.widthPx, imageHeightPx: w.heightPx, held: true)
            } catch {
                notice = Notice(text: "This phone couldn't save a window (\(error.localizedDescription)).")
                continue
            }
            saved += 1
            // The window's own frame stays on this phone, by the window's id (the server has no place for it)
            if let frame = w.windowFrame { progress.windowFrames[w.windowId] = frame }
            if let scan = w.staged {
                do {
                    _ = try await scanOutbox.stage(draft: scan.draft, measurementId: s.requestId, jpegs: scan.jpegs, app: Self.appVersionLine, device: DeviceCaps.modelIdentifier)
                    try await scanOutbox.arm(windowId: w.windowId)
                } catch {
                    notice = Notice(text: "This phone couldn't keep the photos of a scan (\(error.localizedDescription)). The window itself is saved.")
                }
            }
        }
        saveProgress()
        _ = addRoom(cleanRoom)
        guard saved > 0 else { return }
        Haptics.success()
        showList()
        notice = Notice(text: "Added \(saved) window\(saved == 1 ? "" : "s") to \(cleanRoom)", kind: .info)
        Task { await outbox.syncAll() }
    }
}
