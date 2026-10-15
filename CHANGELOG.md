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
