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
  // Oxlint: correctness, suspicious and perf as errors, with the plugins this
  // codebase actually uses (setting `plugins` replaces the default set, so the
  // defaults — eslint, typescript, unicorn, oxc — are listed too). Rules
  // switched off below were measured against the code and found to be noise
  // here; the reason is next to each one.
  lint: {
    // Type checks run through tsgolint over the files tsconfig.json opts in.
    options: { typeAware: true, typeCheck: true },
    plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'promise', 'vitest', 'node'],
    categories: {
      correctness: 'error',
      suspicious: 'error',
      perf: 'error',
    },
    rules: {
      // Closures over render state are the pattern of every client view.
      'unicorn/consistent-function-scoping': 'off',
      // Almost all sorts/reverses are on arrays just built by map/filter.
      'unicorn/no-array-sort': 'off',
      'unicorn/no-array-reverse': 'off',
      // Every postMessage here is worker_threads, which has no target origin.
      'unicorn/require-post-message-target-origin': 'off',
      // Sequential awaits are deliberate: SQLite migrations, backup steps,
      // load-test pacing, rate-limited upstream fetches.
      'eslint/no-await-in-loop': 'off',
      // Small arrays; the spread keeps rows immutable and readable.
      'oxc/no-map-spread': 'off',
      // `.then()` runs UI side effects after a fetch; nothing chains on it.
      'promise/always-return': 'off',
      // Side-effect imports are stylesheets and @fontsource faces.
      'import/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
      // Type-aware rules with many existing hits, kept visible as warnings
      // until fixed: un-awaited async calls (mostly UI event handlers that
      // report their own errors), and non-string values in template text.
      'typescript/no-floating-promises': 'warn',
      'typescript/restrict-template-expressions': 'warn',
      // Tests assert through expectStatus()/assertNoOverlaps()-style helpers.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*', 'assert*'] }],
    },
    ignorePatterns: ['dist/**', 'modules/*/data/**', 'modules/*/state/**', 'node_modules/**'],
  },
  fmt: {
    // `.agents/` is vendored as-is: skills-lock.json pins each file's hash.
    ignorePatterns: [
      'dist/**',
      'modules/*/data/**',
      'modules/*/state/**',
      'node_modules/**',
      '.agents/**',
    ],
    semi: true,
    singleQuote: true,
  },
});
