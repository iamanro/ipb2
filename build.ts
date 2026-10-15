#!/usr/bin/env bun
/**
 * Client build: `index.html` and everything it imports, bundled by Bun into
 * `dist/` — `dist/index.html` plus hashed `dist/assets/*` (the server gives
 * those a one-year immutable cache). `bun build.ts`, or `buildClient()` from
 * `dev.ts`.
 *
 * What Bun's HTML bundling leaves to us:
 * - paths are absolute (`/assets/…`): the shell routes `/ipb/`, `/exercise/`…
 *   all serve this one `index.html`, so a relative `./x.js` would break;
 * - Bun inlines every CSS `url()` as base64, which for the @fontsource faces
 *   is 1.5 MB of render-blocking CSS with every script subset in it; their
 *   `url(./files/…)` are rewritten to external `/assets/fonts/…` and only the
 *   referenced files copied, so the browser fetches just the subsets it uses;
 * - each module's stylesheet comes out with its lazily imported chunk, and
 *   nothing loads it when the chunk is imported, so every CSS file is linked
 *   from `index.html` up front. Module rules are scoped under
 *   `[data-module='<id>']` and the cascade-layer order is declared in
 *   `index.html`, so loading them all at once changes nothing visible.
 */
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = import.meta.dir;
const DIST = path.join(ROOT, 'dist');
// Built here, then swapped in: a failed build leaves the last good dist/ serving.
const NEXT = path.join(ROOT, 'dist.next');
const FONTS = '/assets/fonts/';

/** Rewrites @fontsource `url(./files/x.woff2)` to `/assets/fonts/x.woff2`, noting each file to copy. */
function externalFonts(files: Map<string, string>): Bun.BunPlugin {
  return {
    name: 'external-fonts',
    setup(build) {
      build.onLoad({ filter: /@fontsource[\\/].*\.css$/ }, async ({ path: file }) => ({
        loader: 'css',
        contents: (await readFile(file, 'utf8')).replace(
          /url\(\.\/files\/([^)]+)\)/g,
          (_, name: string) => {
            files.set(name, path.join(path.dirname(file), 'files', name));
            return `url(${FONTS}${name})`;
          },
        ),
      }));
    },
  };
}

export async function buildClient({ minify = true } = {}) {
  await rm(NEXT, { recursive: true, force: true });
  const fonts = new Map<string, string>();
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, 'index.html')],
    outdir: NEXT,
    publicPath: '/',
    splitting: true,
    minify,
    sourcemap: minify ? 'none' : 'linked',
    naming: {
      entry: '[name].[ext]',
      chunk: 'assets/[name]-[hash].[ext]',
      asset: 'assets/[name]-[hash].[ext]',
    },
    plugins: [externalFonts(fonts)],
    external: [`${FONTS}*`],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'Client build failed.');
  }

  await mkdir(path.join(NEXT, FONTS), { recursive: true });
  await Promise.all(
    [...fonts].map(([name, source]) => copyFile(source, path.join(NEXT, FONTS, name))),
  );

  const indexPath = path.join(NEXT, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const links = result.outputs
    .map((output) => `/${path.relative(NEXT, output.path)}`)
    .filter((href) => href.endsWith('.css') && !html.includes(`"${href}"`))
    .map((href) => `<link rel="stylesheet" crossorigin href="${href}">`)
    .join('');
  await writeFile(indexPath, html.replace('</head>', `${links}</head>`));
  await rm(DIST, { recursive: true, force: true });
  await rename(NEXT, DIST);
  return result.outputs.length + fonts.size;
}

if (import.meta.main) {
  const count = await buildClient();
  console.log(`[build] ${count} files in dist/`);
}
