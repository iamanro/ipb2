// The exercise store's one SQLite connection (and the optional regions
// reference file), shared by every store/*.js file as ES-module live
// bindings: `openStore()` connects, each file reads `database` as it runs.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import type { Json } from '../../../../server/http.ts';

import { referenceFile } from '../../../../server/reference.ts';
import { openState } from '../../../../server/state.ts';
import { MIGRATIONS } from '../schema.ts';

export let database: DatabaseSync;
export let regionsReference: { get(): { data: Json } | null; close(): void } | null | undefined;

export function connect(file: string, { regionsFile }: { regionsFile?: string } = {}) {
  database = openState(file, MIGRATIONS);
  regionsReference = regionsFile
    ? referenceFile(regionsFile, (path: string) => {
        const data: Json = JSON.parse(readFileSync(path, 'utf8'));
        return { data, close() {} };
      })
    : null;
}

export function disconnect() {
  // Closed for good: openStore() connects again before any further use.
  database?.close();
  regionsReference?.close();
  regionsReference = undefined;
}
