import CoreGraphics

/// Where the magnifier sits. It starts at the top left, under the status card; when a placed corner (or the outline the phone found) is
/// under it, it moves to the top right, then to the top middle (a window whose two top corners are on both sides leaves the middle free),
/// so it never hides a corner the person is looking at.
enum LoupePlacement {
    enum Side: Equatable { case leading, trailing, center }

    /// The magnifier's picture and its "4× magnifier" label.
    static let size = CGSize(width: 134, height: 172)
    static let inset: CGFloat = 16
    /// Room kept round the magnifier: a corner dot is 22 points across.
    static let margin: CGFloat = 20
    /// The gap between the status card and the magnifier.
    static let gap: CGFloat = 14

    /// In the middle the magnifier sits a little lower, below the width plate that is centred on the top side of the window.
    static let centerDrop: CGFloat = 48

    /// The magnifier's box (with its margin) for a side.
    static func box(_ side: Side, topBarBottom: CGFloat, screenWidth: CGFloat) -> CGRect {
        let x: CGFloat
        var y = topBarBottom + gap
        switch side {
        case .leading: x = inset
        case .trailing: x = screenWidth - inset - size.width
        case .center:
            x = (screenWidth - size.width) / 2
            y += centerDrop
        }
        return CGRect(x: x, y: y, width: size.width, height: size.height).insetBy(dx: -margin, dy: -margin)
    }

    /// `points`: the corners on screen (placed dots, or the outline's). `topBarBottom`: where the status card ends. `screenWidth`: the
    /// screen's width. The first side with no corner under it (leading, trailing, then the middle); with a corner under every one, the
    /// side with the fewest (leading on a tie).
    static func side(avoiding points: [CGPoint], topBarBottom: CGFloat, screenWidth: CGFloat) -> Side {
        let sides: [Side] = [.leading, .trailing, .center]
        let under = sides.map { s in points.filter { box(s, topBarBottom: topBarBottom, screenWidth: screenWidth).contains($0) }.count }
        guard let fewest = under.min() else { return .leading }
        return sides[under.firstIndex(of: fewest) ?? 0]
    }
}
