import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import { HttpError } from '../../../server/http.ts';
import { createTerrainPool } from './pool.ts';

const FIXTURE_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'pool.fixture.worker.ts',
);

let pool;

afterEach(() => {
  pool?.close();
  pool = undefined;
});

describe('createTerrainPool', () => {
  test('propagates a worker HttpError with its status and message', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    await expect(
      pool.submit('fail', { status: 422, message: 'bad geometry' }, { user: 'a' }),
    ).rejects.toMatchObject({ status: 422, message: 'bad geometry' });
  });

  test('runs jobs from one worker in FIFO queue order', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    const order = [];
    const jobs = ['first', 'second', 'third'].map((label, index) =>
      pool
        .submit('echo', { label, delayMs: 10 }, { user: `user-${index}` })
        .then((result) => order.push(result.echoed.label)),
    );
    await Promise.all(jobs);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  test('rejects with 503 once the queue is full', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    const running = pool.submit('echo', { delayMs: 200 }, { user: 'busy' });
    const queued = [];
    // One job occupies the only worker; the queue cap is 32, so filling it
    // (with distinct users, to stay under the per-user limit) exhausts it.
    for (let i = 0; i < 32; i += 1) {
      queued.push(pool.submit('echo', { delayMs: 10 }, { user: `queue-${i}` }));
    }
    let overflowError;
    try {
      pool.submit('echo', {}, { user: 'overflow' });
    } catch (error) {
      overflowError = error;
    }
    expect(overflowError).toBeInstanceOf(HttpError);
    expect(overflowError.status).toBe(503);
    await Promise.all([running, ...queued]);
  });

  test('rejects with 429 beyond one running + one queued job per user', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    const runningForOther = pool.submit('echo', { delayMs: 100 }, { user: 'someone-else' });
    const running = pool.submit('echo', { delayMs: 100 }, { user: 'alice' });
    const queued = pool.submit('echo', { delayMs: 10 }, { user: 'alice' });
    let overLimitError;
    try {
      pool.submit('echo', {}, { user: 'alice' });
    } catch (error) {
      overLimitError = error;
    }
    expect(overLimitError).toBeInstanceOf(HttpError);
    expect(overLimitError.status).toBe(429);
    await Promise.all([runningForOther, running, queued]);
  });

  test('cancelling a queued job drops it and frees the user for another submission', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    const running = pool.submit('echo', { delayMs: 200 }, { user: 'someone-else' });
    const controller = new AbortController();
    const queued = pool
      .submit('echo', { label: 'to-cancel' }, { user: 'bob', signal: controller.signal })
      .catch((error) => error);
    controller.abort();
    const error = await queued;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(499);
    // The slot bob's cancelled job held is now free.
    const next = await pool.submit('echo', { label: 'after-cancel' }, { user: 'bob' });
    expect(next.echoed.label).toBe('after-cancel');
    await running;
  });

  test('cancelling a running job terminates its worker and rejects with 499', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    const controller = new AbortController();
    const spinning = pool
      .submit('spin', { durationMs: 5000 }, { user: 'carol', signal: controller.signal })
      .catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const error = await spinning;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(499);
    // The pool respawns a worker and keeps serving requests afterwards.
    const after = await pool.submit('echo', { label: 'still-alive' }, { user: 'carol' });
    expect(after.echoed.label).toBe('still-alive');
  });

  test('a crashed worker rejects its job with 500 and the pool respawns it', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    await expect(pool.submit('crash', {}, { user: 'dave' })).rejects.toMatchObject({ status: 500 });
    const after = await pool.submit('echo', { label: 'recovered' }, { user: 'dave' });
    expect(after.echoed.label).toBe('recovered');
  });

  test('map tiles are not held to the per-user analysis limit', async () => {
    pool = createTerrainPool({ size: 2, workerFile: FIXTURE_WORKER });
    // One map view asks for dozens of tiles at once.
    const tiles = Array.from({ length: 40 }, (_, index) =>
      pool.submit('echo', { index }, { user: 'viewer', lane: 'tile' }),
    );
    const results = await Promise.all(tiles);
    expect(results.map((r) => r.echoed.index)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  test('analyses never take the last worker, so tiles still render during a long viewshed', async () => {
    pool = createTerrainPool({ size: 2, workerFile: FIXTURE_WORKER });
    const first = pool.submit('spin', { durationMs: 1500 }, { user: 'a' });
    const second = pool.submit('spin', { durationMs: 1500 }, { user: 'b' }); // queued, not on worker 2
    const started = Date.now();
    await pool.submit('echo', { tile: true }, { user: 'c', lane: 'tile' });
    expect(Date.now() - started).toBeLessThan(500);
    await Promise.all([first, second]);
  });

  test('a queued tile is served before a queued analysis', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    const order = [];
    const running = pool.submit('echo', { label: 'running', delayMs: 100 }, { user: 'a' });
    const analysis = pool
      .submit('echo', { label: 'analysis' }, { user: 'b' })
      .then(() => order.push('analysis'));
    const tile = pool
      .submit('echo', { label: 'tile' }, { user: 'c', lane: 'tile' })
      .then(() => order.push('tile'));
    await Promise.all([running, analysis, tile]);
    expect(order).toEqual(['tile', 'analysis']);
  });

  test('HttpError instances survive instanceof checks', async () => {
    pool = createTerrainPool({ size: 1, workerFile: FIXTURE_WORKER });
    const rejection = pool.submit('fail', { status: 404, message: 'nope' }, { user: 'eve' });
    await expect(rejection).rejects.toBeInstanceOf(HttpError);
    await expect(rejection).rejects.toMatchObject({ status: 404 });
  });
});
