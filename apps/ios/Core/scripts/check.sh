#!/bin/sh
# Builds RooflineCore and runs its checks with swiftc alone: for a Mac with only the Command Line Tools, where
# `swift build` / `swift test` cannot run (no PackageDescription module or XCTest in some CLT installs).
# With Xcode installed, `swift build && swift test` (in apps/ios/Core) does the same.
#
#   apps/ios/Core/scripts/check.sh [path/to/ar-sizing.json]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/.build/check"
mkdir -p "$out"
cd "$out"

swiftc -module-name RooflineCore -parse-as-library -emit-module -emit-library -static \
  -o "$out/libRooflineCore.a" "$here"/Sources/RooflineCore/*.swift
swiftc -module-name RooflineCoreCheckSuite -parse-as-library -emit-module -emit-library -static \
  -I "$out" -o "$out/libRooflineCoreCheckSuite.a" "$here"/Sources/RooflineCoreCheckSuite/*.swift
swiftc -module-name RooflineCoreChecks -I "$out" -L "$out" -lRooflineCore -lRooflineCoreCheckSuite \
  -o "$out/RooflineCoreChecks" "$here"/Sources/RooflineCoreChecks/main.swift

cd "$here"
exec "$out/RooflineCoreChecks" "${1:-$here/../RooflineMeasureTests/Fixtures/ar-sizing.json}"
