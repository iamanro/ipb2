# Changelog

## 2026-10-08

### Changed

- IPB: one sheet on the left with **Steps** and **Worksheet** tabs instead of two
  sheets, so the map gets most of the window.
- IPB: a **Layers ▾** menu next to **Map ▾** switches the study's own layers (areas,
  OAKOC, MCOO, viewshed, units, graphics, custom layers) and the map overlays;
  **Map ▾** keeps only the basemap and symbol size. The MGRS grid starts off.
- IPB: a **Unit** tool in the status bar places units on any step; units with no
  COA show on every step.
- IPB: a saved MCOO, viewshed and line of sight are recomputed when a study opens,
  so the overlays show again without a re-run.
- IPB: civil considerations (ASCOPE × PMESII-PT) are a list of filled entries with
  an add/edit form and a **View matrix** dialog, instead of 48 small text fields.
- IPB: the study switcher explains what a study is, shows each study's cell, and
  moves Rename/Delete into the row's **⋯** menu. Overlapping map labels hide
  instead of printing over each other.

## 2026-09-29

### Added

- Revision-based optimistic concurrency for reports and requirements, including
  requirement parts, deletion, release and reassignment. Missing revisions return
  HTTP 400; stale revisions return HTTP 409 without overwriting newer changes.
- Explicit reload/reapply controls for conflicting edits. Report drafts survive
  live updates and remain visible when the report becomes unavailable. Requirement,
  SIR and indicator drafts survive conflict recovery and local refreshes.
- Server and browser regression coverage for stale saves, revision invalidation,
  draft recovery and migration of populated exercise state.
- A current acceptance-driven backlog with disposable exercise rehearsal,
  separate-deployment backup/restore, local load and container verification evidence.

### Fixed

- Report edits now persist author and observation time.
- Report-to-track linking and related evidence changes invalidate affected revisions.
- Load-test cleanup sends report revisions and reports failed deletions instead of
  claiming that cleanup succeeded.

### Documentation

- Documented the revision request contract and in-memory draft retention.
- Marked the original staff implementation plan as historical.
- Recorded outstanding LAN/TLS acceptance, hillshade load errors, unknown report-time
  presentation, and graphic INTSUM readiness/scale issues in the current backlog.
