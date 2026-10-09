// A tiny stand-in for worker.js, used only by pool.test.js so pool
// semantics (queueing, fairness, cancellation, crash/respawn) can be
// exercised without opening the real (multi-gigabyte) elevation model.
import { parentPort as port, workerData } from 'node:worker_threads';

import { errorMessage, HttpError } from '../../../server/http.ts';

// Loaded only as a worker thread; the pool passes this file to `new Worker()`.
if (!port) throw new Error('This file runs only as a worker thread.');
const parentPort = port;

parentPort.on('message', async ({ id, kind, payload }) => {
  try {
    if (kind === 'echo') {
      if (payload?.delayMs) await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
      parentPort.postMessage({ id, ok: true, result: { echoed: payload, workerData } });
      return;
    }
    if (kind === 'fail') {
      throw new HttpError(payload?.status ?? 422, payload?.message ?? 'fixture failure');
    }
    if (kind === 'crash') {
      // Simulates an uncaught exception bringing the worker down mid-job.
      process.nextTick(() => {
        throw new Error('fixture crash');
      });
      return;
    }
    if (kind === 'spin') {
      // A long synchronous loop, standing in for an uncancellable hot loop
      // (viewshed/mobility/corridors) — only `worker.terminate()` stops this.
      const until = Date.now() + (payload?.durationMs ?? 5000);
      while (Date.now() < until) {
        // busy-wait
      }
      parentPort.postMessage({ id, ok: true, result: 'done' });
      return;
    }
    throw new HttpError(400, `Unknown fixture job kind "${kind}".`);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    parentPort.postMessage({ id, ok: false, status, message: errorMessage(error) });
  }
});
