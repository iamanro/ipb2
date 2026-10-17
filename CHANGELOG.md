# Changelog

## 2026-10-08

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
