// The terrain worker protocol: what each job kind takes and gives back, and
// a check per kind that a result crossing the thread boundary has that shape.
import type { Geometry } from '../../../server/geometry.ts';
import type { AvenueRequest, suggestAvenues } from './corridors.ts';
import type { ElevationModel, ViewshedRequest } from './dem.ts';
import type { elevationExtremes } from './extremes.ts';
import type { keyTerrainCandidates } from './keyTerrain.ts';
import type { Bounds } from './lattice.ts';
import type { MobilityGrid } from './mobility.ts';

type TileAddress = { z: number; x: number; y: number };

export type JobPayloads = {
  raster: TileAddress & { renderer: 'hillshade' | 'slope' };
  contour: TileAddress;
  viewshed: ViewshedRequest;
  extremes: { area: Geometry | null };
  'key-terrain': { bounds: Bounds; minProminence: number; limit: number; radiusMetres: number };
  mobility: { bounds: Bounds; cellMetres: number };
  avenues: { bounds: Bounds; cellMetres: number; avenues: AvenueRequest };
};
export type JobKind = keyof JobPayloads;

export type JobResults = {
  raster: Uint8Array;
  contour: Uint8Array;
  viewshed: ReturnType<ElevationModel['viewshed']>;
  extremes: ReturnType<typeof elevationExtremes>;
  'key-terrain': ReturnType<typeof keyTerrainCandidates>;
  mobility: MobilityGrid;
  avenues: ReturnType<typeof suggestAvenues>;
};
export type JobResult = JobResults[JobKind];
export type JobPayload = JobPayloads[JobKind];

/** A worker's answer to one job. */
export type WorkerReply =
  | { id: number; ok: true; result: JobResult }
  | { id: number; ok: false; status?: number; message?: string };

/** One job as the pool posts it to a worker. */
export type JobRequest = {
  [K in JobKind]: { id: number; kind: K; payload: JobPayloads[K] };
}[JobKind];

const RESULT_CHECKS: { [K in JobKind]: (value: JobResult) => value is JobResults[K] } = {
  raster: (value): value is Uint8Array => value instanceof Uint8Array,
  contour: (value): value is Uint8Array => value instanceof Uint8Array,
  viewshed: (value): value is JobResults['viewshed'] =>
    !(value instanceof Uint8Array) && !Array.isArray(value) && 'visibleCells' in value,
  extremes: (value): value is JobResults['extremes'] =>
    !(value instanceof Uint8Array) && !Array.isArray(value) && 'highest' in value,
  'key-terrain': (value): value is JobResults['key-terrain'] => Array.isArray(value),
  mobility: (value): value is MobilityGrid =>
    !(value instanceof Uint8Array) && !Array.isArray(value) && 'legend' in value,
  avenues: (value): value is JobResults['avenues'] =>
    !(value instanceof Uint8Array) && !Array.isArray(value) && 'routes' in value,
};

/** `value` as `kind`'s result; a mismatch means the worker and the caller disagree. */
export function resultOf<K extends JobKind>(kind: K, value: JobResult): JobResults[K] {
  const check: (value: JobResult) => value is JobResults[K] = RESULT_CHECKS[kind];
  if (!check(value)) throw new Error(`Terrain worker returned the wrong shape for "${kind}".`);
  return value;
}
