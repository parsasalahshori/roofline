# Test fixtures

`ar-sizing.json` is written by the server's vitest from `sizeFromArPoints` (packages/shared/src/window-photo-math.ts):
AR corner points (`pointsM`, metres), the `device`, optional `cornerSpreadM`, and the expected `widthIn`, `heightIn`,
`uncertaintyIn` and `quality`. `ArSizingParityTests` and `Core/scripts/check.sh` compare the Swift port against it and
skip when the file is not here yet. Do not edit it by hand: regenerate it from the server's test.
