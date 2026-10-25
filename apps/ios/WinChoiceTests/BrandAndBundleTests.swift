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

    func testTheThemeIsTheSystemLookWithWinChoiceRedAsTheAccent() {
        // The accent: the brand red darkened from #ED3A2B (4.0:1 on white) to #CC2F23 (5.3:1 with white, 4.7:1 on the grouped grey),
        // so red text, links and white labels on red clear 4.5:1. Dark mode takes the brand's own lighter red for text.
        XCTAssertEqual(components(Theme.red).r, 0xCC)
        XCTAssertEqual(components(Theme.red).g, 0x2F)
        XCTAssertEqual(components(Theme.red).b, 0x23)
        XCTAssertEqual(components(Theme.buttonFill).r, 0xCC)
        XCTAssertEqual(components(Theme.buttonFill).g, 0x2F)
        XCTAssertEqual(components(Theme.buttonFill).b, 0x23)
        XCTAssertEqual(components(Theme.red, dark: true).r, 0xFF)
        XCTAssertEqual(components(Theme.red, dark: true).g, 0x5A)
        XCTAssertEqual(components(Theme.red, dark: true).b, 0x4B)
        XCTAssertEqual(components(Theme.buttonFill, dark: true).r, 0xCC, "white button text needs the darker red in dark mode too")
        XCTAssertEqual(components(Theme.blue).r, 0xCC, "the old blue slot is the accent now")
        // Everything else is a system colour: nothing navy, no custom blue.
        XCTAssertEqual(components(Theme.ground).r, 0xF2, "systemGroupedBackground")
        XCTAssertEqual(components(Theme.ground, dark: true).r, 0x00)
        XCTAssertEqual(components(Theme.surface).r, 0xFF, "secondarySystemGroupedBackground")
        XCTAssertEqual(components(Theme.ink).r, 0x00, "label is black in light mode")
        XCTAssertEqual(components(Theme.ink, dark: true).r, 0xFF)
        XCTAssertNotEqual(components(Theme.navy).b, 0x3F, "the navy hero colour is retired")
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
