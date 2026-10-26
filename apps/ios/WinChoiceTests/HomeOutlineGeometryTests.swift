import CoreGraphics
import Foundation
import RooflineCore
import XCTest
@testable import WinChoice

/// The geometry behind the results screen's "finding your home" animation: what outline can be drawn, where the camera looks, and
/// how the map's own answer is checked against it. (The animation itself is checked by eye, in the simulator.)
final class HomeOutlineGeometryTests: XCTestCase {
    /// The real server's roof ring for 120 Briar Rose, Irvine (closed: the last point is the first's neighbour, not a repeat).
    private let briarRose: [(lon: Double, lat: Double)] = [
        (-117.710856, 33.68851), (-117.710884, 33.688482), (-117.710918, 33.688481), (-117.710931, 33.688468), (-117.710931, 33.688453),
        (-117.710947, 33.688437), (-117.710809, 33.688343), (-117.710799, 33.688342), (-117.71073, 33.688413), (-117.710724, 33.688432),
        (-117.710839, 33.68851),
    ]

    /// A 20 m by 10 m rectangle near Irvine.
    private func rectangle(widthM: Double = 20, heightM: Double = 10, lat: Double = 33.6884, lon: Double = -117.7108) -> [(lon: Double, lat: Double)] {
        let dLon = widthM / (111_320 * cos(lat * .pi / 180)) / 2, dLat = heightM / 111_320 / 2
        return [(lon - dLon, lat - dLat), (lon + dLon, lat - dLat), (lon + dLon, lat + dLat), (lon - dLon, lat + dLat)]
    }

    private func geometry(_ pts: [(lon: Double, lat: Double)]) throws -> HomeOutlineGeometry {
        try XCTUnwrap(HomeOutlineGeometry(points: pts))
    }

    // MARK: What can be drawn

    func testTheServersRingIsUsed() throws {
        let g = try geometry(briarRose)
        XCTAssertEqual(g.ring.count, 11)
        XCTAssertEqual(g.widthMeters, 20.6, accuracy: 0.5)
        XCTAssertEqual(g.heightMeters, 18.7, accuracy: 0.5)
        XCTAssertEqual(g.centerLat, 33.688426, accuracy: 1e-6)
        XCTAssertEqual(g.centerLon, -117.710835, accuracy: 1e-6)
    }

    func testAClosedRingDropsItsRepeatedFirstPoint() throws {
        var pts = rectangle()
        pts.append(pts[0])
        XCTAssertEqual(try geometry(pts).ring.count, 4)
        // a repeated neighbour adds no corner either
        var doubled = rectangle()
        doubled.insert(doubled[1], at: 1)
        XCTAssertEqual(try geometry(doubled).ring.count, 4)
    }

    func testNothingSensibleMeansNoOutline() {
        XCTAssertNil(HomeOutlineGeometry(outline: nil))
        XCTAssertNil(HomeOutlineGeometry(points: []))
        XCTAssertNil(HomeOutlineGeometry(points: Array(rectangle().prefix(2))))
        // three corners that are one point
        XCTAssertNil(HomeOutlineGeometry(points: [(-117.7, 33.6), (-117.7, 33.6), (-117.7, 33.6)]))
        // a sliver under a metre wide and long
        XCTAssertNil(HomeOutlineGeometry(points: rectangle(widthM: 0.5, heightM: 0.5)))
        // not coordinates
        XCTAssertNil(HomeOutlineGeometry(points: [(.nan, 33.6), (-117.7, 33.61), (-117.69, 33.6)]))
        XCTAssertNil(HomeOutlineGeometry(points: [(-117.7, 133.6), (-117.7, 33.61), (-117.69, 33.6)]))
    }

    func testBuiltFromTheServersOutlineModel() {
        let outline = HomeownerOutline(center: [-117.7108, 33.6884], ring: [[-117.7109, 33.6883], [-117.7107, 33.6883], [-117.7107, 33.6885], [-117.7109, 33.6885], [5]])
        // the stray one-number point is skipped, the rest is a four-corner ring
        XCTAssertEqual(HomeOutlineGeometry(outline: outline)?.ring.count, 4)
        XCTAssertNil(HomeOutlineGeometry(outline: HomeownerOutline(center: [], ring: [])))
    }

    // MARK: Framing

    func testTheHouseSitsInTheMiddleAndFitsWithinItsShare() throws {
        let g = try geometry(rectangle(widthM: 20, heightM: 10))
        let size = CGSize(width: 361, height: 250)
        let f = g.framing(for: size)
        XCTAssertEqual(f.centerLat, g.centerLat, accuracy: 1e-9)
        XCTAssertEqual(f.groundWidth / f.groundHeight, 361.0 / 250.0, accuracy: 1e-9)
        let pts = g.expectedPoints(in: f, size: size)
        let xs = pts.map(\.x), ys = pts.map(\.y)
        XCTAssertEqual((xs.min()! + xs.max()!) / 2, size.width / 2, accuracy: 0.01)
        XCTAssertEqual((ys.min()! + ys.max()!) / 2, size.height / 2, accuracy: 0.01)
        XCTAssertLessThanOrEqual(xs.max()! - xs.min()!, size.width * HomeOutlineGeometry.fillWidth + 0.01)
        XCTAssertLessThanOrEqual(ys.max()! - ys.min()!, size.height * HomeOutlineGeometry.fillHeight + 0.01)
        // north is up: the first corner is the south-west one, so it is lower and further left than the third
        XCTAssertGreaterThan(pts[0].y, pts[2].y)
        XCTAssertLessThan(pts[0].x, pts[2].x)
    }

    func testAHugeHouseFillsItsShareAndATinyOneIsNotZoomedPastTheImagery() throws {
        let size = CGSize(width: 361, height: 250)
        let big = try geometry(rectangle(widthM: 60, heightM: 30)).framing(for: size)
        XCTAssertEqual(big.groundWidth, 60 / HomeOutlineGeometry.fillWidth, accuracy: 0.5)
        let small = try geometry(rectangle(widthM: 6, heightM: 5)).framing(for: size)
        XCTAssertEqual(small.groundHeight, HomeOutlineGeometry.closestGround, accuracy: 0.001)
        let enormous = try geometry(rectangle(widthM: 600, heightM: 300)).framing(for: size)
        XCTAssertEqual(enormous.groundHeight, HomeOutlineGeometry.furthestGround, accuracy: 0.001)
    }

    func testTheStartingViewIsWiderAndTakesInTheFinalOne() throws {
        let g = try geometry(briarRose)
        let tight = g.framing(for: CGSize(width: 361, height: 250))
        let wide = HomeOutlineGeometry.wide(from: tight)
        XCTAssertGreaterThan(wide.groundWidth, tight.groundWidth * 3)
        XCTAssertGreaterThan(wide.groundHeight, tight.groundHeight * 3)
        // the final frame lies inside the starting one, so the move is a pure zoom-in with a pan
        let corners = g.expectedPoints(in: wide, size: CGSize(width: 361, height: 250))
        XCTAssertTrue(corners.allSatisfy { $0.x > 0 && $0.x < 361 && $0.y > 0 && $0.y < 250 })
        let finalFrame = try geometry(rectangle(widthM: tight.groundWidth, heightM: tight.groundHeight, lat: tight.centerLat, lon: tight.centerLon))
        let finalInWide = finalFrame.expectedPoints(in: wide, size: CGSize(width: 361, height: 250))
        XCTAssertTrue(finalInWide.allSatisfy { $0.x > 0 && $0.x < 361 && $0.y > 0 && $0.y < 250 })
    }

    func testScalingAFramingKeepsItsCentre() {
        let f = HomeOutlineGeometry.Framing(centerLat: 33.6, centerLon: -117.7, groundWidth: 60, groundHeight: 40)
        let s = f.scaled(by: 0.5)
        XCTAssertEqual(s.groundWidth, 30)
        XCTAssertEqual(s.groundHeight, 20)
        XCTAssertEqual(s.centerLat, 33.6)
        XCTAssertEqual(s.centerLon, -117.7)
    }

    // MARK: Checking the map's answer

    func testTheMapsAnswerMatchingTheFramingIsAccepted() throws {
        let g = try geometry(briarRose)
        let size = CGSize(width: 361, height: 250)
        let expected = g.expectedPoints(in: g.framing(for: size), size: size)
        let p = try XCTUnwrap(g.placement(of: expected.map { CGPoint(x: $0.x + 0.4, y: $0.y - 0.3) }, expected: expected, in: size))
        XCTAssertEqual(p.scale, 1, accuracy: 0.001)
    }

    func testAMapShowingMoreGroundThanAskedReportsHowMuch() throws {
        let g = try geometry(briarRose)
        let size = CGSize(width: 361, height: 250)
        let expected = g.expectedPoints(in: g.framing(for: size), size: size)
        let mid = CGPoint(x: size.width / 2, y: size.height / 2)
        // the house drawn at 0.65 of its expected size, about the middle (the map zoomed out by 1.54)
        let smaller = expected.map { CGPoint(x: mid.x + ($0.x - mid.x) * 0.65, y: mid.y + ($0.y - mid.y) * 0.65) }
        let p = try XCTUnwrap(g.placement(of: smaller, expected: expected, in: size))
        XCTAssertEqual(p.scale, 0.65, accuracy: 0.01)
        XCTAssertEqual(p.points, smaller)
    }

    func testACameraStillOnItsWayIsNotAccepted() throws {
        let g = try geometry(briarRose)
        let size = CGSize(width: 361, height: 250)
        let tight = g.framing(for: size)
        let expected = g.expectedPoints(in: tight, size: size)
        // still at the wide start: the house is a third of its size and off to one side
        let wide = g.expectedPoints(in: HomeOutlineGeometry.wide(from: tight), size: size)
        XCTAssertNil(g.placement(of: wide, expected: expected, in: size))
        // right size, but not in the middle yet
        XCTAssertNil(g.placement(of: expected.map { CGPoint(x: $0.x + 70, y: $0.y) }, expected: expected, in: size))
    }

    func testAnAnswerThatCannotBeRightIsNotAccepted() throws {
        let g = try geometry(briarRose)
        let size = CGSize(width: 361, height: 250)
        let expected = g.expectedPoints(in: g.framing(for: size), size: size)
        XCTAssertNil(g.placement(of: Array(expected.dropLast()), expected: expected, in: size))
        var withNaN = expected
        withNaN[2] = CGPoint(x: CGFloat.nan, y: 3)
        XCTAssertNil(g.placement(of: withNaN, expected: expected, in: size))
        XCTAssertNil(g.placement(of: expected.map { _ in CGPoint(x: 180, y: 125) }, expected: expected, in: size))
    }

    // MARK: Along the stroke

    func testPointsAlongAClosedOutline() {
        let square = [CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 0), CGPoint(x: 10, y: 10), CGPoint(x: 0, y: 10)]
        XCTAssertEqual(HomeOutlineGeometry.point(at: 0, along: square), CGPoint(x: 0, y: 0))
        XCTAssertEqual(HomeOutlineGeometry.point(at: 0.125, along: square), CGPoint(x: 5, y: 0))
        XCTAssertEqual(HomeOutlineGeometry.point(at: 0.25, along: square), CGPoint(x: 10, y: 0))
        XCTAssertEqual(HomeOutlineGeometry.point(at: 0.625, along: square), CGPoint(x: 5, y: 10))
        XCTAssertEqual(HomeOutlineGeometry.point(at: 1, along: square), CGPoint(x: 0, y: 0))
        // out of range is clamped, not a crash
        XCTAssertEqual(HomeOutlineGeometry.point(at: 7, along: square), CGPoint(x: 0, y: 0))
        XCTAssertEqual(HomeOutlineGeometry.point(at: -1, along: square), CGPoint(x: 0, y: 0))
        XCTAssertNil(HomeOutlineGeometry.point(at: 0.5, along: []))
    }

    func testEachCornerIsReachedInOrderAndTheFirstAtTheStart() throws {
        let g = try geometry(briarRose)
        let f = g.vertexFractions
        XCTAssertEqual(f.count, g.ring.count)
        XCTAssertEqual(f.first, 0)
        XCTAssertEqual(f, f.sorted())
        XCTAssertLessThan(f.last!, 1)
        // a 20 x 10 rectangle: the corners are at 1/3 and 1/2, 5/6 of the way round
        let r = try geometry(rectangle(widthM: 20, heightM: 10)).vertexFractions
        XCTAssertEqual(r[1], 1.0 / 3, accuracy: 0.001)
        XCTAssertEqual(r[2], 0.5, accuracy: 0.001)
        XCTAssertEqual(r[3], 5.0 / 6, accuracy: 0.001)
    }

    func testThePerimeterAgreesWithTheScreensFeet() throws {
        let g = try geometry(briarRose)
        let outline = HomeownerOutline(center: [g.centerLon, g.centerLat], ring: briarRose.map { [$0.lon, $0.lat] })
        let feet = try XCTUnwrap(HomeFootprint.perimeterFeet(outline))
        XCTAssertEqual(Double(feet), g.perimeterMeters * 3.28084, accuracy: 8)
    }

    // MARK: The reveal's hand-over to the results screen

    @MainActor
    func testSkipCountsUpForTheHeroToSeeIt() {
        let reveal = HomeReveal()
        XCTAssertEqual(reveal.stage, .pending)
        reveal.skip()
        reveal.skip()
        XCTAssertEqual(reveal.skipCount, 2)
    }
}
