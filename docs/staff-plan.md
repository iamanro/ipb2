# IPB + intelligence staff: plan for items 1–7

Goal: the app can run an exercise intelligence cell end to end. That means the terrain and threat IPB, a current enemy situation on the map, geolocated reporting, a collection plan, time-phased event templates, doctrinal graphics, measurement, products, and several logged-in users with roles.

Doctrine anchors: ATP 2-01.3 (IPB), ATP 2-01 (collection management / ISR synchronization), FM 2-0, APP-6(D)/MIL-STD-2525E symbology, ADP 1-02 graphics.

## Items → deliverables

1. **Units on the map.** A shared SIDC symbol picker. IPB threats get a SIDC and an ORBAT link. SITEMP unit symbols are placed per COA. The **current situation** (enemy/unknown/friendly tracks with a time and position history) is app-wide and owned by Exercise; it is shown on the Exercise Situation map and as an IPB overlay.
2. **Reports with location.** Reports carry lon/lat and a type (free / SPOTREP / SALUTE) with structured fields and a reported SIDC. They are plotted on the maps. They are linked to NAIs automatically by point-in-polygon, and they can update a track. Injects carry the same report payload, including location.
3. **Collection plan.** IPB NAIs and TAIs are imported with geometry; SIRs reference real NAIs. Collectors (discipline, unit, range, availability) are tasked against SIR × NAI × time window. There is an ISR synchronization matrix (a Gantt over scenario time) and generated SOR text.
4. **Multi-user.**
   - Localhost by default: done, `npm run dev` binds 127.0.0.1.
   - A LAN mode that requires login.
   - Roles: game-master > collection-manager > analyst > observer, enforced on the server.
   - A central audit trail of who changed what.
   - Live updates (SSE), so every browser refreshes after anyone's change.
5. **Graphics and measurement.**
   - Tactical graphics: PL, boundary, axis of advance, direction of attack, OBJ/AA/BP/EA, obstacles (minefield, obstacle line, block/fix/turn/disrupt).
   - Measure distance, area and bearing (degrees and mils).
   - Range rings, manual or from parsed WEG weapon ranges.
6. **Time.**
   - A study H-hour and phases.
   - Event times as DTG or H±offset (`src/dtg.js`, done).
   - Decision points linked to NAI/TAI with time windows.
   - A time-ordered event template and matrix with a timeline and a "now" marker from the scenario clock.
7. **Products and exchange.**
   - INTSUM: an auto-filled, editable draft that can be saved and printed.
   - Graphic INTSUM: a map snapshot of the situation plus a legend.
   - SPOTREP/SALUTE print.
   - IPB export to GeoJSON/KML and import from GeoJSON/KML.
   - An ASCOPE × PMESII-PT civil considerations matrix.
   - A weather effects matrix (systems × forecast blocks, with editable thresholds).
   - A classification marking on every print.

## Waves

- **Wave 0 (done by lead):** localhost binding; `src/dtg.js` + tests.
- **Wave 1 (parallel):** Access, MapKit, Symbols, IpbServer, ExerciseServer, EquipmentRanges. Servers and shared libraries only.
- **Wave 2 (parallel, after wave 1):** IpbClientA, IpbClientB, ExerciseClientA, ExerciseClientB. UI only, built on wave 1 contracts.
- **Wave 3 (lead):** integration, real-browser end-to-end tests, a security review, README.

## File ownership (wave 1)

| Agent           | Owns                                                                                                                                                                  | May touch surgically                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Access          | `server/auth.js`, `server/access.js`, `server/live.js`, `server/tools/users.mjs`, `src/session.js`, `src/live.js`, login UI in `src/` + `index.html`, `server/api.js` | `package.json` scripts, `src/main.js`, `src/shell.css`, README |
| MapKit          | `src/map.js`, new `src/tactical.js`, new `src/measure.js`                                                                                                             | README                                                         |
| Symbols         | new `src/symbols/*` (moved from `modules/orbat/client/sidc.js`, `symbology.js`, `symbol.js`), `modules/orbat/client/*` imports                                        | README                                                         |
| IpbServer       | `modules/ipb/server/*`, `server/state.js` (rebuild-migration support)                                                                                                 | README                                                         |
| ExerciseServer  | `modules/exercise/server/*`                                                                                                                                           | README                                                         |
| EquipmentRanges | `modules/equipment/server/*` (new `ranges.js`)                                                                                                                        | README                                                         |

## Contracts

### C1 Time (`src/dtg.js`, done)

`formatDtg(ms)` → `251430ZSEP26`; `parseDtg(text, ref)`; `formatHOffset(min)` / `parseHOffset(text)`; `parsePlannedTime(text, ref)` → `{at}` | `{offset}` | null; `resolveTime({at, offset}, hHour)`; `formatPlannedTime(time, hHour)`. Server stores absolute times as ISO strings and offsets as integer minutes. Server code may import `src/dtg.js` (pure, no DOM).

### C2 Live updates

- Server `server/live.js`: `publish(event)`; `GET /api/live` is an SSE stream, handled in `api.js` before module dispatch.
- After every successful (status < 400) non-GET `/api/<module>/…` request, `api.js` publishes `{ module, method, route, client, user, at }`. `client` is the `X-Client-Id` request header. Modules need no changes.
- Client `src/live.js` exports:
  - `clientId`: a random id per tab; every module's fetch helper MUST send it as the `X-Client-Id` header;
  - `subscribe(filter, handler)` → unsubscribe. There is one shared EventSource with auto-reconnect, and events whose `client === clientId` are dropped.
- A subscriber refetches what it shows. There is no field-level merge; last write wins.

### C3 Access

- **Modes:** `IPB_AUTH=off|on`. The default is `off` when the server is bound to a loopback host and `on` otherwise; `npm run dev:lan` / `start:lan` bind `::` with `IPB_AUTH=on`.
  - `off`: every request acts as `{ name: 'local', role: 'game-master' }`.
  - `on` with no users: `/api/*` answers 503 with the command that creates one.
- **Users:** `server/tools/users.mjs add <name> --role <role>` (prompts for the password; scrypt), plus `list`, `passwd`, `remove`. Stored in `stateDirectory('auth', server/state)/auth.db`: users, sessions, audit.
- **Session and endpoints:** a cookie `ipb_session` (HttpOnly, SameSite=Strict, 12 h sliding). `POST /api/auth/login {name,password}`, `POST /api/auth/logout`, `GET /api/auth/me` → `{ mode, user: {name, role} | null }`. Logins are rate-limited per IP.
- **CSRF:** a non-GET request must have `Content-Type: application/json` (or no body) and, if an `Origin` header is present, it must match the host.
- **Roles:** `observer` < `analyst` < `collection-manager` < `game-master`. `server/access.js` `requiredRole(moduleId, method, route)` is the single source of truth:
  - `GET` → observer.
  - exercise `clock`, `scenario-events*`, `scenario-tick`, `scenarios*`, `scenario-countries*`, `scenario-places*`, `roster*` → game-master.
  - exercise `collectors*`, `taskings*` → collection-manager.
  - all other mutations → analyst.
  - Unknown routes → analyst.
- **Audit:** every mutation → `audit(at, user, method, path, status, client)`; `GET /api/auth/audit` (game-master).
- **Client:** `src/session.js`: `await loadSession()`, `currentUser()`, `can(role)`. When the session is missing (401), the shell shows a login screen; a user chip with sign-out sits in the masthead. Wave 2 UIs hide or disable controls the role can't use; the server enforces anyway.

### C4 Symbols (`src/symbols/`)

- The SIDC is always 20-digit numeric APP-6(D)/2525E.
- Moved from ORBAT, with ORBAT migrated to import them (no copies left behind): `symbology.js` tables and `sidc.js` helpers.
- New in `symbol.js`: `symbolCanvas(sidc, { size, designation, dtg })` and `symbolSvg(…)`.
- New `picker.js`: `openSymbolPicker({ initial, affiliation, title })` → `Promise<sidc | null>`. It is a modal dialog: affiliation, dimension, status (present/planned), function search, echelon, and a live preview.
- Helpers:
  - `withAffiliation(sidc, 'hostile'|'friendly'|'neutral'|'unknown')`;
  - `withStatus(sidc, 'present'|'planned')` (planned = the dashed "anticipated" frame);
  - `withEchelon(sidc, echelonName)`, where the echelon names are the IPB `ECHELONS` list;
  - `affiliationOf(sidc)`.
- `defaultThreatSidc(echelonName)` = hostile land unit, infantry, with that echelon.

### C5 Map (`src/map.js`), additions only; existing API stays

- **Feature kinds rendered:**
  - `symbol`: a Point with `properties.sidc`, plus optional `designation` and `dtg` via milsymbol modifiers.
  - `graphic`: a line or polygon with `properties.graphic` (a key of `TACTICAL_GRAPHICS`), `properties.name`, `properties.affiliation`.
  - `range-ring`: a Point with `properties.radii` (metres, ascending) and optional `properties.ringLabels`.
- `src/tactical.js` exports `TACTICAL_GRAPHICS`: `{ key: { label, geometry: 'line'|'polygon', labelFormat, style } }` with at least phase-line, boundary, axis-of-advance, direction-of-attack, objective, assembly-area, battle-position, engagement-area, minefield, obstacle-line, block, fix, turn, disrupt. Colour follows the affiliation (friendly #3d8bff, hostile #ff4d4d, neutral #3fbf5f, unknown #e6c229, none = ink).
- `startDraw` accepts `{ graphic }` so sketches preview in the graphic's style.
- **Measure:** `startMeasure({ mode: 'distance'|'area'|'bearing', onResult })` / `stopMeasure()`, with live on-map labels:
  - distance: per segment and total;
  - area: km²/ha;
  - bearing: true degrees and mils (6400).
  - Geodesic via `ol/sphere`. Escape stops it. Nothing is persisted.
- **Situation overlay:** `setSituation({ tracks, reports } | null, { onSelect })`.
  - Tracks: `[{ id, sidc, designation, lon, lat, observed_at, status, history: [{lon, lat, observed_at}] }]`. Status `suspected` → planned (dashed) frame; `destroyed`/`lost` → faded.
  - Reports: `[{ id, lon, lat, report_type, occurred_at, reliability, credibility }]`, drawn as small report markers.
  - `onSelect({ kind: 'track'|'report', id })`.
- `exportCanvas()` includes the situation, graphics and range rings.

### C6 IPB server (`/api/ipb`)

- **`server/state.js`:** a migration may be `{ sql, rebuild: true }`. It runs outside the transaction with `PRAGMA foreign_keys=OFF`, then `PRAGMA foreign_key_check` (throw on violations), then foreign keys back ON, per SQLite's 12-step ALTER procedure. Plain strings behave as today.
- **features:**
  - `layer` adds `unit`, `graphic`, `range-ring`; `kind` adds `graphic`, `range-ring`.
  - A table rebuild keeps ids, so `events.nai_feature_id` survives.
  - Validation: `unit` needs a `symbol` kind with a valid `properties.sidc`; `graphic` needs a valid `properties.graphic` key, geometry matching its line/polygon type, and an optional `coa_id`; `range-ring` needs a Point with `radii` of 1–8 positive numbers ≤ 100 km.
  - `properties.coa_id` ties any feature to a COA (the SITEMP layering).
- **threats:** + `sidc` (validated, default from the echelon), + `orbat_unit_id` (a loose ref), + `hpt` (0/1). Threats are no longer drawn from the old `threat` feature layer. If that layer has rows, migrate them to `unit`; otherwise drop the layer from the UI.
- **studies:** + `h_hour` (ISO or NULL), + `classification` (text, default `UNCLASSIFIED // EXERCISE`), + `weather_thresholds` (JSON or NULL = client defaults).
- **phases:** `(id, study_id, name, start_offset, end_offset, ordinal)`, offsets in minutes (end may be NULL).
- **events:** + `expected_at` (ISO), + `expected_offset` (minutes). At most one is set. The migration parses the old `expected_time` with `parsePlannedTime`; unparseable text is appended to `note` as "Time: <text>", then `expected_time` is DROPPED (clean cutover). + `tai_feature_id` (FK features, SET NULL), + `decision_point_id` (FK, SET NULL).
- **decision_points:** `(id, study_id, name, description, coa_id NULL, nai_feature_id NULL, tai_feature_id NULL, earliest_at/earliest_offset, latest_at/latest_offset, decision TEXT, ordinal)`.
- **civil_considerations:** `(id, study_id, ascope, pmesii, text)`. `ascope` ∈ areas|structures|capabilities|organizations|people|events; `pmesii` ∈ political|military|economic|social|information|infrastructure|physical-environment|time; unique (study, ascope, pmesii). The API upserts a cell.
- **Endpoints:**
  - CRUD for `phases`, `decision-points`, `civil-considerations` in the existing children pattern.
  - `GET studies/:id/export.geojson` (a FeatureCollection with every feature and its properties, plus `properties.layer`/`kind`/`label`).
  - `GET studies/:id/export.kml` (Placemarks in one Folder per layer, simple styles, the SIDC in ExtendedData).
  - `POST studies/:id/features/bulk {features:[…]}` (≤ 2000, validated like single creates, all or nothing). The client parses KML/GeoJSON into this.
- `GET studies/:id` returns all of the new children.

### C7 Exercise server (`/api/exercise`)

- **reports:** + `lon`, `lat` (both or neither), + `report_type` (`free`|`spotrep`|`salute`, default free), + `fields` (JSON; salute: `size, activity, location, unit, time, equipment`; spotrep: `size, activity, location, unit, time, equipment, remarks`), + `sidc` (nullable, validated), + `nai_id` (FK nais, SET NULL), + `track_id` (FK tracks, SET NULL). On create or location change, if `nai_id` isn't given, set it to the first NAI polygon containing the point (or within 250 m of a point NAI).
- **nais:** `(id, source UNIQUE, study_id, feature_id, kind 'nai'|'tai', label, geometry JSON)`. They are filled by the IPB import, whose payload adds `nais: [{id, label, kind, geometry}]` (TAIs included) and, optionally, `decision_points`. SIRs get `nai_id` (FK, SET NULL), set by the import instead of text-only.
- **tracks:** `(id, sidc, designation, status 'confirmed'|'suspected'|'destroyed'|'lost', lon, lat, observed_at, notes, created_at, updated_at)`. **track_positions:** `(id, track_id CASCADE, lon, lat, observed_at, report_id SET NULL)`.
  - CRUD; `POST tracks/:id/positions {lon, lat, observed_at, report_id?}` updates the head position when it is newer.
  - `GET tracks` includes `history`.
- **collectors:** `(id, name, discipline 'HUMINT'|'SIGINT'|'IMINT'|'GEOINT'|'OSINT'|'MASINT'|'UAS'|'RECCE'|'OP'|'OTHER', unit, range_km NULL, available_from NULL, available_to NULL, notes)`.
- **taskings:** `(id, collector_id CASCADE, sir_id CASCADE, nai_id SET NULL, start_at, end_at, status 'planned'|'tasked'|'active'|'complete'|'cancelled', report_id NULL, notes)`.
  - `GET taskings` includes `sor`, generated text: "COLLECTOR x: collect SIR y at NAI z from DTG to DTG; report NLT LTIOV".
  - `GET collection/conflicts` → overlapping taskings of the same collector and taskings outside collector availability.
- **scenario_events:** a `report` payload is validated with the report validator, including location/type/fields/sidc. Firing creates that report.
- **intsums:** `(id, period_start, period_end, dtg, author, sections JSON {situation, significant_activity, pir_status, assessment, outlook}, created_at, updated_at)`. CRUD; `GET products/intsum-draft?from&to` → the auto-filled sections: track changes, reports in the period (type/location as MGRS/Admiralty), PIR fulfillment, and events observed.
- All times are ISO; scenario time comes from the clock.

### C8 Equipment ranges (`/api/equipment`)

- `GET cards/:identifier/ranges` → `[{ system, kind: 'effective'|'maximum'|'minimum'|'sight'|'other', min_m, max_m, raw }]`.
  - Parsed from `properties` whose name matches /range/i, units m or km, values like `2,000-3,000`, `200-1,800m`, `1,220 m`; `INA` and non-distance values are skipped.
  - `system` = the parent section path, e.g. "Main Armament › Ammunition (Option 1)".
  - Frequency, traverse, elevation and cruising/ferry/operational ranges are excluded (not weapon ranges; keep an explicit list).
- `POST ranges {identifiers: [...]}` → a map for batch use.

## Wave 2 (clients)

- **IpbClientA:**
  - step 1: ASCOPE×PMESII matrix and weather effects matrix (thresholds editable, forecast-driven);
  - map toolbar: tactical graphics palette, measure tool, range rings (manual, or "weapon ranges" from a threat's WEG card via C8);
  - KML/GeoJSON import/export UI; classification marking in print.
- **IpbClientB:**
  - step 3: threat SIDC via the picker, "Import from ORBAT", HPT flag;
  - step 4: place units on the SITEMP per COA (symbols from threats or the picker), COA graphics, H-hour + phases, DTG/offset event times, decision points, a time-ordered event template/matrix with a timeline and a now-marker from `/api/exercise/clock`;
  - a Situation overlay toggle (from `GET /api/exercise/tracks` + reports), with live refresh.
- **ExerciseClientA:**
  - reports: location (MGRS entry or map pick), type forms (SPOTREP/SALUTE), SIDC, auto-NAI shown, "update/create track from report";
  - a **Situation** tab map with tracks/reports/NAIs, a track editor and history;
  - injects with location and type;
  - live refresh.
- **ExerciseClientB:**
  - a **Collection** tab: collectors, taskings, the ISR sync matrix (Gantt over scenario time, rows SIR×NAI, bars per collector, a now line, conflicts highlighted), SOR print;
  - a **Products** tab: INTSUM draft → edit → save → print, graphic INTSUM (situation map + legend), SPOTREP/SALUTE print;
  - role-aware UI via `can()`.

## Definition of done (every item)

Server tests for the invariants; a real-browser smoke test with screenshots; `npx vp lint` clean; README updated; no console errors; the existing suite (currently 337 tests) green; the existing e2e green.

## Wave 1 as implemented (binding for wave 2)

- **All 670 tests green; lint clean.** Your real state DBs are migrated: ipb v10, exercise v8.
- **C2/C3:**
  - `src/session.js`: `loadSession`, `sessionMode`, `currentUser`, `can(role)`, `onUnauthorized`, `handleUnauthorized`.
  - `src/live.js`: `clientId`, `subscribe(filter, handler)`.
  - Every module's `requestJson` already sends `X-Client-Id` and calls `handleUnauthorized` on a 401.
  - The IPB view already refetches the open study on live events (`refetchOpenStudy`).
- **C4:** `src/symbols/{sidc,symbology,symbol,picker}.js`; `openSymbolPicker({initial, affiliation, title})`. `symbolCanvas` is browser-only; `symbolSvg` is a string.
- **C5 `src/map.js`:** `startDraw(kind, {graphic, affiliation, name})`, `startMeasure({mode,onResult})`/`stopMeasure()`, `setSituation(data|null,{onSelect})`. Feature kinds `graphic` and `range-ring` render; `symbol` features use `properties.sidc/designation/dtg`. `src/tactical.js`: `TACTICAL_GRAPHICS`, `graphicLabel`, `graphicGeometryType`, `graphicColor`.
- **C6 IPB server deviations and notes:**
  - Events still accept `expected_time` as INPUT ONLY (store.js `absorbLegacyExpectedTime`/`preprocessBody`). Wave 2 must switch the client to `expected_at`/`expected_offset` and DELETE that input path.
  - `GET studies/:id` lists `decision_points` (snake_case); routes use `decision-points`.
  - Unit features' `properties.sidc` is validated but not canonicalized; wave 2 should canonicalize it server-side.
  - `GRAPHIC_GEOMETRY` (server) matches `TACTICAL_GRAPHICS` geometry types exactly (checked).
- **C7 exercise server:**
  - Import body `nais[]` accepts `{id,label,kind:'nai'|'tai',geometry}`. The current client sends only `{id,label}` for layer `nai`; wave 2 must send TAIs plus geometry.
  - `GET collection/conflicts` → `{overlaps:[{collector_id,tasking_ids}], outside:[{collector_id,tasking_id}]}`.
  - The SIDC is canonicalized via `src/symbols/sidc.js`.
- **C8:** `GET /api/equipment/cards/:id/ranges`, `POST /api/equipment/ranges {identifiers}`. Weapon ranges exclude whole Automotive/Communications/Propulsion/Radar/Performance sections, not only excluded names.
