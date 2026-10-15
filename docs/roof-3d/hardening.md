# Roof 3D hardening

Track: hardening (failure modes FM01, FM05, FM11, FM13 of the October 2026 taxonomy, plus input guards, a kill
switch, secrets and data retention). One section per change, in the order they were committed.

## 1. Versioned 3D snapshots (FM01)

**Problem.** A measurement keeps the 3D roof it was priced from (`measurements.roof_3d`), and `roof3dForHome` reuses
the newest one for 30 days. Nothing recorded which reconstruction made it (`Roof3d.version = 1` is the shape, not the
algorithm), so an improved algorithm never showed on a home already measured: the owner's 305 Ridgeway Dr screenshot
(four sliver faces) was a snapshot from before the sliver cleanup, served again on five later measurements, and with no
quality block, so no review banner could show either.

**Approach.** Every snapshot is stamped with `schemaVersion` (its layout, now 2) and `algorithmVersion`
(`ROOF_3D_ALGORITHM_VERSION`, now 2) before it is kept. `roof3dSnapshotFresh` treats any algorithm version other than
the running one (older, newer, absent = 1, or garbled) as stale, so the home is reconstructed again (one Data Layers
request, inside the free quota) and the new measurement keeps the new snapshot. A kept "no imagery" is Google's answer,
not the algorithm's, so it stays fresh across versions (no needless purchase). Readers ignore fields they do not know;
legacy rows still read and render exactly as before (`isRoof3d` is unchanged).

**Rule for every later change:** bump `ROOF_3D_ALGORITHM_VERSION` with any change that changes what a reconstruction
returns. A pure refactor leaves it.

**Alternatives rejected.** Hashing the reconstruction source files at build time (changes on comment edits, so every
deploy would re-buy every roof); a date cut-off (cannot express a rollback); keeping the raw layers to re-run without a
purchase (the right next step, see open issues, but a storage change that cannot be cherry-picked on its own).

**Risks.** Each version bump costs one Data Layers request per re-measured home within 30 days (free quota today).
Two servers running different versions side by side would each treat the other's snapshots as stale and re-buy.

**Rollback.** Revert the commit: snapshots stamped meanwhile carry two extra JSON fields that older readers ignore.
