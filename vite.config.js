import { defineConfig } from 'vite-plus';

import ipbApi from './server/api.js';

// Vite's default `fs.deny` only covers secrets-style files (.env, keys,
// .git); the app's own module state (`server/state/`, `modules/*/state/`,
// `modules/*/data/`) sits inside the project root too, and without this it
// is otherwise servable straight off disk by the static/raw-fs middleware —
// defence in depth alongside `server/api.js`'s own `isBlockedStaticPath`
// guard, which runs first and covers every mode (IPB-AUTH-001, critical).
const FS_DENY = [
  '.env',
  '.env.*',
  '*.{crt,pem,key,p12,pfx,cer,der}',
  '.npmrc',
  '.yarnrc.yml',
  '**/.git/**',
  '**/state/**',
  '**/data/**',
  '**/*.db',
  '**/*.db-*',
  '**/*.mbtiles',
  '**/*.pmtiles',
];

export default defineConfig({
  // Not under Vitest: its internal Vite server would mount the API, whose
  // scenario-clock ticker then opens (and fires injects in) the real
  // `modules/exercise/state/exercise.db` mid-run. Tests start their own.
  plugins: process.env.VITEST ? [] : [ipbApi()],
  server: {
    fs: { deny: FS_DENY },
    // Same-origin app; Vite's default CORS reflects any localhost origin,
    // which in `off` mode (no cookie needed) would let another local page
    // read every API response (IPB-AUTH-009).
    cors: false,
  },
  preview: {
    cors: false,
  },
  build: {
    // The ipb view pulls in OpenLayers, milsymbol, and mgrs; splitting
    // third-party code out of it keeps the app chunk small (57 KB, down from
    // 1.37 MB) and lets the browser cache the rarely-changing vendor code
    // separately. The vendor chunk itself stays over the default 500 KB
    // warning threshold because OpenLayers is genuinely that size; the limit
    // below reflects that known, accepted cost rather than hiding growth in
    // application code.
    chunkSizeWarningLimit: 1400,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'vendor', test: /node_modules/ }],
        },
      },
    },
  },
  lint: {
    ignorePatterns: ['dist/**', 'modules/*/data/**', 'modules/*/state/**', 'node_modules/**'],
  },
  fmt: {
    ignorePatterns: ['dist/**', 'modules/*/data/**', 'modules/*/state/**', 'node_modules/**'],
    semi: true,
    singleQuote: true,
  },
});
