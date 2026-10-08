/**
 * The client half of C2: one shared `EventSource` against `/api/live`, with
 * auto-reconnect and exponential backoff. `clientId` is sent as the
 * `X-Client-Id` header by every module's fetch helper, so events this tab
 * caused itself are dropped here before reaching subscribers — a subscriber
 * only ever hears about *other* clients' changes.
 *
 * The server never broadcasts a raw client id back (IPB-AUTH-006): a
 * reusable raw id, seen by every subscriber including an observer, would let
 * one tab impersonate another's id to suppress that tab's own refresh. It
 * publishes a short hash instead, so this hashes its own id the same way to
 * compare.
 */
export const clientId = crypto.randomUUID();

const CLIENT_ID_HASH_LENGTH = 16;

async function sha256HexPrefix(text, length) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

const clientIdHash = await sha256HexPrefix(clientId, CLIENT_ID_HASH_LENGTH);

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

const subscribers = new Set();
let source = null;
let backoff = MIN_BACKOFF_MS;
let reconnectTimer = null;

function connect() {
  if (source || !subscribers.size) return;
  source = new EventSource('/api/live');
  source.addEventListener('open', () => {
    backoff = MIN_BACKOFF_MS;
  });
  source.addEventListener('message', (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (event.client === clientIdHash) return;
    for (const entry of subscribers) {
      if (!entry.filter || entry.filter(event)) entry.handler(event);
    }
  });
  source.addEventListener('error', () => {
    source?.close();
    source = null;
    if (!subscribers.size) return;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  });
}

function disconnectIfIdle() {
  if (subscribers.size) return;
  window.clearTimeout(reconnectTimer);
  source?.close();
  source = null;
  backoff = MIN_BACKOFF_MS;
}

/**
 * `filter(event)` is an optional predicate over `{ module, method, route,
 * client, user, at }`; omit it (or pass `null`) to hear every event.
 * `handler(event)` is never called for this tab's own events. Returns an
 * unsubscribe function.
 */
export function subscribe(filter, handler) {
  if (handler === undefined) {
    handler = filter;
    filter = null;
  }
  const entry = { filter, handler };
  subscribers.add(entry);
  connect();
  return () => {
    subscribers.delete(entry);
    disconnectIfIdle();
  };
}
