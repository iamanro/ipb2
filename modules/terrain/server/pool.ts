// A small fixed-size pool of `node:worker_threads` workers (worker.js) that
// runs the CPU-heavy terrain analyses and tile renders off the main thread,
// so one 15 km viewshed doesn't freeze `GET /api/terrain/meta` or any other
// request for the ~9 s it takes.
//
// Sizing (IPB_TERRAIN_WORKERS, default clamp(cores - 2, 1, 4)): each worker
// opens its own elevation model with its own DEM tile LRU (see
// elevationSource.js / paths.js), and the DMR4G detail cache alone is
// DETAIL_TILE_CACHE_LIMIT (1536) tiles x 256x256 x 4-byte floats ~= 384 MB.
// On the target 8-core/16 GB box that's clamp(8 - 2, 1, 4) = 4 workers,
// ~1.5 GB of DEM cache, leaving headroom for node-sqlite's own page cache,
// the vector/imagery mbtiles/pmtiles readers and ~30 concurrent HTTP
// requests. Two cores stay off the pool for the main thread (HTTP, SQLite
// state, tile-cache bookkeeping) and the OS. A 16 GB host should not raise
// this past 4 without first shrinking DETAIL_TILE_CACHE_LIMIT.
//
// Each worker runs one job at a time. Jobs come in two lanes:
// - analyses (viewshed, mobility, key terrain, avenues, extremes): seconds
//   each, at most one running + one queued per user (a 429 beyond that), and
//   never on every worker at once, so one worker is always left for tiles;
// - tiles (hillshade, slope, contours): tens of milliseconds each, but a map
//   view asks for dozens at once, so no per-user limit, a longer queue of
//   their own, and served before any queued analysis.
// A job over its lane's queue cap gets a 503; a disconnected client's queued
// job is dropped, its running job's worker is terminated and replaced.
// Termination (rather than a cooperative abort flag threaded through every
// hot loop in dem.js/corridors.js/mobility.js) is the simple, always-correct
// way to actually stop CPU work already in a tight loop; the fresh worker's
// DEM cache is empty but re-populates from mmap'd SQLite pages, which is
// cheap next to the analysis itself.
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { HttpError } from '../../../server/http.ts';

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');

const DEFAULT_WORKERS = Math.min(Math.max(cpus().length - 2, 1), 4);

/** Queued analyses waiting for a free worker, across all users. */
const MAX_QUEUE_LENGTH = 32;
/** Queued tile renders; several users panning at once is a few hundred. */
const MAX_TILE_QUEUE_LENGTH = 256;
/** Running + queued heavy jobs a single user (or IP, when signed out) may hold at once. */
const MAX_JOBS_PER_USER = 2;

/**
 * Creates a pool. `size` defaults to `IPB_TERRAIN_WORKERS` or
 * `clamp(cores - 2, 1, 4)` (see the module doc for the memory budget).
 * `workerFile` overrides the worker script — tests use a tiny fixture
 * instead of opening the real (multi-gigabyte) elevation model.
 */
type Slot = { worker: Worker; index: number; job: Job | null; terminating: boolean };
type Job = {
  id: number;
  kind: string;
  payload: unknown;
  user: string;
  tile: boolean;
  queued: boolean;
  slot: Slot | null;
  settled: boolean;
  // Replaced by the promise's own settle functions as soon as the job is made.
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export function createTerrainPool({
  size,
  workerFile = WORKER_FILE,
}: { size?: number; workerFile?: string } = {}) {
  const poolSize = size ?? (Number(process.env.IPB_TERRAIN_WORKERS) || DEFAULT_WORKERS);
  const slots: Slot[] = [];
  const queue: Job[] = [];
  const tileQueue: Job[] = [];
  /** Analyses may use every worker but one, so tiles never wait behind them all. */
  const analysisCap = Math.max(1, poolSize - 1);
  /** user key -> Set of that user's in-flight (running or queued) jobs. */
  const byUser = new Map<string, Set<Job>>();
  let nextId = 1;
  let closed = false;

  function spawn(index) {
    const worker = new Worker(workerFile);
    const slot: Slot = { worker, index, job: null, terminating: false };
    worker.on('message', (message) => onMessage(slot, message));
    worker.on('error', (error) => onCrash(slot, error));
    worker.on('exit', (code) => onExit(slot, code));
    slots[index] = slot;
    return slot;
  }

  for (let index = 0; index < poolSize; index += 1) spawn(index);

  function releaseUser(job) {
    const set = byUser.get(job.user);
    if (!set) return;
    set.delete(job);
    if (set.size === 0) byUser.delete(job.user);
  }

  function onMessage(slot, message) {
    const job = slot.job;
    if (!job || job.id !== message.id) return; // stale message from a job we already gave up on
    slot.job = null;
    releaseUser(job);
    if (message.ok) job.resolve(message.result);
    else
      job.reject(
        new HttpError(message.status || 500, message.message || 'Terrain analysis failed.'),
      );
    pump();
  }

  function onCrash(slot, error) {
    const job = slot.job;
    slot.job = null;
    if (!slot.terminating && !closed) spawn(slot.index);
    if (job) {
      releaseUser(job);
      job.reject(new HttpError(500, `Terrain analysis failed: worker crashed (${error.message}).`));
    }
    pump();
  }

  function onExit(slot, code) {
    if (slot.terminating || closed) return; // an intentional terminate(), already handled elsewhere
    if (code !== 0) onCrash(slot, new Error(`worker exited with code ${code}`));
  }

  function dispatch(slot, job) {
    job.queued = false;
    slot.job = job;
    slot.worker.postMessage({ id: job.id, kind: job.kind, payload: job.payload });
  }

  function idleSlot() {
    return slots.find((candidate) => !candidate.job && !candidate.terminating);
  }

  function runningAnalyses() {
    return slots.filter((slot) => slot.job && !slot.job.tile).length;
  }

  /** The next job a free worker should take: any tile first, then an analysis if under the cap. */
  function nextJob() {
    if (tileQueue.length) return tileQueue.shift();
    if (queue.length && runningAnalyses() < analysisCap) return queue.shift();
    return null;
  }

  function pump() {
    for (let slot = idleSlot(); slot; slot = idleSlot()) {
      const job = nextJob();
      if (!job) return;
      job.slot = slot;
      dispatch(slot, job);
    }
  }

  function cancel(job) {
    if (job.settled) return;
    if (job.queued) {
      const lane = job.tile ? tileQueue : queue;
      const index = lane.indexOf(job);
      if (index !== -1) lane.splice(index, 1);
      releaseUser(job);
      job.reject(new HttpError(499, 'The client disconnected.'));
      return;
    }
    const slot = job.slot;
    if (!slot) return; // resolved/rejected already, or never dispatched
    slot.terminating = true;
    slot.job = null;
    releaseUser(job);
    job.reject(new HttpError(499, 'The client disconnected.'));
    slot.worker.terminate().finally(() => {
      slot.terminating = false;
      if (!closed) spawn(slot.index);
      pump();
    });
  }

  /**
   * Runs one job. `user` is a fairness key (`request.user?.name` or the
   * client IP); `lane` is `'analysis'` (default) or `'tile'` (see the module
   * doc); `signal`, when it aborts, cancels the job. Throws `HttpError`
   * (429/503) synchronously when the job is rejected outright, otherwise
   * returns a promise for the worker's result.
   */
  function submit(
    kind: string,
    payload: unknown,
    {
      user,
      signal,
      lane = 'analysis',
    }: { user?: string; signal?: AbortSignal; lane?: string } = {},
  ) {
    if (closed) throw new HttpError(503, 'Terrain analysis is busy, try again shortly.');
    const tile = lane === 'tile';
    const key = user || 'anonymous';
    const userSet = byUser.get(key);
    if (!tile && userSet && userSet.size >= MAX_JOBS_PER_USER) {
      throw new HttpError(
        429,
        'Too many terrain analyses running for this account already; wait for one to finish.',
      );
    }
    const [waiting, cap] = tile ? [tileQueue, MAX_TILE_QUEUE_LENGTH] : [queue, MAX_QUEUE_LENGTH];
    if (waiting.length >= cap) {
      throw new HttpError(503, 'Terrain analysis is busy, try again shortly.');
    }

    const job: Job = {
      id: nextId++,
      kind,
      payload,
      user: key,
      tile,
      queued: true,
      slot: null,
      settled: false,
      resolve: () => {},
      reject: () => {},
    };
    if (!tile) {
      let jobs = byUser.get(key);
      if (!jobs) byUser.set(key, (jobs = new Set()));
      jobs.add(job);
    }

    // A worker's result is whatever it posted back: untyped, like any message.
    const promise = new Promise<any>((resolve, reject) => {
      job.resolve = (value) => {
        if (job.settled) return;
        job.settled = true;
        resolve(value);
      };
      job.reject = (error) => {
        if (job.settled) return;
        job.settled = true;
        reject(error);
      };
    });

    if (signal) {
      if (signal.aborted) {
        cancel(job);
        return promise;
      }
      const onAbort = () => cancel(job);
      signal.addEventListener('abort', onAbort, { once: true });
      // `.finally` returns its own promise, which would otherwise reject
      // unobserved whenever `promise` (returned to and handled by the
      // caller) does.
      promise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
    }

    waiting.push(job);
    pump();
    return promise;
  }

  /** Terminates every worker and rejects anything in flight; the pool is unusable afterwards. */
  function close() {
    closed = true;
    for (const job of [...tileQueue.splice(0), ...queue.splice(0)]) {
      job.reject(new HttpError(503, 'The terrain pool is shutting down.'));
    }
    for (const slot of slots) {
      const job = slot.job;
      slot.job = null;
      slot.terminating = true;
      if (job) job.reject(new HttpError(503, 'The terrain pool is shutting down.'));
      slot.worker.terminate();
    }
  }

  return { submit, close };
}
