import RooflineCore
import SwiftUI

/// 04 Coaching (ios-hw-04): four tips for a good size, each with a small picture, and a line about the depth sensor.
struct CoachingScreen: View {
    @Environment(HomeownerStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            WCNavBar(title: "How to measure", onBack: { store.pop() }) { StepDots(filled: 2) }
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    WCHeadline(text: "Four tips for a good size").padding(.bottom, 6)
                    Tip(art: .standBack, title: "Stand 3 to 5 feet back", detail: "About 1 to 1.5 meters, facing the window straight on.")
                    Tip(art: .inside, title: "Measure from inside", detail: "Point at the inside of the frame, not the trim around it.")
                    Tip(art: .light, title: "Good light, blinds open", detail: "Daytime is best. Turn on the room lights at night.")
                    Tip(art: .corners, title: "Tap all four corners", detail: "A magnifier helps you land on each corner of the frame.")
                    if store.capabilities.methodCount > 0 {
                        InfoPanel(icon: .lidar, text: store.capabilities.depthSentence, iconColor: Theme.blue).padding(.top, 2)
                    } else {
                        InfoPanel(icon: .alert, text: "This device can't measure with a camera. Open WinChoice on your iPhone to measure your windows.", tint: Theme.warnTint, iconColor: Theme.warn).padding(.top, 2)
                    }
                    WCScrollFooter()
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.bottom, 24)
            }
        }
        .wcFooter {
            WCPrimaryButton(title: "Measure my first window") {
                store.push(.rooms)
            }
        }
        .wcScreenChrome()
    }
}

private struct Tip: View {
    enum Art { case standBack, inside, light, corners }
    let art: Art
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 14) {
            TipArt(art: art)
                .frame(width: 86, height: 66)
                .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).wc(16, .semibold, relativeTo: .headline).foregroundStyle(Theme.ink)
                Text(detail).wc(13, relativeTo: .footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .wcCard()
        .accessibilityElement(children: .combine)
    }
}

/// The four little pictures, drawn from the mockup's own SVG shapes (86 x 66 units).
private struct TipArt: View {
    let art: Tip.Art

    var body: some View {
        Canvas { ctx, size in
            let sx = size.width / 86, sy = size.height / 66
            func p(_ d: String) -> Path { SVGPath.path(d).applying(CGAffineTransform(scaleX: sx, y: sy)) }
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> Path { Path(CGRect(x: x * sx, y: y * sy, width: w * sx, height: h * sy)) }
            let ink = Theme.ink, ink2 = Theme.ink2, ink3 = Theme.ink3, tape = Theme.tape
            switch art {
            case .standBack:
                ctx.stroke(rect(58, 12, 20, 34), with: .color(ink), lineWidth: 2 * sx)
                ctx.stroke(p("M58 29h20"), with: .color(ink), lineWidth: 1.5 * sx)
                ctx.fill(Path(ellipseIn: CGRect(x: 11 * sx, y: 17 * sy, width: 10 * sx, height: 10 * sy)), with: .color(ink2))
                ctx.stroke(p("M16 27v16M10 56l6-13 6 13"), with: .color(ink2), lineWidth: 2 * sx)
                ctx.stroke(p("M26 54h28M26 50v8M54 50v8"), with: .color(tape), lineWidth: 2 * sx)
            case .inside:
                ctx.stroke(rect(10, 8, 66, 50), with: .color(ink3), lineWidth: 1.5 * sx)
                let pane = rect(28, 16, 30, 30)
                ctx.fill(pane, with: .color(Theme.blueTint))
                ctx.stroke(pane, with: .color(ink), lineWidth: 2 * sx)
                ctx.stroke(p("M10 58l-4 6M76 58l4 6"), with: .color(ink3), lineWidth: 1.5 * sx)
            case .light:
                ctx.stroke(Path(ellipseIn: CGRect(x: 33 * sx, y: 20 * sy, width: 20 * sx, height: 20 * sy)), with: .color(tape), lineWidth: 2.5 * sx)
                ctx.stroke(p("M43 10v6M43 44v6M23 30h6M57 30h6M29 16l4 4M53 40l4 4M57 16l-4 4M29 44l4-4"), with: .color(tape), lineWidth: 2 * sx)
            case .corners:
                ctx.stroke(rect(24, 10, 38, 46), with: .color(ink), lineWidth: 2 * sx)
                for (x, y) in [(24.0, 10.0), (62.0, 10.0), (62.0, 56.0), (24.0, 56.0)] {
                    let dot = Path(ellipseIn: CGRect(x: (x - 4) * sx, y: (y - 4) * sy, width: 8 * sx, height: 8 * sy))
                    ctx.fill(dot, with: .color(tape))
                    ctx.stroke(dot, with: .color(Theme.navy), lineWidth: 1.2 * sx)
                }
            }
        }
        .accessibilityHidden(true)
    }
}
