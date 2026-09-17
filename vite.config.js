import { defineConfig } from 'vite-plus';

import ipbApi from './server/api.js';

export default defineConfig({
  plugins: [ipbApi()],
  lint: {
    ignorePatterns: ['dist/**', 'modules/*/data/**', 'modules/*/state/**', 'node_modules/**'],
  },
  fmt: {
    ignorePatterns: ['dist/**', 'modules/*/data/**', 'modules/*/state/**', 'node_modules/**'],
    semi: true,
    singleQuote: true,
  },
});
