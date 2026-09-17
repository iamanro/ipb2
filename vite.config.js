import { defineConfig } from 'vite-plus';

import ipbApi from './server/api.js';

export default defineConfig({
  plugins: [ipbApi()],
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
