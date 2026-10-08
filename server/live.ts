import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpError } from './http.ts';

/** How often an idle connection gets a comment line, so proxies and browsers
 * never time it out as dead — and, in `on` mode, how often its session is
 * re-checked (IPB-AUTH-005): a stream outliving a logout elsewhere or a
 * removed/repassworded account is closed within one tick of this. */
const KEEPALIVE_MS = 25000;
/** A dev box serving a classroom, not the public internet: bounded so a
 * runaway client (or a hundred stale tabs) can't exhaust file descriptors. */
const MAX_CLIENTS = 64;
/** One signed-in user (the lowest role included) can't starve everyone
 * else's live updates by opening every global slot (IPB-AUTH-005). */
const MAX_CLIENTS_PER_USER = 8;

/** One change announcement; `cells` limits it to those cells (plus White). */
export type LiveEvent = {
  module: string;
  route: string;
  method?: string;
  client?: string | null;
  user?: string;
  at?: string;
  cells?: string[];
};

type LiveAccess = { cell: string | null; role: string | null; admin?: boolean | number };
type LiveClient = {
  keepAlive: ReturnType<typeof setInterval>;
  user: string | undefined;
  cell: string | null;
  role: string | null;
  admin: boolean;
  tokenHash: string | null;
};

const clients = new Map<ServerResponse, LiveClient>();

/** C4: a stream receives `event` when it carries no `cells` (a global
 * change), or the stream's user is White/admin, or the stream's cell is
 * among `event.cells`. */
function deliverTo(meta: LiveClient, event: LiveEvent) {
  if (!event.cells) return true;
  if (meta.admin || meta.cell === 'white') return true;
  return meta.cell != null && event.cells.includes(meta.cell);
}

/** Broadcasts `event` (any JSON-serialisable value) to every open
 * subscriber it's visible to (C4). */
export function publish(event: LiveEvent) {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const [response, meta] of clients) {
    if (deliverTo(meta, event)) response.write(payload);
  }
}

export function subscriberCount() {
  return clients.size;
}

function countForUser(user: string | undefined) {
  let n = 0;
  for (const meta of clients.values()) {
    if (meta.user === user) n += 1;
  }
  return n;
}

function forget(response: ServerResponse) {
  const meta = clients.get(response);
  if (!meta) return;
  clearInterval(meta.keepAlive);
  clients.delete(response);
}

/**
 * Opens an SSE stream on `response` and registers it until the connection
 * closes. `user` (a name, or the fixed `off`-mode operator) bounds the
 * per-user cap above. `cell`/`admin`/`role` (C1's shape at connect time)
 * decide which `publish`ed events this stream receives (C4) and are
 * re-checked on every keep-alive tick. `tokenHash` (`on` mode only) is how
 * `closeStreamsForToken` finds this stream on logout. `revalidate()` — call
 * with no side effects beyond a session's own sliding expiry — is
 * re-checked on every keep-alive tick:
 * - returning falsy ends the stream instead of sending the comment, so a
 *   session removed or repassworded elsewhere (IPB-AUTH-004/005) is
 *   noticed within one `KEEPALIVE_MS` even though that happened in
 *   another process (the CLI) with no way to signal this one directly;
 * - returning `{ cell, role, admin }` (the current C1 shape) ends the
 *   stream instead if any of those changed since connecting (or since the
 *   last tick) — a membership change (C4) closes the stream the same way,
 *   so the client's reconnect picks up its new cell/role rather than an
 *   open stream silently keeping the old filtering/permissions;
 * - the default (`off` mode, or no token to re-check) returns `true`: no
 *   membership to track, never closes on its own.
 */
export function handleLive(
  request: IncomingMessage,
  response: ServerResponse,
  {
    user,
    cell = null,
    role = null,
    admin = false,
    tokenHash = null,
    revalidate = () => true,
  }: {
    user?: string;
    cell?: string | null;
    role?: string | null;
    admin?: boolean | number;
    tokenHash?: string | null;
    revalidate?: () => LiveAccess | boolean | null | undefined;
  } = {},
) {
  if (clients.size >= MAX_CLIENTS) {
    throw new HttpError(503, 'Too many live subscribers; close an idle tab and retry.');
  }
  if (countForUser(user) >= MAX_CLIENTS_PER_USER) {
    throw new HttpError(503, 'Too many live subscribers for this account; close a tab and retry.');
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  response.write(': connected\n\n');
  const keepAlive = setInterval(() => {
    const result = revalidate();
    if (!result) {
      forget(response);
      response.end();
      return;
    }
    if (typeof result === 'object') {
      const meta = clients.get(response);
      const changed =
        meta &&
        (result.cell !== meta.cell ||
          result.role !== meta.role ||
          Boolean(result.admin) !== meta.admin);
      if (changed) {
        forget(response);
        response.end();
        return;
      }
    }
    response.write(': keep-alive\n\n');
  }, KEEPALIVE_MS);
  clients.set(response, { keepAlive, user, cell, role, admin: Boolean(admin), tokenHash });
  const cleanup = () => forget(response);
  request.once('close', cleanup);
  response.once('close', cleanup);
}

/** Ends every stream opened with this exact session token, e.g. right after
 * a same-process `POST /api/auth/logout` (IPB-AUTH-005). */
export function closeStreamsForToken(tokenHash: string | null) {
  if (!tokenHash) return;
  // Deleting the current (or an unvisited) entry mid-iteration is
  // well-defined for `Map`, so this needs no defensive array copy first.
  for (const [response, meta] of clients) {
    if (meta.tokenHash === tokenHash) {
      forget(response);
      response.end();
    }
  }
}

/** Ends every stream open for `user`, e.g. after removing them or changing
 * their password from *this* process. The CLI runs as a separate process
 * with no channel into a running server's memory, so a CLI-driven removal
 * or password change relies on `revalidate` at the next keep-alive tick
 * instead — this is for same-process callers that can act immediately. */
export function closeStreamsForUser(user: string) {
  for (const [response, meta] of clients) {
    if (meta.user === user) {
      forget(response);
      response.end();
    }
  }
}

/** Ends every open stream; called when the dev/preview server itself closes. */
export function closeAllSubscribers() {
  for (const response of clients.keys()) {
    forget(response);
    response.end();
  }
}
