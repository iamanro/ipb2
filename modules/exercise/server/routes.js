import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, readJson, sendJson } from '../../../server/http.js';
import { openStore } from './store.js';

const ID = 'exercise';
const STATE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state');
const DATABASE = path.join(STATE_ROOT, 'exercise.db');

function parseId(text) {
  return Number.parseInt(text, 10);
}

let store;

const ROUTES = [
  [
    /^roster$/,
    {
      GET: () => store.listRoster(),
      POST: async (m, request) => store.createRosterMember(await readJson(request)),
    },
  ],
  [
    /^roster\/(\d+)$/,
    {
      DELETE: (m) => {
        store.deleteRosterMember(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],

  [
    /^requirements$/,
    {
      GET: () => store.listRequirements(),
      POST: async (m, request) => store.createRequirement(await readJson(request)),
    },
  ],
  [
    /^requirements\/(\d+)$/,
    {
      PATCH: async (m, request) => store.updateRequirement(parseId(m[1]), await readJson(request)),
      DELETE: (m) => {
        store.deleteRequirement(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],
  [
    /^requirements\/(\d+)\/sirs$/,
    { POST: async (m, request) => store.createSir(parseId(m[1]), await readJson(request)) },
  ],
  [
    /^sirs\/(\d+)$/,
    {
      PATCH: async (m, request) => store.updateSir(parseId(m[1]), await readJson(request)),
      DELETE: (m) => {
        store.deleteSir(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],
  [
    /^sirs\/(\d+)\/indicators$/,
    { POST: async (m, request) => store.createIndicator(parseId(m[1]), await readJson(request)) },
  ],
  [
    /^indicators\/(\d+)$/,
    {
      PATCH: async (m, request) => store.updateIndicator(parseId(m[1]), await readJson(request)),
      DELETE: (m) => {
        store.deleteIndicator(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],

  [
    /^reports$/,
    {
      GET: () => store.listReports(),
      POST: async (m, request) => store.createReport(await readJson(request)),
    },
  ],
  [
    /^reports\/(\d+)$/,
    {
      PATCH: async (m, request) => store.updateReport(parseId(m[1]), await readJson(request)),
      DELETE: (m) => {
        store.deleteReport(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],
  [
    /^reports\/(\d+)\/links$/,
    {
      POST: async (m, request) => store.createEvidenceLink(parseId(m[1]), await readJson(request)),
    },
  ],
  [
    /^links\/(\d+)$/,
    {
      DELETE: (m) => {
        store.deleteEvidenceLink(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],

  [
    /^rfis$/,
    {
      GET: () => store.listRfis(),
      POST: async (m, request) => store.createRfi(await readJson(request)),
    },
  ],
  [
    /^rfis\/(\d+)$/,
    {
      PATCH: async (m, request) => store.updateRfi(parseId(m[1]), await readJson(request)),
      DELETE: (m) => {
        store.deleteRfi(parseId(m[1]));
        return { deleted: true };
      },
    },
  ],
  [
    /^rfis\/(\d+)\/transition$/,
    {
      POST: async (m, request) => {
        const body = await readJson(request);
        return store.transitionRfi(parseId(m[1]), body.state, body);
      },
    },
  ],

  [
    /^clock$/,
    {
      GET: () => store.readClock(),
      PATCH: async (m, request) => store.patchClock(await readJson(request)),
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
  [/^scenario-events\/(\d+)\/fire$/, { POST: (m) => store.fireScenarioEvent(parseId(m[1])) }],
  [/^scenario-tick$/, { POST: () => store.tickScenario() }],

  [/^activity$/, { GET: () => store.listActivity() }],
];

async function handle({ route, request, response }) {
  store ??= openStore(DATABASE);
  for (const [pattern, methods] of ROUTES) {
    const match = pattern.exec(route);
    if (!match) continue;
    const handler = methods[request.method];
    if (!handler) throw new HttpError(405, 'Method not allowed.');
    sendJson(response, await handler(match, request));
    return;
  }
  throw new HttpError(404, 'Unknown API route.');
}

export default {
  id: ID,
  handle,
  close() {
    store?.close();
    store = undefined;
  },
};
