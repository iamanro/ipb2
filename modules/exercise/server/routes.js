import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { roleAtLeast } from '../../../server/access.js';
import { HttpError, readJson, sendJson } from '../../../server/http.js';
import { publish } from '../../../server/live.js';
import { LIVE_ALL } from '../../../server/policy.js';
import { dataDirectory, stateDirectory } from '../../../server/state.js';
import { openStore } from './store.js';

const ID = 'exercise';
const STATE_ROOT = stateDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state'),
);
const DATABASE = path.join(STATE_ROOT, 'exercise.db');
const DATA_ROOT = dataDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'),
);
const REGIONS_FILE = path.join(DATA_ROOT, 'regions.json');

function parseId(text) {
  return Number.parseInt(text, 10);
}

// A country's `geometry` can be as large as 2 MB before the store rejects it;
// readJson's default 1 MB body cap would trip first, so these
// two routes get room for that plus the rest of the body and JSON overhead.
const COUNTRY_BODY_LIMIT = 3 << 20;

let store;

/**
 * The scenario clock fires due injects here, on the server: when it was the
 * browsers' job, injects fired only while a game-master (the one role allowed
 * to tick) had the Exercise tab open. A fired inject is announced like any
 * other change, so every open view refreshes.
 */
const TICK_MS = 5000;
let ticker = null;

function tick() {
  try {
    const { fired, liveCells } = store.tickScenario();
    if (!fired.length) return;
    publish({
      module: ID,
      method: 'POST',
      route: 'scenario-tick',
      client: null,
      user: 'scenario clock',
      at: new Date().toISOString(),
      cells: liveCells,
    });
  } catch (error) {
    console.error('[exercise] scenario tick failed:', error);
  }
}

/**
 * Every store mutation of a cell-owned (or child-of-cell-owned) row
 * attaches a `liveCells` array to what it returns (docs/phase1-access.md
 * C4). This lifts that onto `request.liveCells` — server/api.js publishes
 * it as the live event's `cells` — and strips the key so it never leaks
 * into the JSON response.
 */
function withLiveCells(request, result) {
  if (result && typeof result === 'object' && Array.isArray(result.liveCells)) {
    request.liveCells = result.liveCells;
    delete result.liveCells;
  }
  return result;
}

const ROUTES = [
  [
    /^requirements$/,
    {
      GET: (m, request) => store.listRequirements(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createRequirement(request.user, await readJson(request))),
    },
  ],
  [
    /^requirements\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateRequirement(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteRequirement(request.user, parseId(m[1]))),
    },
  ],
  [
    /^requirements\/(\d+)\/release$/,
    {
      POST: async (m, request) => {
        const { cells } = await readJson(request);
        return withLiveCells(request, store.releaseRequirement(request.user, parseId(m[1]), cells));
      },
    },
  ],
  [
    /^import\/ipb$/,
    { POST: async (m, request) => withLiveCells(request, store.importIpbStudy(request.user, await readJson(request))) },
  ],
  [
    /^requirements\/(\d+)\/sirs$/,
    {
      POST: async (m, request) =>
        withLiveCells(request, store.createSir(request.user, parseId(m[1]), await readJson(request))),
    },
  ],
  [
    /^sirs\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateSir(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteSir(request.user, parseId(m[1]))),
    },
  ],
  [
    /^sirs\/(\d+)\/indicators$/,
    {
      POST: async (m, request) =>
        withLiveCells(request, store.createIndicator(request.user, parseId(m[1]), await readJson(request))),
    },
  ],
  [
    /^indicators\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateIndicator(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteIndicator(request.user, parseId(m[1]))),
    },
  ],

  [
    /^reports$/,
    {
      GET: (m, request) => store.listReports(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createReport(request.user, await readJson(request))),
    },
  ],
  [
    /^reports\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateReport(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteReport(request.user, parseId(m[1]))),
    },
  ],
  [
    /^reports\/(\d+)\/release$/,
    {
      POST: async (m, request) => {
        const { cells } = await readJson(request);
        return withLiveCells(request, store.releaseReport(request.user, parseId(m[1]), cells));
      },
    },
  ],
  [
    /^reports\/(\d+)\/links$/,
    {
      POST: async (m, request) =>
        withLiveCells(request, store.createEvidenceLink(request.user, parseId(m[1]), await readJson(request))),
    },
  ],
  [
    /^links\/(\d+)$/,
    {
      DELETE: (m, request) => withLiveCells(request, store.deleteEvidenceLink(request.user, parseId(m[1]))),
    },
  ],

  [/^nais$/, { GET: (m, request) => store.listNais(request.user) }],
  [/^messages$/, { GET: (m, request) => store.listMessages(request.user) }],

  [
    /^tracks$/,
    {
      GET: (m, request) => store.listTracks(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createTrack(request.user, await readJson(request))),
    },
  ],
  [
    /^tracks\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateTrack(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteTrack(request.user, parseId(m[1]))),
    },
  ],
  [
    /^tracks\/(\d+)\/release$/,
    {
      POST: async (m, request) => {
        const { cells } = await readJson(request);
        return withLiveCells(request, store.releaseTrack(request.user, parseId(m[1]), cells));
      },
    },
  ],
  [
    /^tracks\/(\d+)\/positions$/,
    {
      POST: async (m, request) =>
        withLiveCells(request, store.addTrackPosition(request.user, parseId(m[1]), await readJson(request))),
    },
  ],

  [
    /^collectors$/,
    {
      GET: (m, request) => store.listCollectors(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createCollector(request.user, await readJson(request))),
    },
  ],
  [
    /^collectors\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateCollector(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteCollector(request.user, parseId(m[1]))),
    },
  ],
  [
    /^taskings$/,
    {
      GET: (m, request) => store.listTaskings(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createTasking(request.user, await readJson(request))),
    },
  ],
  [
    /^taskings\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateTasking(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteTasking(request.user, parseId(m[1]))),
    },
  ],
  [/^collection\/conflicts$/, { GET: (m, request) => store.listCollectionConflicts(request.user) }],

  [
    /^intsums$/,
    {
      GET: (m, request) => store.listIntsums(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createIntsum(request.user, await readJson(request))),
    },
  ],
  [
    /^intsums\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateIntsum(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteIntsum(request.user, parseId(m[1]))),
    },
  ],
  [
    /^intsums\/(\d+)\/release$/,
    {
      POST: async (m, request) => {
        const { cells } = await readJson(request);
        return withLiveCells(request, store.releaseIntsum(request.user, parseId(m[1]), cells));
      },
    },
  ],
  [
    /^products\/intsum-draft$/,
    {
      GET: (m, request, url) =>
        store.draftIntsum(request.user, url.searchParams.get('from'), url.searchParams.get('to')),
    },
  ],

  [
    /^rfis$/,
    {
      GET: (m, request) => store.listRfis(request.user),
      POST: async (m, request) =>
        withLiveCells(request, store.createRfi(request.user, await readJson(request))),
    },
  ],
  [
    /^rfis\/(\d+)$/,
    {
      PATCH: async (m, request) =>
        withLiveCells(request, store.updateRfi(request.user, parseId(m[1]), await readJson(request))),
      DELETE: (m, request) => withLiveCells(request, store.deleteRfi(request.user, parseId(m[1]))),
    },
  ],
  [
    /^rfis\/(\d+)\/release$/,
    {
      POST: async (m, request) => {
        const { cells } = await readJson(request);
        return withLiveCells(request, store.releaseRfi(request.user, parseId(m[1]), cells));
      },
    },
  ],
  [
    /^rfis\/(\d+)\/transition$/,
    {
      POST: async (m, request) => {
        const body = await readJson(request);
        return withLiveCells(request, store.transitionRfi(request.user, parseId(m[1]), body.state, body));
      },
    },
  ],

  [
    /^clock$/,
    {
      GET: () => store.readClock(),
      PATCH: async (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.patchClock(await readJson(request));
      },
    },
  ],

  [
    /^scenario-events$/,
    {
      GET: () => store.listScenarioEvents(),
      POST: async (m, request) => store.createScenarioEvent(await readJson(request)),
    },
  ],
  [
    /^scenario-events\/(\d+)\/cancel$/,
    {
      POST: (m) => {
        store.cancelScenarioEvent(parseId(m[1]));
        return { cancelled: true };
      },
    },
  ],
  [
    /^scenario-events\/(\d+)\/fire$/,
    { POST: (m, request) => withLiveCells(request, store.fireScenarioEvent(parseId(m[1]))) },
  ],
  [/^scenario-tick$/, { POST: (m, request) => withLiveCells(request, store.tickScenario()) }],

  [
    /^activity$/,
    {
      // `scenario-events` itself is already gated at game-master
      // (`server/access.js`), but this per-object log also records that a
      // `scenario:schedule`/`cancel`/`fire`/`tick` happened (never the
      // inject's own text — the row's `detail` is always null and its
      // `target` is just an id/kind word/count) — still enough of a
      // "something is coming" signal to strip for anyone who can't read the
      // scenario events themselves. Cell visibility is filtered first, in
      // the store (a cell-owned mutation's row never appears to a cell
      // that can't see it, White included in "everyone").
      GET: (m, request) => {
        const rows = store.listActivity(request.user);
        if (request.user && roleAtLeast(request.user.role, 'game-master')) return rows;
        return rows.filter((row) => !row.action.startsWith('scenario:'));
      },
    },
  ],

  // -- the one active exercise scenario (fictional countries + renamed places) --
  [/^regions$/, { GET: () => store.getRegions() }],
  [
    /^scenarios$/,
    {
      GET: () => ({ items: store.listScenarios() }),
      POST: async (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.createScenario(await readJson(request));
      },
    },
  ],
  [
    /^scenarios\/example$/,
    {
      POST: (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.createExampleScenario();
      },
    },
  ],
  [
    /^scenarios\/(\d+)$/,
    {
      GET: (m) => store.getScenario(parseId(m[1])),
      PATCH: async (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.updateScenario(parseId(m[1]), await readJson(request));
      },
      DELETE: (m, request) => {
        request.liveCells = LIVE_ALL;
        store.deleteScenario(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],
  [
    /^scenarios\/(\d+)\/duplicate$/,
    {
      POST: (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.duplicateScenario(parseId(m[1]));
      },
    },
  ],
  [/^scenario\/active$/, { GET: () => store.getActiveScenario() }],
  [
    /^scenarios\/(\d+)\/countries$/,
    {
      POST: async (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.createCountry(parseId(m[1]), await readJson(request, COUNTRY_BODY_LIMIT));
      },
    },
  ],
  [
    /^scenario-countries\/(\d+)$/,
    {
      PATCH: async (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.updateCountry(parseId(m[1]), await readJson(request, COUNTRY_BODY_LIMIT));
      },
      DELETE: (m, request) => {
        request.liveCells = LIVE_ALL;
        store.deleteCountry(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],
  [
    /^scenarios\/(\d+)\/places$/,
    {
      POST: async (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.createPlace(parseId(m[1]), await readJson(request));
      },
    },
  ],
  [
    /^scenario-places\/(\d+)$/,
    {
      PATCH: async (m, request) => {
        request.liveCells = LIVE_ALL;
        return store.updatePlace(parseId(m[1]), await readJson(request));
      },
      DELETE: (m, request) => {
        request.liveCells = LIVE_ALL;
        store.deletePlace(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],
];

async function handle({ route, url, request, response }) {
  store ??= openStore(DATABASE, { regionsFile: REGIONS_FILE });
  if (!ticker) {
    ticker = setInterval(tick, TICK_MS);
    ticker.unref();
  }
  for (const [pattern, methods] of ROUTES) {
    const match = pattern.exec(route);
    if (!match) continue;
    const handler = methods[request.method];
    if (!handler) throw new HttpError(405, 'Method not allowed.');
    sendJson(response, await handler(match, request, url));
    return;
  }
  throw new HttpError(404, 'Unknown API route.');
}

export default {
  id: ID,
  handle,
  close() {
    clearInterval(ticker);
    ticker = null;
    store?.close();
    store = undefined;
  },
};
