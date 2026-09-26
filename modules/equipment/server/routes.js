import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, integerParameter, readJson, sendJson } from '../../../server/http.js';
import { LIVE_ALL } from '../../../server/policy.js';
import { referenceFile } from '../../../server/reference.js';
import { dataDirectory, stateDirectory } from '../../../server/state.js';
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

const ID = 'equipment';
const DATA_ROOT = dataDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'),
);
const STATE_ROOT = stateDirectory(
  ID,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state'),
);
const DATABASE = path.join(DATA_ROOT, 'unitgenerator.db');
const BOOKMARKS_DATABASE = path.join(STATE_ROOT, 'bookmarks.db');
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

async function serveImage(database, response, encodedPath) {
  const parts = encodedPath.split('/');
  const ordinal = Number.parseInt(parts[1], 10);
  if (parts.length !== 2 || Number.isNaN(ordinal)) throw new HttpError(400, 'Bad image path.');
  const localPath = imagePath(database, decodeURIComponent(parts[0]), ordinal);
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

let bookmarkStore;

async function handleBookmarks(database, { route, request, response }) {
  bookmarkStore ??= openBookmarks(BOOKMARKS_DATABASE);
  const enrich = (bookmark) => enrichBookmark(database, bookmark);
  const idMatch = /^bookmarks\/(\d+)$/.exec(route);

  if (route === 'bookmarks') {
    if (request.method === 'GET') {
      sendJson(response, { items: bookmarkStore.list().map(enrich) });
      return;
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      request.liveCells = LIVE_ALL; // bookmarks are shared by every cell
      sendJson(response, enrich(bookmarkStore.create(body)), 201);
      return;
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  if (idMatch) {
    const id = Number(idMatch[1]);
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      request.liveCells = LIVE_ALL;
      sendJson(response, enrich(bookmarkStore.update(id, body)));
      return;
    }
    if (request.method === 'DELETE') {
      bookmarkStore.remove(id);
      request.liveCells = LIVE_ALL;
      sendJson(response, { deleted: true });
      return;
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  throw new HttpError(404, 'Unknown API route.');
}

const reference = referenceFile(DATABASE, openDatabase);

export default {
  id: ID,
  async handle({ route, url, request, response }) {
    const database = reference.get();
    if (!database) {
      throw new HttpError(
        503,
        'No equipment data. Build it with modules/equipment/tools/import_odin.py.',
      );
    }
    const rangesMatch = /^cards\/(.+)\/ranges$/.exec(route);
    if (route === 'stats') sendJson(response, stats(database));
    else if (route === 'cards') {
      const params =
        request.method === 'POST'
          ? cardsParams(await readJson(request))
          : cardsParamsFromQuery(url.searchParams);
      sendJson(response, apiCards(database, params));
    } else if (rangesMatch) {
      if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      sendJson(response, apiCardRanges(database, decodeURIComponent(rangesMatch[1])));
    } else if (route === 'ranges') {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      sendJson(response, apiBatchRanges(database, await readJson(request)));
    } else if (route.startsWith('cards/')) {
      sendJson(response, apiCard(database, decodeURIComponent(route.slice('cards/'.length))));
    } else if (route === 'taxonomy') sendJson(response, apiTaxonomy(database, url.searchParams));
    else if (route.startsWith('images/')) {
      await serveImage(database, response, route.slice('images/'.length));
    } else if (route === 'bookmarks' || route.startsWith('bookmarks/')) {
      await handleBookmarks(database, { route, request, response });
    } else throw new HttpError(404, 'Unknown API route.');
  },
  close() {
    reference.close();
    bookmarkStore?.close();
    bookmarkStore = undefined;
  },
};
