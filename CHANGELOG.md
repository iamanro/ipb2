# Changelog

## 2026-10-12

### Added

- Scenario packages: the Instructor desk exports the story, situations and injects
  as one `.scenario.json` file and imports it back (validated as a whole; situations
  added as Planned, injects as Pending).
- Exercise **Documents**: cell-owned uploaded files (OPLAN, annexes, plans) with
  release, owner reassignment and in-place new editions.
- Requirements import from a collection plan workbook (ICP `.xlsx`): PIR/SIR/EEI rows
  become PIRs, SIRs and indicators; reimport updates them per cell.

### Changed

- Bun replaces Node and npm everywhere: package manager (`bun.lock`, `bun install`),
  server runtime (`bun server/index.ts`, Docker image `oven/bun:1.4.3-slim`), test
  runner (`bun test`, tests import `bun:test`), Playwright under `bun --bun`, CI via
  `oven-sh/setup-bun`, tool shebangs and every documented command.
- Vite and vite-plus (`vp`) are gone. `build.ts` bundles the client with `Bun.build`
  (absolute `/assets/` paths, every module stylesheet linked up front, @fontsource
  faces as separate files instead of 1.5 MB of inlined base64); a failed build keeps
  the previous `dist/`. `bun run dev` (`dev.ts`) serves that build through the
  production server and rebuilds on client changes — no hot reload, reload the page.
  Type checking is Bun's built-in `bun check`; lint (Oxlint, type-aware rules) and
  format (Oxfmt) run directly with the same rules (`.oxlintrc.json`, `.oxfmtrc.json`).
  `bun run verify` runs all three; the `check` script is gone so it no longer
  shadows `bun check`.
- `IPB_TLS_CERT`/`IPB_TLS_KEY` make the server listen on HTTPS (replaces the Vite
  `server.https` route the README described for LAN mode).
- Shutdown drops connections still open 2 s after SIGTERM: Bun never treats a
  keep-alive connection that streamed a file as idle, so `server.close()` alone
  waited out the 10 s timeout and exited 1.
- The backup/restore "no route code" test now guards `routes.ts` with a preloaded Bun
  plugin; it had silently checked nothing since the server moved to `.ts`.
- The ZIP reader moved from `modules/terrain/tools/zip.mjs` to `server/zip.ts` (now
  also used for `.xlsx`) and caps each entry's inflated size.

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

### Fixed

- Login rate limit now counts each attempt before the password hash, so parallel
  guesses hit HTTP 429 like sequential ones instead of all getting through.
- The audit trail (`GET /api/auth/audit`) is limited to admins and White's
  game-master; a Blue or Red game-master (and a user without a membership, which
  used to get HTTP 500) now gets HTTP 403.
- After the live stream reconnects, every open view reloads its data, so changes
  made while it was down are no longer missed.
- The server-wide live stream cap is 256 (was 64), enough for a full classroom
  with several tabs each.
- A malformed `%` escape in an API path answers HTTP 404 instead of 500.
- `POST /api/auth/exercise/archive` no longer hides a too-large or invalid JSON body.

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
