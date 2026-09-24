import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

// Each run gets throwaway module state (studies, exercise, bookmarks) via
// IPB_STATE_ROOT; reference data (terrain, equipment) is read in place.
// Set on process.env so the workers, which re-load this file, reuse it.
process.env.IPB_STATE_ROOT ??= mkdtempSync(path.join(os.tmpdir(), 'ipb-e2e-'));
const PORT = 5190;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.js',
  // One server, one browser at a time: scenarios drive the same app instance.
  workers: 1,
  globalTeardown: './e2e/teardown.js',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    // The production build, not the dev server: on a cold start Vite's dev
    // server re-optimises dependencies and reloads the page mid-test.
    command: `npx vp build && npx vp preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/ipb/`,
    reuseExistingServer: false,
    env: { IPB_STATE_ROOT: process.env.IPB_STATE_ROOT },
    timeout: 60_000,
  },
});
