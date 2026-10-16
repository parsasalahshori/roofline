#!/bin/sh
# Builds Roofline Measure and uploads it to App Store Connect (TestFlight, internal testers).
#
# Needs: Xcode (not just the Command Line Tools), XcodeGen (brew install xcodegen), an Apple Developer Program team,
# the app record for com.premjeetech.roofline.measure in App Store Connect, and a Team API key (Users and Access >
# Integrations > App Store Connect API, role App Manager or Admin).
#
#   export DEVELOPMENT_TEAM=ABCDE12345                                        # Apple team id
#   export ASC_KEY_ID=XXXXXXXXXX                                             # API key id
#   export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx                # API issuer id
#   export ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
#   apps/ios/scripts/testflight.sh
#
# The build number is a UTC timestamp (yymmddHHMM), so every upload is newer than the last. BUILD_NUMBER overrides it.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"

: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to the Apple team id}"
: "${ASC_KEY_PATH:?set ASC_KEY_PATH to the App Store Connect API key (.p8)}"
: "${ASC_KEY_ID:?set ASC_KEY_ID to the API key id}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID to the API issuer id}"
[ -f "$ASC_KEY_PATH" ] || { echo "No API key at $ASC_KEY_PATH" >&2; exit 1; }
command -v xcodegen >/dev/null 2>&1 || { echo "XcodeGen is missing: brew install xcodegen" >&2; exit 1; }
xcodebuild -version >/dev/null 2>&1 || { echo "xcodebuild needs Xcode: install it and run sudo xcode-select -s /Applications/Xcode.app" >&2; exit 1; }

BUILD_NUMBER=${BUILD_NUMBER:-$(date -u +%y%m%d%H%M)}
ARCHIVE="$here/build/RooflineMeasure.xcarchive"
EXPORT="$here/build/export"
AUTH="-authenticationKeyPath $ASC_KEY_PATH -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"

echo "== Core checks"
(cd Core && swift test) || { echo "RooflineCore checks failed: not uploading." >&2; exit 1; }

echo "== Generate the Xcode project"
xcodegen generate

echo "== Archive (build $BUILD_NUMBER)"
rm -rf "$ARCHIVE" "$EXPORT"
# shellcheck disable=SC2086
xcodebuild \
  -project RooflineMeasure.xcodeproj \
  -scheme RooflineMeasure \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates $AUTH \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  archive

echo "== Export and upload to App Store Connect"
opts="$here/build/ExportOptions.plist"
cp ExportOptions.plist "$opts"
plutil -replace teamID -string "$DEVELOPMENT_TEAM" "$opts"
# shellcheck disable=SC2086
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$opts" \
  -exportPath "$EXPORT" \
  -allowProvisioningUpdates $AUTH

echo "Uploaded build $BUILD_NUMBER. It shows in App Store Connect > TestFlight after processing (about 5-30 minutes)."
