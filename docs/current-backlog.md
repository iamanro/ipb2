# Current backlog and acceptance evidence

This is the current work list, ordered by exercise risk. The [staff plan](staff-plan.md)
is a historical implementation record, not an outstanding feature list. Current
operating procedures live in the [operator runbook](operator-runbook.md).

## Rehearsal evidence — 28 September 2026

A production build was served by `node server/index.js` with authentication enabled
and a new temporary `IPB_STATE_ROOT`. No active exercise state was used. White,
Blue and Red used separate browser profiles. Browser requests were restricted to
the local server; this verifies the exercised browser workflow without external
HTTP dependencies, not physical LAN disconnection or server-side egress isolation.

Observed workflow:

- White saved a private story and explicitly delivered only its Blue briefing.
  Blue received the briefing without the instructor notes.
- Blue created a COA, polygon NAI and timed event through the normal IPB API, then
  used **Import event matrix** in the browser. The resulting PIR/SIR retained the
  NAI geometry and the formatted expected event time.
- Blue created a collector and tasking through the Collection UI. The stored SOR
  included the collector, SIR, NAI and time window; conflict lists were empty.
- White scheduled a located SALUTE for `281000ZSEP26`, then jumped the paused
  scenario clock to that time. The server delivered it to Blue without a manual
  browser refresh. Red's report list remained empty.
- Blue linked the delivered report as evidence; the PIR became fulfilled. A
  separate timed Blue observation updated an existing track, retaining its earlier
  position and linking the new position to the report.
- An unreleased Blue report was invisible to Red. Release made it appear live with
  no edit/delete controls. Withdrawal removed it live; a direct Red GET returned
  404 afterward.
- Blue generated, assessed and saved an INTSUM. Its actual one-page PDF contained
  the report, track, PIR status, `281000ZSEP26` and classification banners, without
  the editor or other products. A separate SALUTE PDF contained the correct MGRS,
  Admiralty grade, scenario DTG and classification.
- The IPB local roads basemap rendered with no nonlocal HTTP resource entries.

This was a technical smoke rehearsal, not a staff usability assessment or target
LAN capacity certification. See the remaining acceptance gates below.

## Local operational evidence — 28 September 2026

- Standalone production Node reported healthy writable state and all configured
  terrain, DMR 4G, vector basemap, satellite, ortho, equipment/images and geography
  reference data present.
- Docker daemon and Compose were available. An existing local `ipb:latest` image
  (built 27 September, not a fresh build of these changes) started with disposable
  state and read-only reference data; health and admin login succeeded. Compose
  configuration validated. This does not certify a newly built image or TLS.
- The real backup/restore tools recovered seeded accounts, memberships, studies,
  ORBAT, requirements, reports and an exercise archive. A post-backup study
  disappeared and a removed membership returned. All four restored SQLite
  databases passed integrity checks. The source app was stopped before restore.
- A second drill backed up a running source, restored into a **different empty
  state root**, and started that target on another port. API checks recovered the
  exact study bounds/polygon, reports, requirements, memberships and archive.
  Restoring the exercise archive on the target also removed a transient study and
  restored its removed Red membership, polygon and report. Both temporary
  deployments and their state were removed afterward.
- A 30-user, five-minute run of `deploy/loadtest.mjs` against standalone production
  Node over local HTTP completed with no request errors. This was loopback, not the
  client LAN/TLS path and not the Compose CPU/memory limits.

| Request kind   | Count |      p50 |      p95 |   Maximum |
| -------------- | ----: | -------: | -------: | --------: |
| List           | 8,005 |     2 ms |     3 ms |     27 ms |
| Report write   |   215 |     1 ms |     1 ms |     11 ms |
| Vector basemap | 5,229 |     6 ms |   176 ms |    236 ms |
| Satellite      | 6,972 |     2 ms |   135 ms |  1,114 ms |
| Hillshade      | 6,972 |     3 ms | 1,307 ms |  4,883 ms |
| Viewshed       |    70 | 2,098 ms | 7,628 ms | 16,272 ms |

All 30 initial map loads completed in 3,963 ms. There were 2,579 measured same-cell
report deliveries: p50 1 ms, p95 2 ms, maximum 11 ms.

**Do not discard the earlier failure:** a separate one-minute, 30-user run returned
12 hillshade HTTP 503 responses. The longer fresh-state run's success does not
explain or invalidate those failures. Reproduce and classify terrain busy/errors
on the target deployment before treating capacity as accepted.

An initial restore attempted while source migrations were being edited returned
`table story already exists` when opening requirements. A fresh current-schema
backup/restore passed afterward. The populated rehearsal database was then upgraded
from exercise schema 13 to 14: existing reports remained readable, and an update
persisted observation time/author while a stale second writer received HTTP 409.
This does not certify arbitrary downgrade or mixed-code migration combinations.

## Implemented and verified — concurrent editing

Reports and requirements now expose integer revisions. Updates/deletes and
release/reassign requests require the revision the caller read; requirement part
mutations use the parent's revision. Missing revisions return 400 and stale
revisions return 409 without changing the item. The README documents the wire
contract and which related changes invalidate revisions.

Observed in the final browser/server build:

- Opening Edit loads the report's actual fields. A second writer's save does not
  replace the first browser's unsaved draft. A stale save shows a visible conflict
  while the newer server value remains intact.
- Reapply retains the report draft but does not save it; another deliberate save
  is required. Reload latest replaces the draft with the current report. Losing
  access while editing retains the draft with an unavailable notice and no save
  action.
- A stale Add SIR preserves its draft. Editing the draft after the conflict and
  choosing Reapply preserves the corrected text and requires another Add SIR.
  Saving that SIR keeps an unrelated new-requirement draft and indicator draft.
  A stale indicator toggle shows an error; explicit reload restores its actual
  state while preserving those drafts.
- Report edits now persist the already-editable author and observation-time
  fields. Track plotting invalidates the linked report's revision.
- The load tool sends the report's creation revision on cleanup deletion. An
  actual two-user smoke created and removed two reports with zero request errors;
  no load reports remained afterward.

Verification: `npm run check` passed; all **969 tests in 67 files** passed; all
**12 browser tests** passed, including the new two-client report conflict
regression. The production build passed. The existing `src/geo.js` / `mgrs`
undefined-default-import build warning remains; it was present before this work.

A fresh `ipb:rehearsal-20260928` Docker image also built and ran with isolated state
and read-only reference-data mounts. Health reported all configured data present,
admin authentication succeeded, a report update returned revision 2, and a second
update using revision 1 returned 409. This verifies current Node 24 image packaging
and local HTTP behavior, not the target TLS/LAN path.

## Remaining acceptance gates

### 1. Prove the actual LAN deployment and recovery

**Acceptance:** run the existing 30-user, five-minute load command from another
machine on the intended LAN, through the deployed TLS proxy, while terrain
analyses execute. Record per-kind p50/p95/max, errors, live-delivery latency and
resource use. On disposable state, back up and restore into a separate deployment;
verify accounts, memberships, study geometry, reports and exercise archives. Repeat
the core workflow with WAN access disconnected while LAN access remains available.

Local HTTP or same-host container results must not be presented as LAN results.
Do not run a load test against an active exercise.

### 2. Make unknown report times explicit

**Observed:** a manually created report with no observation time stores
`occurred_at: null`, but its list row displays its wall-clock creation DTG. With
the scenario paused at `281000ZSEP26`, the row displayed `281745ZSEP26`. Attempting
to plot that report returned `observed_at is required.` A report with an explicit
observation time plotted successfully.

**Acceptance:** distinguish observation time from receipt/creation time in the
report list and plotting flow. Never silently present receipt time as an
observation. If an observation time is required to plot, prompt for it before
submitting the track mutation. Verify paused and accelerated scenario clocks and
an intentionally unknown observation time.

### 3. Make graphic INTSUM printing ready and legible

**Observed:** printing immediately after selecting a report/rebuilding Products
produced a graphic INTSUM PDF with a legend but no map. After the on-screen map
settled, printing included its map snapshot. The settled initial view for a nearby
track and reports was extremely zoomed in, with no useful terrain context and a
caption rounded to `~1 px ≈ 0 m`.

**Acceptance:** prevent or defer printing until a real map frame is available;
choose a useful initial extent for a single/clustered track and reports. The PDF
must contain the map, readable scale, legend, scenario DTG and classification.
Verify immediate printing after opening Products and after changing selections,
as well as an empty situation and widely separated tracks. Do not certify a
legend-only PDF as a successful graphic product.

### 4. Validate with a staff audience

**Acceptance:** White, Blue and Red operators complete briefing → IPB → collection
→ reporting → evidence → track assessment → INTSUM using the role guides without
API setup or database edits. Record points needing assistance and fix demonstrated
workflow blockers before expanding the feature list. Exercise archive/reset/restore
with members' browsers open, on disposable state.
