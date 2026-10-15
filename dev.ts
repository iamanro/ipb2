#!/usr/bin/env bun
/**
 * Development server: builds the client unminified (with source maps), then
 * runs the same server as production (`server/index.ts`) on :5180, and
 * rebuilds whenever a client file changes — reload the page to see it.
 * Run under `bun --watch` (`bun run dev`), which restarts this whole
 * process when server code it imports changes.
 */
import { watch } from 'node:fs';
import path from 'node:path';

import { buildClient } from './build.ts';
import { main } from './server/index.ts';

process.env.IPB_PORT ??= '5180';

/** Only client sources: `modules/*` also holds server code and live SQLite state. */
function isClientSource(file: string) {
  return (
    file === 'index.html' ||
    ((file.startsWith('src/') || file.includes('/client/')) && !file.endsWith('.test.js'))
  );
}

async function rebuild() {
  const started = performance.now();
  try {
    await buildClient({ minify: false });
    console.log(`[dev] client built in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    console.error('[dev] client build failed:', error);
  }
}

let pending: ReturnType<typeof setTimeout> | undefined;
watch(import.meta.dir, { recursive: true }, (_, name) => {
  if (!name || !isClientSource(name.split(path.sep).join('/'))) return;
  clearTimeout(pending);
  pending = setTimeout(() => void rebuild(), 100);
});

await rebuild();
await main();
