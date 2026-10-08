// The exercise store's one SQLite connection (and the optional regions
// reference file), shared by every store/*.js file as ES-module live
// bindings: `openStore()` connects, each file reads `database` as it runs.
import { readFileSync } from 'node:fs';

import { referenceFile } from '../../../../server/reference.ts';
import { openState } from '../../../../server/state.ts';
import { MIGRATIONS } from '../schema.ts';

// ponytail: `any`, so rows stay dynamic like the other stores' rows; type it
// once each table has a row type, or every row read needs a cast.
export let database: any;
export let regionsReference: { get(): { data: unknown } | null; close(): void } | null | undefined;

export function connect(file: string, { regionsFile }: { regionsFile?: string } = {}) {
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
  database = undefined;
  regionsReference?.close();
  regionsReference = undefined;
}
