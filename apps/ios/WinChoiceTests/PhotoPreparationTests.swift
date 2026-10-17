import CoreGraphics
import Foundation
import ImageIO
import UIKit
import XCTest
@testable import WinChoice

/// The photo the server reads: pixels as displayed, the 35 mm focal length kept, nothing else (no location, no serial).
final class PhotoPreparationTests: XCTestCase {
    private func exif(_ focal: Any?) -> [AnyHashable: Any] {
        var e: [String: Any] = [:]
        if let f = focal { e[kCGImagePropertyExifFocalLenIn35mmFilm as String] = f }
        return [kCGImagePropertyExifDictionary as String: e]
    }

    func testTheFocalLengthIsReadFromTheCamerasMetadata() {
        XCTAssertEqual(PhotoPreparation.focal35mm(in: exif(26)), 26)
        XCTAssertEqual(PhotoPreparation.focal35mm(in: exif(NSNumber(value: 24.0))), 24)
        XCTAssertNil(PhotoPreparation.focal35mm(in: exif(7)), "not a believable lens")
        XCTAssertNil(PhotoPreparation.focal35mm(in: exif(900)))
        XCTAssertNil(PhotoPreparation.focal35mm(in: exif("wide")))
        XCTAssertNil(PhotoPreparation.focal35mm(in: nil))
        XCTAssertNil(PhotoPreparation.focal35mm(in: [:]))
    }

    func testThePreparedJPEGKeepsTheFocalLengthAndNothingPersonal() throws {
        var metadata = exif(26)
        metadata[kCGImagePropertyGPSDictionary as String] = [kCGImagePropertyGPSLatitude as String: 34.74, kCGImagePropertyGPSLongitude as String: -92.39]
        let photo = try XCTUnwrap(PhotoPreparation.prepare(SampleScene.small.image(withCard: false), metadata: metadata))
        XCTAssertEqual(photo.focal35mm, 26)
        XCTAssertEqual(photo.widthPx, 756)
        XCTAssertEqual(photo.heightPx, 1008)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(photo.jpeg as CFData, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any])
        let exifOut = props[kCGImagePropertyExifDictionary as String] as? [String: Any]
        XCTAssertEqual((exifOut?[kCGImagePropertyExifFocalLenIn35mmFilm as String] as? NSNumber)?.intValue, 26)
        XCTAssertNil(props[kCGImagePropertyGPSDictionary as String], "no location leaves the phone")
        XCTAssertEqual((props[kCGImagePropertyOrientation as String] as? NSNumber)?.intValue ?? 1, 1, "pixels as displayed: the server reads them upright")
        XCTAssertEqual(props[kCGImagePropertyPixelWidth as String] as? Int, 756)
    }

    func testAPhotoWithNoMetadataStillGoes() throws {
        let photo = try XCTUnwrap(PhotoPreparation.prepare(SampleScene.small.image(withCard: false)))
        XCTAssertNil(photo.focal35mm)
        XCTAssertGreaterThan(photo.jpeg.count, 1000)
    }

    func testABigPhotoIsBroughtUnderTheServersLimits() throws {
        let big = SampleScene(size: CGSize(width: 6000, height: 8000), windowShare: 0.6).image(withCard: false)
        let photo = try XCTUnwrap(PhotoPreparation.prepare(big, maxSide: 4032, maxBytes: 11_000_000))
        XCTAssertEqual(max(photo.widthPx, photo.heightPx), 4032)
        XCTAssertLessThanOrEqual(photo.jpeg.count, 11_000_000, "the server refuses over 12 MB")
        XCTAssertEqual(Double(photo.widthPx) / Double(photo.heightPx), 0.75, accuracy: 0.001, "the shape is kept")
    }
}
