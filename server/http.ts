import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

/** Any value `JSON.parse` can produce: what a request body is before validation. */
export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json | undefined };

/** A JSON object (not an array or null): the only body shape most routes accept. */
export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `error.message` for an Error, else the thrown value as text: what a `catch` can report. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HttpError extends Error {
  status: number;

  /** `details`: extra fields copied onto the error (and its JSON body). */
  constructor(status: number, message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    if (details && typeof details === 'object') Object.assign(this, details);
  }
}

export function sendJson(response: ServerResponse, value: Json, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/** Send a binary body. Tile URLs carry a data version, so they may be cached long. */
export function sendBytes(
  response: ServerResponse,
  body: Uint8Array,
  contentType: string,
  cacheControl = 'no-store',
) {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': cacheControl,
  });
  response.end(body);
}

export function integerParameter(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new HttpError(400, `The ${name} must be an integer.`);
  return Math.min(Math.max(value, minimum), maximum);
}

export function numberParameter(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) throw new HttpError(400, `The ${name} must be a number.`);
  return Math.min(Math.max(value, minimum), maximum);
}

/** Read a JSON request body. Rejects anything larger than `limit` bytes. */
export async function readJson(request: IncomingMessage, limit = 1 << 20): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, 'A JSON body is required.');
  try {
    const parsed: Json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed;
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
}

/** A body's fields: a non-object body reads as having none (each route validates its own). */
export function fieldsOf(body: Json | undefined): JsonObject {
  return isJsonObject(body) ? body : {};
}

/** A JSON request body that must be an object (every form-like route's body). */
export async function readJsonObject(
  request: IncomingMessage,
  limit = 1 << 20,
): Promise<JsonObject> {
  const body = await readJson(request, limit);
  if (!isJsonObject(body)) throw new HttpError(400, 'A JSON object body is required.');
  return body;
}

/**
 * Serve a file with byte-range support. PMTiles archives are read with Range
 * requests, so a plain 200 response would force the client to download the
 * whole archive for every tile.
 */
export async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  absolutePath: string,
  contentType: string,
) {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw new HttpError(404, 'File not found.');
  }
  if (!info.isFile()) throw new HttpError(404, 'File not found.');
  // Revalidate on every use: these files are rebuilt in place, and a cached
  // byte range of the old file mixed with ranges of the new one is corrupt.
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: OutgoingHttpHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  if (request.method === 'HEAD') {
    response.writeHead(200, { ...headers, 'Content-Length': info.size });
    response.end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
  if (!range) {
    response.writeHead(200, { ...headers, 'Content-Length': info.size });
    createReadStream(absolutePath).pipe(response);
    return;
  }
  const [, rawStart, rawEnd] = range;
  let start = rawStart ? Number.parseInt(rawStart, 10) : null;
  let end = rawEnd ? Number.parseInt(rawEnd, 10) : info.size - 1;
  if (start === null) {
    // Suffix range: the last N bytes.
    start = Math.max(info.size - end, 0);
    end = info.size - 1;
  }
  if (start >= info.size || start > end) {
    response.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
    response.end();
    return;
  }
  end = Math.min(end, info.size - 1);
  response.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${start}-${end}/${info.size}`,
    'Content-Length': end - start + 1,
  });
  createReadStream(absolutePath, { start, end }).pipe(response);
}
