# Phase 1: exercise lifecycle, cells, release

> **Superseded in part** by [ADR 0002](adr/0002-item-scoped-requests.md): the cell rules below (C1, C2, C2b, C6) still hold, but _where_ they are applied changed. `server/access.js` and `request.liveCells` are gone; `server/dispatch.js` resolves the item named in each URL, checks role and cell, generates release/reassign (C3) and announces each change to the item's cells (C4). Evidence links are now parts of the requirement they support.

Decisions (user, 2026-09-26):

- One exercise at a time.
- Cells: White / Blue / Red.
- Roles are per exercise.
- Explicit release per item.
- SQLite stays.

## Model

- **Current exercise**: one record (`name`, `started_at`). An admin can **archive** it (consistent snapshot of the ipb, exercise and orbat state DBs plus metadata), **reset** it (empty ipb/exercise/orbat state, memberships cleared) and **restore** an archive (the current exercise is archived first). Equipment bookmarks and user accounts are not part of an exercise.
- **Users**: an account plus a global `admin` flag. **Membership** in the current exercise: `cell` ∈ white|blue|red and `role` ∈ observer|analyst|collection-manager|game-master. Reset clears memberships.
- **Cell-owned items** carry `owner_cell` and `releasable_to` (a JSON array of cells, never containing the owner). Who sees an item:
  - White members and admins see everything.
  - Others see it when `owner_cell` = their cell, or their cell ∈ `releasable_to`.
- **Global** (not cell-owned, visible to every member): the scenario clock, scenario geography (countries/places, regions), and reference data (terrain, equipment).
- **Existing rows** migrate with `owner_cell = 'white'` and `releasable_to = '[]'`: nothing leaks. White can reassign or release them.

## C1 `request.user` (set by server/api.js for every /api request)

`{ name, admin: boolean, cell: 'white'|'blue'|'red'|null, role: 'observer'|'analyst'|'collection-manager'|'game-master'|null, must_change_password }`

- An admin without a membership acts as `cell: 'white', role: 'game-master'` for exercise data (`effective: true` marks this).
- Off mode (loopback, no auth) acts as `{ name: 'local', admin: true, cell: 'white', role: 'game-master' }`.
- A non-admin with no membership gets **403** "You are not assigned to the current exercise." on every module route (`/api/auth/*` still works).

## C2 `server/policy.js` (Core owns; pure, no I/O)

- `CELLS = ['white', 'blue', 'red']`
- `isWhite(user)`: admin or cell white.
- `canSee(user, item)`: `item = { owner_cell, releasable_to }` (releasable_to may be an array or JSON text).
- `visibilitySql(user, { alias } = {})` → `{ sql, params }`: a WHERE fragment for tables with `owner_cell` / `releasable_to` columns, using `json_each` on `releasable_to`. White → `{ sql: '1=1', params: [] }`.
- `ownerCellForCreate(user, requested)`: White may pick any cell (default white); everyone else gets their own cell (400 if they request another); no cell → 403.
- `canRelease(user, item)`: White, or a member of the owner cell with role ≥ analyst.
- `normalizeRelease(cells, owner)`: validates the cells, drops the owner and duplicates, returns a sorted array; 400 on an unknown cell.
- `liveCellsFor(item)` → `[owner_cell, ...releasable_to]`.
- `roleAtLeast(role, required)` and `ROLES`, moved here from access.js; access.js imports them.

## C2b Release is read-only

`canEdit(user, item)` / `assertCanEdit(user, item)` in `server/policy.js`; `canEditClient(item)` in `src/release.js`.

- Changing a cell-owned item or any child row under it (PATCH, DELETE, adding children, reorder, bulk import into it, indicators, positions, units) takes White or membership of the owning cell. The route's role requirement still applies on top.
- A visible but not editable item answers 403; an invisible one answers 404.
- Cross-links need read on one side and edit on the other. An evidence link needs `canSee(report)` + `canEdit(requirement)`; deleting one needs `canEdit(requirement)`.
- Clients hide edit/delete/add controls when `!canEditClient(item)`.

## C3 Release endpoint convention (per module)

- `POST /api/<module>/<collection>/:id/release {cells: [...]}` **replaces** `releasable_to`.
  - Requires `canRelease` (403 otherwise). Returns the resource. Audited like every mutation.
  - Every cell-owned resource in API responses includes `owner_cell` and `releasable_to` (an array).
- White may also `PATCH` a resource's `owner_cell` (reassign); non-White → 403.
- Child rows (e.g. threats/COAs/events of a study; units of an ORBAT; SIRs/indicators of a requirement; positions of a track) **inherit** the parent's visibility and have no columns of their own.

## C4 Live events

A module handler sets `request.liveCells = liveCellsFor(item)` for mutations of cell-owned items (or the union, for changes that affect several). server/api.js adds `cells` to the published event. server/live.js delivers an event to a stream when:

- the event has no `cells` (a global change), or
- the stream's user is White/admin, or
- the user's cell is in `cells`.

Streams store the user's cell at connect time, and re-check it on the keep-alive tick (a membership change closes the stream; the client reconnects with its new cell).

## C5 Client

`src/session.js`:

- `currentUser()` includes `admin`, `cell`, `role`;
- `can(role)` uses the membership role (admin passes everything);
- `isWhite()`; `cellLabel(cell)`.

`src/release.js` exports:

- `renderCellBadge(cell)`: a small coloured badge with text, White/Blue/Red, never colour-only;
- `renderReleaseControl({ item, onRelease })`: the owner badge, chips for the cells it's released to, and a "Release…" button when `canReleaseClient(item)`, opening an accessible dialog with cell checkboxes (the owner excluded). It calls `onRelease(cells)`, which PATCHes via the module's release endpoint.
- `canReleaseClient(item)`: mirrors C2.

Masthead: the exercise name, the user's cell badge and role. Replace the stale "Local workbench" label: show it only in off mode.

## C6 Exercise lifecycle API (admin only, Core owns)

`server/exerciseLifecycle.js` + routes under `/api/auth/exercise`:

- `GET /api/auth/exercise` → `{ name, started_at, members: n }`; any signed-in user may read the name.
- `PATCH {name}` (admin).
- `GET /api/auth/exercise/archives` (admin) → `[{ id, name, archived_at, sizes }]`.
- `POST /api/auth/exercise/archive {note?}` (admin): VACUUM INTO `$IPB_STATE_ROOT/archives/<ts>-<slug>/{ipb,exercise,orbat}.db` + `meta.json`.
- `POST /api/auth/exercise/reset {name, confirm: '<current name>'}` (admin): always archives first, then empties the exercise. While it runs, other /api requests get 503. It publishes the live event `{module:'auth', route:'exercise/reset'}` so clients reload.
- `POST /api/auth/exercise/restore {archive}` (admin): archives the current exercise, then swaps the archive's DBs in; memberships are kept only for users that still exist. **Emptying or swapping a module's DB**: call that module's `close()` (server/modules.js), delete or replace the files (+ `-wal`/`-shm`); the module's store reopens lazily on the next request.

Memberships API (admin): `GET /api/auth/members`, `PUT /api/auth/members/:name {cell, role}`, `DELETE /api/auth/members/:name`. The users list includes each user's membership.

CLI (`server/tools/users.mjs`): `add <name> [--admin]`, `member <name> --cell <c> --role <r>`, `unmember <name>`; `list` shows the membership.
