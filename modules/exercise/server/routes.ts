import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { announce, EXERCISE_CONTROL } from '../../../server/dispatch.ts';
import { HttpError } from '../../../server/http.ts';
import { dataDirectory } from '../../../server/state.ts';
import state from './state.ts';
import { openStore } from './store.ts';

const DATA_ROOT = dataDirectory(
  state.id,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'),
);
const REGIONS_FILE = path.join(DATA_ROOT, 'regions.json');

// A country's `geometry` can be as large as 2 MB before the store rejects it;
// the dispatcher's default 1 MB body cap would trip first, so these two
// routes get room for that plus the rest of the body and JSON overhead.
const COUNTRY_BODY_LIMIT = 3 << 20;

/**
 * The scenario clock fires due injects here, on the server: `connect`
 * hands this module a `runAs` once, and the ticker calls the `fire` route
 * through it for each event whose trigger time has arrived — one call per
 * event, so each is announced only to its own inject's cells
 * (docs/adr/0002-item-scoped-requests.md), never a flat "everyone who got
 * anything this tick" leak.
 */
const TICK_MS = 5000;
let ticker: ReturnType<typeof setInterval> | null = null;
let store;
state.onClose(() => {
  store?.close();
  store = undefined;
});

function ensureStore() {
  store ??= openStore(state.path, { regionsFile: REGIONS_FILE });
  return store;
}

function parseId(text) {
  return Number.parseInt(text, 10);
}

/** `onOwnership` for every releasable/reassignable item kind: the same
 * activity-log row `store.js`'s own `mutate()` writes for any other
 * mutation, written directly (no `transact` — this already runs inside the
 * dispatcher's own transaction for the release/reassign, per contract). */
function onOwnership({ kind, action, after }) {
  const currentStore = ensureStore();
  if (kind === 'report') currentStore.touchRequirementsForReport(after.id);
  currentStore.database
    .prepare(
      'INSERT INTO activity (at, action, target, detail, owner_cell, releasable_to) VALUES (?, ?, ?, NULL, ?, ?)',
    )
    .run(
      new Date().toISOString(),
      `${kind}:${action}`,
      String(after.id),
      after.owner_cell,
      after.releasable_to,
    );
}

export default {
  id: state.id,
  close() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    state.close();
  },
  database: () => ensureStore().database,

  items: {
    requirement: {
      table: 'requirements',
      path: 'requirements',
      label: 'Requirement',
      shape: (row, { access }) => ensureStore().shapeRequirement(row, { access }),
      revision: true,
      onOwnership,
    },
    report: {
      table: 'reports',
      path: 'reports',
      label: 'Report',
      shape: (row) => ensureStore().shapeReport(row),
      revision: true,
      onOwnership,
    },
    rfi: {
      table: 'rfis',
      path: 'rfis',
      label: 'RFI',
      shape: (row) => ensureStore().shapeRfi(row),
      onOwnership,
    },
    track: {
      table: 'tracks',
      path: 'tracks',
      label: 'Track',
      shape: (row) => ensureStore().shapeTrack(row),
      onOwnership,
    },
    collector: {
      table: 'collectors',
      path: 'collectors',
      label: 'Collector',
      shape: (row) => ensureStore().shapeCollector(row),
      onOwnership,
    },
    tasking: {
      table: 'taskings',
      path: 'taskings',
      label: 'Tasking',
      shape: (row) => ensureStore().shapeTasking(row),
      onOwnership,
    },
    intsum: {
      table: 'intsums',
      path: 'intsums',
      label: 'INTSUM',
      shape: (row) => ensureStore().shapeIntsum(row),
      onOwnership,
    },
    // List-only (docs/adr/0002-item-scoped-requests.md contract): no `path`,
    // so no release/reassign is generated — matches the surface these two
    // already had (imported/fired, never released or reassigned by hand).
    nai: { table: 'nais', label: 'NAI', shape: (row) => ensureStore().shapeNai(row) },
    message: {
      table: 'messages',
      label: 'Message',
      shape: (row) => ensureStore().shapeMessage(row),
    },
  },

  parts: {
    sir: { table: 'sirs', item: 'requirement', column: 'requirement_id', label: 'SIR' },
    indicator: {
      table: 'indicators',
      item: 'requirement',
      column: 'requirement_id',
      label: 'Indicator',
    },
    evidence: {
      table: 'evidence_links',
      item: 'requirement',
      column: 'requirement_id',
      label: 'Evidence link',
    },
  },

  routes: [
    // -- requirements tree: SIRs, indicators, evidence links ------------------
    {
      method: 'GET',
      path: 'requirements',
      verb: 'list',
      handler: ({ access }) => ensureStore().listRequirements(access),
    },
    {
      method: 'POST',
      path: 'requirements',
      verb: 'create',
      item: 'requirement',
      handler: ({ body, owner, access }) => ensureStore().createRequirement(owner, body, access),
    },
    {
      method: 'GET',
      path: 'requirements/:item',
      verb: 'see',
      item: 'requirement',
      handler: ({ item, access }) => ensureStore().shapeRequirement(item, { access }),
    },
    {
      method: 'PATCH',
      path: 'requirements/:item',
      verb: 'change',
      item: 'requirement',
      handler: ({ item, body, access }) => ensureStore().updateRequirement(item, body, access),
    },
    {
      method: 'DELETE',
      path: 'requirements/:item',
      verb: 'change',
      item: 'requirement',
      handler: ({ item, body }) => ensureStore().deleteRequirement(item, body),
    },

    {
      method: 'POST',
      path: 'requirements/:item/sirs',
      verb: 'change',
      item: 'requirement',
      handler: ({ item, body, access }) => ensureStore().createSir(item, body, access),
    },
    {
      method: 'PATCH',
      path: 'requirements/:item/sirs/:part',
      verb: 'change',
      item: 'requirement',
      part: 'sir',
      handler: ({ item, part, body, access }) => ensureStore().updateSir(item, part, body, access),
    },
    {
      method: 'DELETE',
      path: 'requirements/:item/sirs/:part',
      verb: 'change',
      item: 'requirement',
      part: 'sir',
      handler: ({ item, part, body }) => ensureStore().deleteSir(item, part, body),
    },

    {
      method: 'POST',
      path: 'requirements/:item/indicators',
      verb: 'change',
      item: 'requirement',
      handler: ({ item, body }) => ensureStore().createIndicator(item, body),
    },
    {
      method: 'PATCH',
      path: 'requirements/:item/indicators/:part',
      verb: 'change',
      item: 'requirement',
      part: 'indicator',
      handler: ({ item, part, body }) => ensureStore().updateIndicator(item, part, body),
    },
    {
      method: 'DELETE',
      path: 'requirements/:item/indicators/:part',
      verb: 'change',
      item: 'requirement',
      part: 'indicator',
      handler: ({ item, part, body }) => ensureStore().deleteIndicator(item, part, body),
    },

    {
      method: 'POST',
      path: 'requirements/:item/evidence',
      verb: 'change',
      item: 'requirement',
      handler: ({ item, body, access }) => ensureStore().createEvidenceLink(item, body, access),
    },
    {
      method: 'DELETE',
      path: 'requirements/:item/evidence/:part',
      verb: 'change',
      item: 'requirement',
      part: 'evidence',
      handler: ({ item, part, body }) => ensureStore().deleteEvidenceLink(item, part, body),
    },

    {
      method: 'POST',
      path: 'import/ipb',
      verb: 'create',
      item: 'requirement',
      handler: ({ body, owner }) => ensureStore().importIpbStudy(owner, body),
    },

    {
      method: 'GET',
      path: 'nais',
      verb: 'list',
      handler: ({ access }) => ensureStore().listNais(access),
    },

    // -- reports & evidence ----------------------------------------------------
    {
      method: 'GET',
      path: 'reports',
      verb: 'list',
      handler: ({ access }) => ensureStore().listReports(access),
    },
    {
      method: 'POST',
      path: 'reports',
      verb: 'create',
      item: 'report',
      handler: ({ body, owner, access }) => ensureStore().createReport(owner, body, access),
    },
    {
      method: 'GET',
      path: 'reports/:item',
      verb: 'see',
      item: 'report',
      handler: ({ item }) => ensureStore().shapeReport(item),
    },
    {
      method: 'PATCH',
      path: 'reports/:item',
      verb: 'change',
      item: 'report',
      handler: ({ item, body, access }) => ensureStore().updateReport(item, body, access),
    },
    {
      method: 'DELETE',
      path: 'reports/:item',
      verb: 'change',
      item: 'report',
      handler: ({ item, body }) => ensureStore().deleteReport(item, body),
    },

    // -- current situation: tracks ----------------------------------------------
    {
      method: 'GET',
      path: 'tracks',
      verb: 'list',
      handler: ({ access }) => ensureStore().listTracks(access),
    },
    {
      method: 'POST',
      path: 'tracks',
      verb: 'create',
      item: 'track',
      handler: ({ body, owner }) => ensureStore().createTrack(owner, body),
    },
    {
      method: 'GET',
      path: 'tracks/:item',
      verb: 'see',
      item: 'track',
      handler: ({ item }) => ensureStore().shapeTrack(item),
    },
    {
      method: 'PATCH',
      path: 'tracks/:item',
      verb: 'change',
      item: 'track',
      handler: ({ item, body }) => ensureStore().updateTrack(item, body),
    },
    {
      method: 'DELETE',
      path: 'tracks/:item',
      verb: 'change',
      item: 'track',
      handler: ({ item }) => ensureStore().deleteTrack(item),
    },
    {
      method: 'POST',
      path: 'tracks/:item/positions',
      verb: 'change',
      item: 'track',
      handler: ({ item, body, access }) => ensureStore().addTrackPosition(item, body, access),
    },

    // -- collection plan: collectors + taskings ---------------------------------
    {
      method: 'GET',
      path: 'collectors',
      verb: 'list',
      handler: ({ access }) => ensureStore().listCollectors(access),
    },
    {
      method: 'POST',
      path: 'collectors',
      verb: 'create',
      item: 'collector',
      role: 'collection-manager',
      handler: ({ body, owner }) => ensureStore().createCollector(owner, body),
    },
    {
      method: 'GET',
      path: 'collectors/:item',
      verb: 'see',
      item: 'collector',
      handler: ({ item }) => ensureStore().shapeCollector(item),
    },
    {
      method: 'PATCH',
      path: 'collectors/:item',
      verb: 'change',
      item: 'collector',
      role: 'collection-manager',
      handler: ({ item, body }) => ensureStore().updateCollector(item, body),
    },
    {
      method: 'DELETE',
      path: 'collectors/:item',
      verb: 'change',
      item: 'collector',
      role: 'collection-manager',
      handler: ({ item }) => ensureStore().deleteCollector(item),
    },

    {
      method: 'GET',
      path: 'taskings',
      verb: 'list',
      handler: ({ access }) => ensureStore().listTaskings(access),
    },
    {
      method: 'POST',
      path: 'taskings',
      verb: 'create',
      item: 'tasking',
      role: 'collection-manager',
      handler: ({ body, owner, access }) => ensureStore().createTasking(owner, body, access),
    },
    {
      method: 'GET',
      path: 'taskings/:item',
      verb: 'see',
      item: 'tasking',
      handler: ({ item }) => ensureStore().shapeTasking(item),
    },
    {
      method: 'PATCH',
      path: 'taskings/:item',
      verb: 'change',
      item: 'tasking',
      role: 'collection-manager',
      handler: ({ item, body, access }) => ensureStore().updateTasking(item, body, access),
    },
    {
      method: 'DELETE',
      path: 'taskings/:item',
      verb: 'change',
      item: 'tasking',
      role: 'collection-manager',
      handler: ({ item }) => ensureStore().deleteTasking(item),
    },
    {
      method: 'GET',
      path: 'collection/conflicts',
      verb: 'list',
      handler: ({ access }) => ensureStore().listCollectionConflicts(access),
    },

    // -- products: INTSUM --------------------------------------------------------
    {
      method: 'GET',
      path: 'intsums',
      verb: 'list',
      handler: ({ access }) => ensureStore().listIntsums(access),
    },
    {
      method: 'POST',
      path: 'intsums',
      verb: 'create',
      item: 'intsum',
      handler: ({ body, owner }) => ensureStore().createIntsum(owner, body),
    },
    {
      method: 'GET',
      path: 'intsums/:item',
      verb: 'see',
      item: 'intsum',
      handler: ({ item }) => ensureStore().shapeIntsum(item),
    },
    {
      method: 'PATCH',
      path: 'intsums/:item',
      verb: 'change',
      item: 'intsum',
      handler: ({ item, body }) => ensureStore().updateIntsum(item, body),
    },
    {
      method: 'DELETE',
      path: 'intsums/:item',
      verb: 'change',
      item: 'intsum',
      handler: ({ item }) => ensureStore().deleteIntsum(item),
    },
    {
      method: 'GET',
      path: 'products/intsum-draft',
      verb: 'none',
      handler: ({ query, access }) =>
        ensureStore().draftIntsum(access, query.get('from'), query.get('to')),
    },

    // -- RFI ----------------------------------------------------------------------
    {
      method: 'GET',
      path: 'rfis',
      verb: 'list',
      handler: ({ access }) => ensureStore().listRfis(access),
    },
    {
      method: 'POST',
      path: 'rfis',
      verb: 'create',
      item: 'rfi',
      handler: ({ body, owner, access }) => ensureStore().createRfi(owner, body, access),
    },
    {
      method: 'GET',
      path: 'rfis/:item',
      verb: 'see',
      item: 'rfi',
      handler: ({ item }) => ensureStore().shapeRfi(item),
    },
    {
      method: 'PATCH',
      path: 'rfis/:item',
      verb: 'change',
      item: 'rfi',
      handler: ({ item, body }) => ensureStore().updateRfi(item, body),
    },
    {
      method: 'DELETE',
      path: 'rfis/:item',
      verb: 'change',
      item: 'rfi',
      handler: ({ item }) => ensureStore().deleteRfi(item),
    },
    {
      method: 'POST',
      path: 'rfis/:item/transition',
      verb: 'change',
      item: 'rfi',
      handler: ({ item, body, access }) => ensureStore().transitionRfi(item, body, access),
    },

    {
      method: 'GET',
      path: 'messages',
      verb: 'list',
      handler: ({ access }) => ensureStore().listMessages(access),
    },

    // -- scenario clock & events (White/game-master control) --------------------
    { method: 'GET', path: 'clock', verb: 'none', handler: () => ensureStore().readClock() },
    {
      method: 'PATCH',
      path: 'clock',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ body, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may control the scenario clock.');
        return ensureStore().patchClock(body);
      },
    },

    // Gated at game-master even for a plain GET (unlike every other
    // exercise read): inject text the training audience must not see ahead
    // of time, or cancelled, at all. `role: 'game-master'` alone only
    // checks the requester's role level, not their cell — a Blue-cell
    // game-master would otherwise pass it, so every one of these also
    // checks `access.white` explicitly.
    {
      method: 'GET',
      path: 'scenario-events',
      verb: 'none',
      role: 'game-master',
      handler: ({ access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may see scenario events.');
        return ensureStore().listScenarioEvents();
      },
    },
    {
      method: 'POST',
      path: 'scenario-events',
      verb: 'none',
      role: 'game-master',
      handler: ({ body, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may schedule scenario events.');
        return ensureStore().createScenarioEvent(body);
      },
    },
    {
      method: 'PATCH',
      path: 'scenario-events/:id',
      verb: 'none',
      role: 'game-master',
      handler: ({ params, body, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may edit scenario events.');
        return ensureStore().updateScenarioEvent(parseId(params.id), body);
      },
    },
    {
      method: 'POST',
      path: 'scenario-events/:id/cancel',
      verb: 'none',
      role: 'game-master',
      handler: ({ params, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may cancel scenario events.');
        ensureStore().cancelScenarioEvent(parseId(params.id));
        return { cancelled: true };
      },
    },
    {
      method: 'POST',
      path: 'scenario-events/:id/fire',
      verb: 'none',
      role: 'game-master',
      reach: 'handler',
      handler: ({ params, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may fire scenario events.');
        const { event, cells } = ensureStore().fireScenarioEvent(parseId(params.id), access);
        return announce(event, cells);
      },
    },

    // -- instructor authoring: story + situations (White-only) ------------------
    //
    // GET is reachable at `observer` (a White observer may read, per the
    // shared contract) but still requires `access.white` — the role check
    // alone doesn't imply the cell. Every mutation requires `game-master`
    // (or admin/off-mode, which `isWhite`/`roleAtLeast` already grant) and
    // the same explicit `access.white` guard, so a Blue-cell game-master
    // never reaches instructor content either.
    {
      method: 'GET',
      path: 'instructor',
      verb: 'none',
      role: 'observer',
      handler: ({ access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may see instructor content.');
        return ensureStore().getInstructorData();
      },
    },
    {
      method: 'PATCH',
      path: 'instructor/story',
      verb: 'none',
      role: 'game-master',
      handler: ({ body, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may edit the story.');
        return ensureStore().patchStory(body ?? {});
      },
    },
    {
      method: 'POST',
      path: 'instructor/situations',
      verb: 'none',
      role: 'game-master',
      handler: ({ body, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may create situations.');
        return ensureStore().createSituation(body ?? {});
      },
    },
    {
      method: 'PATCH',
      path: 'instructor/situations/:id',
      verb: 'none',
      role: 'game-master',
      handler: ({ params, body, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may edit situations.');
        return ensureStore().updateSituation(parseId(params.id), body ?? {});
      },
    },
    {
      method: 'DELETE',
      path: 'instructor/situations/:id',
      verb: 'none',
      role: 'game-master',
      handler: ({ params, access }) => {
        if (!access.white) throw new HttpError(403, 'Only White may delete situations.');
        ensureStore().deleteSituation(parseId(params.id));
        return { deleted: true };
      },
    },

    // -- the one active exercise scenario (fictional countries + renamed places) --
    { method: 'GET', path: 'regions', verb: 'none', handler: () => ensureStore().getRegions() },
    {
      method: 'GET',
      path: 'scenarios',
      verb: 'none',
      handler: () => ({ items: ensureStore().listScenarios() }),
    },
    {
      method: 'POST',
      path: 'scenarios',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ body }) => ensureStore().createScenario(body),
    },
    {
      method: 'POST',
      path: 'scenarios/example',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: () => ensureStore().createExampleScenario(),
    },
    {
      method: 'GET',
      path: 'scenarios/:id',
      verb: 'none',
      handler: ({ params }) => ensureStore().getScenario(parseId(params.id)),
    },
    {
      method: 'PATCH',
      path: 'scenarios/:id',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ params, body }) => ensureStore().updateScenario(parseId(params.id), body),
    },
    {
      method: 'DELETE',
      path: 'scenarios/:id',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ params }) => {
        ensureStore().deleteScenario(parseId(params.id));
        return { deleted: true };
      },
    },
    {
      method: 'POST',
      path: 'scenarios/:id/duplicate',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ params }) => ensureStore().duplicateScenario(parseId(params.id)),
    },
    {
      method: 'GET',
      path: 'scenario/active',
      verb: 'none',
      handler: () => ensureStore().getActiveScenario(),
    },
    {
      method: 'POST',
      path: 'scenarios/:id/countries',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      bodyLimit: COUNTRY_BODY_LIMIT,
      handler: ({ params, body }) => ensureStore().createCountry(parseId(params.id), body),
    },
    {
      method: 'PATCH',
      path: 'scenario-countries/:id',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      bodyLimit: COUNTRY_BODY_LIMIT,
      handler: ({ params, body }) => ensureStore().updateCountry(parseId(params.id), body),
    },
    {
      method: 'DELETE',
      path: 'scenario-countries/:id',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ params }) => {
        ensureStore().deleteCountry(parseId(params.id));
        return { deleted: true };
      },
    },
    {
      method: 'POST',
      path: 'scenarios/:id/places',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ params, body }) => ensureStore().createPlace(parseId(params.id), body),
    },
    {
      method: 'PATCH',
      path: 'scenario-places/:id',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ params, body }) => ensureStore().updatePlace(parseId(params.id), body),
    },
    {
      method: 'DELETE',
      path: 'scenario-places/:id',
      verb: 'none',
      role: 'game-master',
      reach: 'everyone',
      handler: ({ params }) => {
        ensureStore().deletePlace(parseId(params.id));
        return { deleted: true };
      },
    },

    // -- AAR ------------------------------------------------------------------
    {
      method: 'GET',
      path: 'activity',
      verb: 'list',
      handler: ({ access }) => ensureStore().listActivity(access),
    },
  ],

  connect({ runAs }) {
    const tick = async () => {
      let due;
      try {
        due = ensureStore().dueScenarioEventIds();
      } catch (error) {
        console.error('[exercise] scenario tick failed:', error);
        return;
      }
      for (const id of due) {
        try {
          await runAs(EXERCISE_CONTROL, 'POST', `scenario-events/${id}/fire`);
        } catch (error) {
          console.error('[exercise] scenario tick failed for event', id, error);
        }
      }
    };
    ticker = setInterval(tick, TICK_MS);
    ticker.unref();
  },
};
