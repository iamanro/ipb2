// The exercise store's one SQLite connection (and the optional regions
// reference file), shared by every store/*.js file as ES-module live
// bindings: `openStore()` connects, each file reads `database` as it runs.
import { readFileSync } from 'node:fs';

import { referenceFile } from '../../../../server/reference.js';
import { openState } from '../../../../server/state.js';
import { MIGRATIONS } from '../schema.js';

/** @type {import('node:sqlite').DatabaseSync} */
export let database;
/** @type {{ get(): { data: unknown } | null, close(): void } | null | undefined} */
export let regionsReference;

/** @param {string} file @param {{ regionsFile?: string }} [options] */
export function connect(file, { regionsFile } = {}) {
  database = openState(file, MIGRATIONS);
  regionsReference = regionsFile
    ? referenceFile(regionsFile, (path) => ({
        data: JSON.parse(readFileSync(path, 'utf8')),
        close() {},
      }))
    : null;
}

export function disconnect() {
  database?.close();
  // @ts-expect-error -- cleared on close; any later use is a bug that should throw.
  database = undefined;
  regionsReference?.close();
  regionsReference = undefined;
}
