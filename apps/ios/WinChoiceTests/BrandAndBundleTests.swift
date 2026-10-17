import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import WinChoice

/// What makes the app WinChoice: its brand file, its colours, its permissions and privacy manifest.
final class BrandAndBundleTests: XCTestCase {
    private func components(_ color: Color, dark: Bool = false) -> (r: Int, g: Int, b: Int) {
        let ui = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }

    func testTheBrandFileIsWinChoiceAndHasNoLogo() {
        let brand = Brand.current
        XCTAssertEqual(brand.name, "WinChoice")
        XCTAssertEqual(brand.wordmark, "WinChoice", "a text wordmark")
        XCTAssertEqual(brand.colors.red, "#ED3A2B")
        XCTAssertEqual(brand.colors.navy, "#112337")
        XCTAssertEqual(brand.colors.navyDeep, "#061F3F")
        XCTAssertEqual(brand.colors.blue, "#155EAB")
        XCTAssertEqual(brand.quoteFootnote, "No payment today.")
        XCTAssertEqual(brand.windowColors.count, 6)
        XCTAssertNil(Bundle.main.url(forResource: "logo", withExtension: "png"), "the brief: no logo, WinChoice in text")
        let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        XCTAssertEqual((icons?["CFBundlePrimaryIcon"] as? [String: Any])?["CFBundleIconName"] as? String, "AppIcon", "the app has its icon")
    }

    func testTheThemeReadsItsBrandColoursFromTheBrandFile() {
        XCTAssertEqual(components(Theme.red).r, 0xED)
        XCTAssertEqual(components(Theme.red).g, 0x3A)
        XCTAssertEqual(components(Theme.red).b, 0x2B)
        XCTAssertEqual(components(Theme.blue).b, 0xAB)
        XCTAssertEqual(components(Theme.navy).r, 0x06)
        XCTAssertEqual(components(Theme.ink).r, 0x11, "ink is the brand navy in light mode")
        // Dark mode lifts them so they read on the dark ground
        XCTAssertEqual(components(Theme.red, dark: true).r, 0xFF)
        XCTAssertEqual(components(Theme.blue, dark: true).b, 0xEF)
        XCTAssertEqual(components(Theme.ground).r, 0xF3)
        XCTAssertEqual(components(Theme.ground, dark: true).r, 0x08)
    }

    func testThePermissionsSayWhatTheyAreFor() throws {
        let info = try XCTUnwrap(Bundle.main.infoDictionary)
        XCTAssertEqual(info["CFBundleDisplayName"] as? String, "WinChoice")
        XCTAssertEqual(Bundle.main.bundleIdentifier, "com.premjeetech.winchoice.measure")
        let camera = try XCTUnwrap(info["NSCameraUsageDescription"] as? String)
        XCTAssertTrue(camera.contains("camera") && camera.contains("measure"))
        XCTAssertNotNil(info["NSLocationWhenInUseUsageDescription"] as? String)
        XCTAssertNotNil(info["NSCalendarsWriteOnlyAccessUsageDescription"] as? String)
        XCTAssertEqual(info["ITSAppUsesNonExemptEncryption"] as? Bool, false)
        XCTAssertNil(info["NSUserTrackingUsageDescription"], "no tracking, so no tracking prompt")
        XCTAssertNil(info["NSPhotoLibraryUsageDescription"], "the app never reads the photo library")
    }

    func testThePrivacyManifestSaysNoTracking() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((plist["NSPrivacyTrackingDomains"] as? [Any])?.count, 0)
        let types = (plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]]) ?? []
        XCTAssertFalse(types.isEmpty, "what goes to the company's server is declared")
        for t in types {
            XCTAssertEqual(t["NSPrivacyCollectedDataTypeTracking"] as? Bool, false)
        }
        let api = (plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]])?.compactMap { $0["NSPrivacyAccessedAPIType"] as? String } ?? []
        XCTAssertTrue(api.contains("NSPrivacyAccessedAPICategoryUserDefaults"))
    }

    func testTheStaffScreensAreNotInThisApp() {
        // The rep app's screens compile only with STAFF_APP, which only the rep target sets
        #if STAFF_APP
        XCTFail("the WinChoice target must not compile the rep screens")
        #endif
    }
}
