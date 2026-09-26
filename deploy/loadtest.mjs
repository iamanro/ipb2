#!/usr/bin/env node
/**
 * Classroom load test: N simulated users against a running deployment,
 * through Caddy, the way browsers use it. Each user signs in, holds a live
 * (SSE) stream, pans the map (vector basemap range reads, satellite and
 * hillshade tiles), refreshes lists, files reports, and every analyst runs a
 * viewshed now and then. Prints latency percentiles per kind of request,
 * errors by status, and how fast a report reached the other members of its
 * cell live.
 *
 *   IPB_LOADTEST_ADMIN_PASSWORD=... NODE_EXTRA_CA_CERTS=ca.crt \
 *     node deploy/loadtest.mjs --url https://ac.lan [--users 30] [--minutes 5] [--admin admin]
 *
 * It creates users `load01`..`loadNN` (White/Blue/Red) and their reports,
 * and deletes both at the end. Run it before an exercise, not during one.
 * No dependencies beyond Node 22+.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const BASE = (flag('url', 'https://ac.lan') ?? '').replace(/\/$/, '');
const USERS = Number(flag('users', '30'));
const MINUTES = Number(flag('minutes', '5'));
const ADMIN = flag('admin', 'admin');
const ADMIN_PASSWORD = process.env.IPB_LOADTEST_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('Set IPB_LOADTEST_ADMIN_PASSWORD to the admin account password.');
  process.exit(1);
}

// Libavá training area: inside both the ortho and the DMR 4G detail coverage.
const CENTRE = { lon: 17.52, lat: 49.66 };

const samples = new Map(); // kind -> [ms]
const errors = new Map(); // `${kind} ${status}` -> count
const liveLatency = [];
const pendingReports = new Map(); // report text -> { at, cell, from }
let basemapBytes = 1_000_000;
let stopping = false;

function record(kind, ms, status) {
  if (kind === 'setup' || kind === 'cleanup') return;
  if (status >= 400 || status === 0) {
    const key = `${kind} ${status || 'network'}`;
    errors.set(key, (errors.get(key) ?? 0) + 1);
    return;
  }
  if (!samples.has(kind)) samples.set(kind, []);
  samples.get(kind).push(ms);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

function client(name) {
  let cookie = '';
  return {
    name,
    async request(kind, path, { method, body, headers, raw, onResponse } = {}) {
      const started = performance.now();
      let status = 0;
      try {
        const response = await fetch(BASE + path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: {
            Cookie: cookie,
            Origin: BASE,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        status = response.status;
        onResponse?.(response);
        const set = response.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const payload = raw ? await response.arrayBuffer() : await response.text();
        record(kind, performance.now() - started, status);
        if (raw) return { status };
        try {
          return { status, json: JSON.parse(payload) };
        } catch {
          return { status, json: null };
        }
      } catch (error) {
        record(kind, performance.now() - started, 0);
        return { status: 0, error };
      }
    },
    cookie: () => cookie,
  };
}

async function openLive(user) {
  const controller = new AbortController();
  const response = await fetch(`${BASE}/api/live`, {
    headers: { Cookie: user.client.cookie() },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`live stream for ${user.name}: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = chunk.split('\n').find((text) => text.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          user.events += 1;
          if (event.route === 'reports' && event.method === 'POST' && event.user !== user.name) {
            for (const [text, sent] of pendingReports) {
              if (
                sent.from === event.user &&
                sent.cell === user.cell &&
                !sent.seenBy.has(user.name)
              ) {
                sent.seenBy.add(user.name);
                liveLatency.push(Date.now() - sent.at);
                if (sent.seenBy.size >= sent.expected) pendingReports.delete(text);
                break;
              }
            }
          }
        }
      }
    } catch {
      // aborted at the end of the run
    }
  })();
  return controller;
}

async function panMap(user) {
  const centre = { lon: CENTRE.lon + jitter(-0.12, 0.12), lat: CENTRE.lat + jitter(-0.08, 0.08) };
  const jobs = [];
  // Vector basemap: the header, then scattered range reads like OpenLayers makes.
  jobs.push(
    user.client.request('pmtiles', '/api/terrain/tiles/vector.pmtiles', {
      headers: { Range: 'bytes=0-16383' },
      raw: true,
    }),
  );
  for (let index = 0; index < 8; index += 1) {
    const start = Math.floor(Math.random() * Math.max(1, basemapBytes - 65536));
    jobs.push(
      user.client.request('pmtiles', '/api/terrain/tiles/vector.pmtiles', {
        headers: { Range: `bytes=${start}-${start + 65535}` },
        raw: true,
      }),
    );
  }
  const satellite = tileOf(centre.lon, centre.lat, 14);
  for (let dx = -2; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      jobs.push(
        user.client.request(
          'satellite',
          `/api/terrain/satellite/14/${satellite.x + dx}/${satellite.y + dy}.jpg`,
          { raw: true },
        ),
      );
    }
  }
  const z = 13 + Math.floor(Math.random() * 3);
  const hill = tileOf(centre.lon, centre.lat, z);
  for (let dx = -2; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      jobs.push(
        user.client.request(
          'hillshade',
          `/api/terrain/hillshade/${z}/${hill.x + dx}/${hill.y + dy}.png`,
          { raw: true },
        ),
      );
    }
  }
  await Promise.all(jobs);
}

async function refreshLists(user) {
  await Promise.all([
    user.client.request('list', '/api/ipb/studies'),
    user.client.request('list', '/api/exercise/reports'),
    user.client.request('list', '/api/exercise/requirements'),
    user.client.request('list', '/api/exercise/tracks'),
    user.client.request('list', '/api/exercise/messages'),
  ]);
}

async function fileReport(user, cellSizes) {
  const text = `load report ${user.name} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  const sent = {
    at: Date.now(),
    cell: user.cell,
    from: user.name,
    seenBy: new Set(),
    expected: cellSizes[user.cell] - 1,
  };
  pendingReports.set(text, sent);
  const result = await user.client.request('write', '/api/exercise/reports', {
    body: { text, reliability: 'B', credibility: 2 },
  });
  if (result.status === 200) user.reports.push(result.json.id);
  else pendingReports.delete(text);
}

async function viewshed(user) {
  const at = `${(CENTRE.lon + jitter(-0.1, 0.1)).toFixed(5)},${(CENTRE.lat + jitter(-0.06, 0.06)).toFixed(5)}`;
  const radius = Math.round(jitter(3000, 10000));
  await user.client.request(
    'viewshed',
    `/api/terrain/viewshed?at=${at}&radius=${radius}&observer=2&target=2&cell=50`,
  );
}

async function simulate(user, deadline, cellSizes) {
  let nextPan = 0;
  let nextReport = Date.now() + jitter(5_000, 30_000);
  let nextViewshed = Date.now() + jitter(10_000, 90_000);
  while (Date.now() < deadline && !stopping) {
    const now = Date.now();
    if (now >= nextPan) {
      await panMap(user);
      nextPan = now + jitter(8_000, 20_000);
    }
    await refreshLists(user);
    if (user.role !== 'observer' && now >= nextReport) {
      await fileReport(user, cellSizes);
      nextReport = now + jitter(20_000, 45_000);
    }
    if (user.role === 'analyst' && now >= nextViewshed) {
      await viewshed(user);
      nextViewshed = now + jitter(60_000, 150_000);
    }
    await sleep(jitter(3_000, 8_000));
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(users, seconds) {
  const rows = [...samples.entries()].map(([kind, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      kind,
      requests: sorted.length,
      'per s': (sorted.length / seconds).toFixed(1),
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      p99: Math.round(percentile(sorted, 99)),
      max: Math.round(sorted.at(-1)),
    };
  });
  console.log('\nLatency by request kind (ms):');
  console.table(rows);
  console.log('Errors:', errors.size ? Object.fromEntries(errors) : 'none');
  const live = [...liveLatency].sort((a, b) => a - b);
  console.log(
    `Live updates: ${users.reduce((sum, user) => sum + user.events, 0)} events received; ` +
      `report -> same-cell users: ${live.length} deliveries, p50 ${Math.round(percentile(live, 50))} ms, ` +
      `p95 ${Math.round(percentile(live, 95))} ms, max ${Math.round(live.at(-1) ?? NaN)} ms`,
  );
}

async function main() {
  const admin = client(ADMIN);
  const login = await admin.request('setup', '/api/auth/login', {
    body: { name: ADMIN, password: ADMIN_PASSWORD },
  });
  if (login.status !== 200)
    throw new Error(`admin sign-in failed: ${login.status} ${JSON.stringify(login.json)}`);

  await admin.request('setup', '/api/terrain/tiles/vector.pmtiles', {
    headers: { Range: 'bytes=0-0' },
    raw: true,
    onResponse: (response) => {
      const total = Number(response.headers.get('content-range')?.split('/')[1]);
      if (total > 0) basemapBytes = total;
    },
  });

  const cells = ['white', 'blue', 'red'];
  const users = [];
  for (let index = 1; index <= USERS; index += 1) {
    const name = `load${String(index).padStart(2, '0')}`;
    // Two White game-masters, the rest split between Blue and Red, a few observers each.
    const cell = index <= 2 ? 'white' : cells[1 + (index % 2)];
    const role = index <= 2 ? 'game-master' : index % 7 === 0 ? 'observer' : 'analyst';
    const temporary = `temporary-${name}-${Date.now()}`;
    await admin.request('setup', `/api/auth/users/${name}`, { method: 'DELETE' });
    const created = await admin.request('setup', '/api/auth/users', {
      body: { name, password: temporary },
    });
    if (created.status !== 200)
      throw new Error(`creating ${name}: ${created.status} ${JSON.stringify(created.json)}`);
    const member = await admin.request('setup', `/api/auth/members/${name}`, {
      method: 'PUT',
      body: { cell, role },
    });
    if (member.status !== 200)
      throw new Error(`membership for ${name}: ${member.status} ${JSON.stringify(member.json)}`);
    users.push({ name, cell, role, temporary, client: client(name), events: 0, reports: [] });
  }
  const cellSizes = Object.fromEntries(
    cells.map((cell) => [cell, users.filter((user) => user.cell === cell).length]),
  );
  console.log(`Created ${users.length} users: ${JSON.stringify(cellSizes)}. Signing in...`);

  for (const user of users) {
    await user.client.request('login', '/api/auth/login', {
      body: { name: user.name, password: user.temporary },
    });
    const changed = await user.client.request('login', '/api/auth/password', {
      body: { current: user.temporary, next: `${user.temporary}-own` },
    });
    if (changed.status !== 200)
      throw new Error(`password change for ${user.name}: ${changed.status}`);
  }
  const streams = await Promise.all(users.map((user) => openLive(user)));
  // Every user's first map load at once: the worst moment of a classroom start.
  const started = Date.now();
  await Promise.all(users.map((user) => panMap(user)));
  console.log(
    `All ${users.length} first map loads done in ${Date.now() - started} ms. Running for ${MINUTES} min...`,
  );

  const deadline = Date.now() + MINUTES * 60_000;
  const runStart = Date.now();
  await Promise.all(users.map((user) => simulate(user, deadline, cellSizes)));
  const seconds = (Date.now() - runStart) / 1000;
  await sleep(1000); // let the last live events arrive
  for (const stream of streams) stream.abort();
  report(users, seconds);

  // Clean up: each user's own reports, then the users themselves.
  for (const user of users) {
    for (const id of user.reports)
      await user.client.request('cleanup', `/api/exercise/reports/${id}`, { method: 'DELETE' });
    await admin.request('cleanup', `/api/auth/users/${user.name}`, { method: 'DELETE' });
  }
  console.log('Removed the load-test users and their reports.');
}

process.on('SIGINT', () => {
  stopping = true;
});
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
