# Measure windows: the Street View tools switch

**`WINDOWS_STREET_VIEW_TOOLS`** (API environment, default **off**; `1` or `true` turns it on).

Owner decision, 2026-10-16: an audit of 15 real houses found the Street View line-up never said 'good' (0 of 13) and
window sizes swung 2x with the rep's input, so these tools are hidden until they are reliable.

| | Off (default) | On |
|---|---|---|
| Street View photo | shown read-only as "Is this the right house?" with its capture date | the same, with the tools below |
| Front wall drawn on the photo (dashed overlay) and its fit chip | hidden; `wallOverlay` left out of the API answer | shown |
| "Front wall" corners panel | hidden | shown |
| "Mark windows on the photo" | hidden | shown |
| Door ruler | hidden | shown |
| Review reason `walls-unconfirmed` | never raised | raised when the line-up cannot confirm the wall |
| Server line-up (`windows-lineup.ts lineUp`) | skipped at measure time | run on every photo |
| "Add windows from photos" (on-site photos) | unchanged | unchanged |
| Walls estimate | unchanged | unchanged |

The API answers `photoTools: true|false` on every window measurement, and the web app shows the tools only when it is
true. Nothing is removed: the PATCH fields (`marked`, `wallCorners`, `ruler`) and every route still work, and marks made
earlier are still sized and counted. The optional detector (`WINDOW_DETECTOR`) is separate and unaffected.

Where: `apps/api/src/config.ts` (the flag), `estimator/measure-windows.ts` (skips the line-up),
`estimator/windows-view.ts` `toWindowView(row, now, { photoTools })`, `routes/window-measurements.ts`,
`apps/web/src/features/measure/windows/WindowsWindow.tsx` (`v.photoTools`).

An environment switch, not a company setting: the tools are unreliable for every company alike, and turning them back
on is a decision for the whole product once the line-up is fixed.
