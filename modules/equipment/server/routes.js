import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, integerParameter, sendJson } from '../../../server/http.ts';
import { referenceFile } from '../../../server/reference.ts';
import { dataDirectory } from '../../../server/state.ts';
import { openBookmarks } from './bookmarks.js';
import {
  KINDS,
  imagePath,
  listCardExtras,
  listCards,
  openDatabase,
  showCard,
  stats,
  taxonomy,
} from './db.js';
import { cardRanges } from './ranges.js';
import bookmarksState from './state.js';

const ID = 'equipment';
const DATA_ROOT = dataDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'),
);
const DATABASE = path.join(DATA_ROOT, 'unitgenerator.db');
const ODIN_ASSET_ROOT = 'https://odin.t2com.army.mil/dotcms/';

const SIGNATURES = [
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'],
  [[0x49, 0x49, 0x2a, 0x00], 'image/tiff'],
  [[0x4d, 0x4d, 0x00, 0x2a], 'image/tiff'],
];

function publicImageUrl(identifier, image) {
  if (image.local_path)
    return `/api/${ID}/images/${encodeURIComponent(identifier)}/${image.ordinal}`;
  if (image.source_path)
    return new URL(image.source_path.replace(/^\/+/, ''), ODIN_ASSET_ROOT).href;
  return null;
}

/** Local image files carry no extension, so sniff the first bytes. */
async function imageContentType(file) {
  const { buffer, bytesRead } = await file.read(Buffer.alloc(512), 0, 512, 0);
  const head = buffer.subarray(0, bytesRead);
  for (const [magic, type] of SIGNATURES) {
    if (magic.every((byte, index) => head[index] === byte)) return type;
  }
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (head.toString('latin1').toLowerCase().includes('<svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, minimum), maximum);
}

/** GET carries filters as repeated query params: fine for the handful of
 * keys a plain text search sends, but a wide multi-select would overflow
 * the request-header size limit. */
function cardsParamsFromQuery(query) {
  return {
    text: query.get('q'),
    filters: Object.fromEntries(KINDS.map((kind) => [kind, query.getAll(kind)])),
    limit: integerParameter(query, 'limit', 100, 1, 200),
    offset: integerParameter(query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * Search parameters from a POST body. POST carries filters in a JSON body,
 * which has no practical size limit for this data, so a wide multi-select
 * across taxonomies stays safe. The body is untrusted: anything but a JSON
 * object is a 400, and every field is clamped or dropped rather than trusted.
 */
export function cardsParams(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'The body must be a JSON object.');
  }
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
  return {
    text: typeof body.text === 'string' ? body.text : null,
    filters: Object.fromEntries(
      KINDS.map((kind) => [kind, Array.isArray(filters[kind]) ? filters[kind].map(String) : []]),
    ),
    limit: clampInteger(body.limit, 100, 1, 200),
    offset: clampInteger(body.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function apiCards(database, { text, filters, limit, offset }) {
  const { items, total } = listCards(database, { text, filters, limit, offset });
  const { images, classifications } = listCardExtras(
    database,
    items.map((item) => item.identifier),
  );
  for (const item of items) {
    const image = images.get(item.identifier);
    item.image_url = image ? publicImageUrl(item.identifier, image) : null;
    item.domains = classifications.get(item.identifier).domain;
    item.origins = classifications.get(item.identifier).origin;
  }
  return { items, count: items.length, offset, total };
}

function apiCard(database, identifier) {
  const card = showCard(database, identifier);
  if (!card) throw new HttpError(404, 'Equipment card not found.');
  for (const image of card.images) image.url = publicImageUrl(identifier, image);
  return card;
}

const RANGES_BATCH_MAX = 200;

function apiCardRanges(database, identifier) {
  const ranges = cardRanges(showCard, database, identifier);
  if (ranges === null) throw new HttpError(404, 'Equipment card not found.');
  return ranges;
}

/** `POST ranges {identifiers}`: a map for batch use (a threat's WEG card may
 * carry several weapon systems worth looking up at once). Unlike the single
 * GET, an unknown identifier is not an error here: it simply maps to `[]`,
 * so one bad id in a batch does not fail the rest. */
function apiBatchRanges(database, body) {
  if (typeof body !== 'object' || body === null || !Array.isArray(body.identifiers)) {
    throw new HttpError(400, 'The body must have an "identifiers" array.');
  }
  if (body.identifiers.length > RANGES_BATCH_MAX) {
    throw new HttpError(400, `At most ${RANGES_BATCH_MAX} identifiers per request.`);
  }
  const result = {};
  for (const identifier of body.identifiers) {
    if (typeof identifier !== 'string' || !identifier.trim()) {
      throw new HttpError(400, 'Every identifier must be a non-empty string.');
    }
    result[identifier] = cardRanges(showCard, database, identifier) ?? [];
  }
  return result;
}

function apiTaxonomy(database, query) {
  const kind = query.get('kind');
  if (kind !== null && !KINDS.includes(kind)) throw new HttpError(400, 'Unknown taxonomy kind.');
  const usedOnly = ['1', 'true', 'yes'].includes((query.get('used_only') || '').toLowerCase());
  return taxonomy(database, kind, usedOnly);
}

async function serveImage(database, response, identifier, ordinalText) {
  const ordinal = Number.parseInt(ordinalText, 10);
  if (Number.isNaN(ordinal)) throw new HttpError(400, 'Bad image path.');
  const localPath = imagePath(database, identifier, ordinal);
  if (!localPath) throw new HttpError(404, 'Image not found.');
  const absolute = path.resolve(DATA_ROOT, localPath);
  if (!absolute.startsWith(DATA_ROOT + path.sep)) throw new HttpError(400, 'Bad image path.');
  let file;
  try {
    file = await open(absolute, 'r');
  } catch {
    throw new HttpError(404, 'Image not found.');
  }
  try {
    const [type, info] = await Promise.all([imageContentType(file), file.stat()]);
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': 'public, max-age=86400',
    });
  } finally {
    await file.close();
  }
  createReadStream(absolute).pipe(response);
}

/** A bookmark carries only an identifier; the card fields shown alongside it
 * are presentation, so they are looked up here rather than stored twice. A
 * card that has since disappeared from the reference data falls back to
 * showing its bare identifier instead of failing the whole list. */
function enrichBookmark(database, bookmark) {
  const card = showCard(database, bookmark.identifier);
  if (!card) {
    return { ...bookmark, name: bookmark.identifier, title: bookmark.identifier, image_url: null };
  }
  const image = card.images[0];
  return {
    ...bookmark,
    name: card.name,
    title: card.title,
    image_url: image ? publicImageUrl(bookmark.identifier, image) : null,
  };
}

function bookmarkId(text) {
  if (!/^\d+$/.test(text ?? '')) throw new HttpError(404, 'Unknown API route.');
  return Number(text);
}

let bookmarkStore;
bookmarksState.onClose(() => {
  bookmarkStore?.close();
  bookmarkStore = undefined;
});

const reference = referenceFile(DATABASE, openDatabase);

/** Every route needs the reference data built; checked once, here. */
function referenceDatabase() {
  const database = reference.get();
  if (!database) {
    throw new HttpError(
      503,
      'No equipment data. Build it with modules/equipment/tools/import_odin.py.',
    );
  }
  return database;
}

const BOOKMARKS_ROLE = 'analyst';

export default {
  id: ID,
  close() {
    reference.close();
    bookmarksState.close();
  },
  routes: [
    {
      method: 'GET',
      path: 'stats',
      verb: 'none',
      handler: () => stats(referenceDatabase()),
    },
    {
      method: 'GET',
      path: 'cards',
      verb: 'none',
      handler: ({ query }) => apiCards(referenceDatabase(), cardsParamsFromQuery(query)),
    },
    {
      method: 'POST',
      path: 'cards',
      verb: 'none',
      role: 'observer',
      changes: false,
      handler: ({ body }) => apiCards(referenceDatabase(), cardsParams(body)),
    },
    {
      method: 'GET',
      path: 'cards/:identifier/ranges',
      verb: 'none',
      handler: ({ params }) => apiCardRanges(referenceDatabase(), params.identifier),
    },
    {
      method: 'GET',
      path: 'cards/:identifier',
      verb: 'none',
      handler: ({ params }) => apiCard(referenceDatabase(), params.identifier),
    },
    {
      method: 'POST',
      path: 'ranges',
      verb: 'none',
      role: 'observer',
      changes: false,
      handler: ({ body }) => apiBatchRanges(referenceDatabase(), body),
    },
    {
      method: 'GET',
      path: 'taxonomy',
      verb: 'none',
      handler: ({ query }) => apiTaxonomy(referenceDatabase(), query),
    },
    {
      method: 'GET',
      path: 'images/:identifier/:ordinal',
      verb: 'none',
      handler: async ({ params, response }) => {
        await serveImage(referenceDatabase(), response, params.identifier, params.ordinal);
      },
    },
    {
      method: 'GET',
      path: 'bookmarks',
      verb: 'none',
      handler: () => {
        const database = referenceDatabase();
        bookmarkStore ??= openBookmarks(bookmarksState.path);
        return {
          items: bookmarkStore.list().map((bookmark) => enrichBookmark(database, bookmark)),
        };
      },
    },
    {
      method: 'POST',
      path: 'bookmarks',
      verb: 'none',
      role: BOOKMARKS_ROLE,
      reach: 'everyone',
      handler: ({ body, response }) => {
        const database = referenceDatabase();
        bookmarkStore ??= openBookmarks(bookmarksState.path);
        sendJson(response, enrichBookmark(database, bookmarkStore.create(body)), 201);
      },
    },
    {
      method: 'PATCH',
      path: 'bookmarks/:bookmark',
      verb: 'none',
      role: BOOKMARKS_ROLE,
      reach: 'everyone',
      handler: ({ params, body }) => {
        const database = referenceDatabase();
        bookmarkStore ??= openBookmarks(bookmarksState.path);
        return enrichBookmark(database, bookmarkStore.update(bookmarkId(params.bookmark), body));
      },
    },
    {
      method: 'DELETE',
      path: 'bookmarks/:bookmark',
      verb: 'none',
      role: BOOKMARKS_ROLE,
      reach: 'everyone',
      handler: ({ params }) => {
        referenceDatabase();
        bookmarkStore ??= openBookmarks(bookmarksState.path);
        bookmarkStore.remove(bookmarkId(params.bookmark));
        return { deleted: true };
      },
    },
  ],
};
