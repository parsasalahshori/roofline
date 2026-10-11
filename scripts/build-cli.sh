#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/.buildcli"
REVISION=471f8e7d9d02a42154f26a6aa423858c19720ca8
mkdir -p "$BUILD_DIR"
if [ ! -d "$BUILD_DIR/source/.git" ]; then git clone https://github.com/BuildCLI/BuildCLI.git "$BUILD_DIR/source"; fi
git -C "$BUILD_DIR/source" checkout --detach "$REVISION"
MVN="${MVN:-mvn}"
"$MVN" -q -f "$BUILD_DIR/source/pom.xml" -Dmaven.repo.local="$BUILD_DIR/m2" -Dmaven.test.skip=true install
cp "$BUILD_DIR/source/cli/target/buildcli.jar" "$BUILD_DIR/buildcli.jar"
mkdir -p "$BUILD_DIR/plugins" "$BUILD_DIR/classes"
javac --release 21 -cp "$BUILD_DIR/buildcli.jar" -d "$BUILD_DIR/classes" "$ROOT"/cli/roof/src/main/java/dev/buildcli/plugin/roof/*.java
cp -R "$ROOT/cli/roof/src/main/resources/." "$BUILD_DIR/classes/"
jar --create --file "$BUILD_DIR/plugins/roof.jar" -C "$BUILD_DIR/classes" .
printf 'BuildCLI roof plugin built. Run: ./scripts/buildcli roof --help\n'
