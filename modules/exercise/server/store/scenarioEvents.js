// The scenario clock, scheduled injects (scenario events) and the messages
// they fire.

import { HttpError } from '../../../../server/http.ts';
import { normalizeRelease } from '../../../../server/policy.ts';
import { dueEvents, reanchor, scenarioNowMs } from '../scenarioClock.js';

import { database } from './connection.js';
import { insertReportRow, prepareReportFields, validateReportInput } from './reports.js';
import { fetchRow, mutate, now, requireEnum, visibleRows } from './shared.js';

const SCENARIO_EVENT_KINDS = ['message', 'report'];
const DELIVERY_MODES = ['draft', 'scheduled'];

function readClockRow() {
  const row = fetchRow('scenario_clock', 1);
  if (row) return row;
  const timestamp = now();
  database
    .prepare(
      'INSERT INTO scenario_clock (id, base_real_ts, base_scenario_ts, rate, paused) VALUES (1, ?, ?, 1, 1)',
    )
    .run(timestamp, timestamp);
  return fetchRow('scenario_clock', 1);
}

export function readClock() {
  const row = readClockRow();
  return { ...row, paused: Boolean(row.paused), now: new Date(scenarioNowMs(row)).toISOString() };
}

export function patchClock({ rate, paused, jump_to: jumpTo }) {
  if (rate !== undefined && !(typeof rate === 'number' && rate > 0)) {
    throw new HttpError(400, 'rate must be a positive number.');
  }
  if (paused !== undefined && typeof paused !== 'boolean') {
    throw new HttpError(400, 'paused must be a boolean.');
  }
  let jumpToMs;
  if (jumpTo !== undefined) {
    jumpToMs = new Date(jumpTo).getTime();
    if (Number.isNaN(jumpToMs)) throw new HttpError(400, 'jump_to must be a valid timestamp.');
  }
  return mutate('scenario:clock', 'clock', null, () => {
    const current = readClockRow();
    const next = reanchor(current, { rate, paused, jumpToMs });
    database
      .prepare(
        'UPDATE scenario_clock SET base_real_ts = ?, base_scenario_ts = ?, rate = ?, paused = ? WHERE id = 1',
      )
      .run(next.base_real_ts, next.base_scenario_ts, next.rate, next.paused ? 1 : 0);
    return readClock();
  });
}

export function shapeScenarioEvent(row) {
  return { ...row, payload: JSON.parse(row.payload) };
}

export function listScenarioEvents() {
  return database
    .prepare('SELECT * FROM scenario_events ORDER BY trigger_at, id')
    .all()
    .map(shapeScenarioEvent);
}

/** An inject's `release_to` (default Blue): the cells its report or message goes to besides White. */
function injectReleaseTo(cells) {
  return normalizeRelease(cells ?? ['blue'], 'white');
}

/** A situation id from the body: null (no linked situation), or an existing
 * situation's id — 404 if it doesn't name a live row (situations are
 * White-only and never cell-owned, so there's no `access.see` for this). */
function resolveSituationId(value) {
  if (value === undefined || value === null) return null;
  const row = fetchRow('situations', value);
  if (!row) throw new HttpError(404, `Situation ${value} not found.`);
  return row.id;
}

/** Validates a report/message inject payload against its `kind` — shared by
 * create and update, since an edited pending event must stay just as valid
 * as a freshly created one. */
function validateEventPayload(kind, payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new HttpError(400, 'payload must be a JSON object.');
  }
  if (kind === 'message' && typeof payload.text !== 'string') {
    throw new HttpError(400, 'A message event needs a payload.text string.');
  }
  // A malformed report inject should fail now, when the Game Master can fix
  // it, not hours later when the clock reaches it mid-exercise. Injects
  // carry the same report payload as a hand-entered report, including
  // location, so this runs the same validator.
  if (kind === 'report') {
    validateReportInput({
      text: payload.text,
      reliability: payload.reliability ?? 'F',
      credibility: payload.credibility ?? 6,
      lon: payload.lon,
      lat: payload.lat,
      report_type: payload.report_type,
      fields: payload.fields,
      sidc: payload.sidc,
    });
  }
}

export function createScenarioEvent({
  trigger_at: triggerAt,
  kind,
  payload,
  situation_id: situationId,
  delivery_mode: deliveryMode,
}) {
  const triggerMs = new Date(triggerAt).getTime();
  if (Number.isNaN(triggerMs)) throw new HttpError(400, 'trigger_at must be a valid timestamp.');
  requireEnum(kind, 'kind', SCENARIO_EVENT_KINDS);
  validateEventPayload(kind, payload);
  const cleanDeliveryMode =
    deliveryMode !== undefined
      ? requireEnum(deliveryMode, 'delivery_mode', DELIVERY_MODES)
      : 'scheduled';
  const cleanSituationId = resolveSituationId(situationId);
  // The cells a fired inject reaches: both report and message injects are
  // White-owned (the game-master schedules them), released to `release_to`
  // (defaulting to Blue — the usual training audience) on firing. Scheduling
  // itself is White-only knowledge (no `owner_cell` released to anyone),
  // so nobody else sees "something is coming" in the activity log.
  const releaseTo = injectReleaseTo(payload.release_to);
  const timestamp = now();
  return mutate(
    'scenario:schedule',
    () => kind,
    { owner_cell: 'white', releasable_to: [] },
    () => {
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO scenario_events (trigger_at, kind, payload, state, situation_id, delivery_mode, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          new Date(triggerMs).toISOString(),
          kind,
          JSON.stringify({ ...payload, release_to: releaseTo }),
          cleanSituationId,
          cleanDeliveryMode,
          timestamp,
          timestamp,
        );
      return shapeScenarioEvent(fetchRow('scenario_events', Number(lastInsertRowid)));
    },
  );
}

function assertPendingEvent(id) {
  const row = fetchRow('scenario_events', id);
  if (!row) throw new HttpError(404, `Scenario event ${id} not found.`);
  if (row.state !== 'pending') throw new HttpError(409, `Event ${id} is already ${row.state}.`);
  return row;
}

/** `PATCH scenario-events/:id`: only a still-pending event may be edited —
 * once fired or cancelled it's a historical record, not a draft, so
 * `assertPendingEvent` (409) is the whole "no editing a fired/cancelled
 * event" rule. Every field is optional; only the ones given change,
 * `payload` replaced wholesale (like create) rather than merged, since a
 * partial payload could silently keep a stale `release_to` or field the
 * instructor meant to drop. */
export function updateScenarioEvent(id, patch) {
  const row = assertPendingEvent(id);
  const fields = [];
  const params = [];
  if (patch.trigger_at !== undefined) {
    const triggerMs = new Date(patch.trigger_at).getTime();
    if (Number.isNaN(triggerMs)) throw new HttpError(400, 'trigger_at must be a valid timestamp.');
    fields.push('trigger_at = ?');
    params.push(new Date(triggerMs).toISOString());
  }
  if (patch.payload !== undefined) {
    validateEventPayload(row.kind, patch.payload);
    const releaseTo = injectReleaseTo(patch.payload.release_to);
    fields.push('payload = ?');
    params.push(JSON.stringify({ ...patch.payload, release_to: releaseTo }));
  }
  if (patch.situation_id !== undefined) {
    fields.push('situation_id = ?');
    params.push(resolveSituationId(patch.situation_id));
  }
  if (patch.delivery_mode !== undefined) {
    fields.push('delivery_mode = ?');
    params.push(requireEnum(patch.delivery_mode, 'delivery_mode', DELIVERY_MODES));
  }
  if (!fields.length) return shapeScenarioEvent(row);
  return mutate('scenario:update', String(id), { owner_cell: 'white', releasable_to: [] }, () => {
    fields.push('updated_at = ?');
    params.push(now());
    database
      .prepare(`UPDATE scenario_events SET ${fields.join(', ')} WHERE id = ?`)
      .run(...params, id);
    return shapeScenarioEvent(fetchRow('scenario_events', id));
  });
}

export function cancelScenarioEvent(id) {
  assertPendingEvent(id);
  mutate('scenario:cancel', String(id), { owner_cell: 'white', releasable_to: [] }, () => {
    database
      .prepare("UPDATE scenario_events SET state = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now(), id);
  });
}

export function shapeMessage(row) {
  return { ...row, releasable_to: JSON.parse(row.releasable_to) };
}

export function listMessages(access) {
  return visibleRows(access, 'message', 'messages', 'fired_at DESC, id DESC').map(shapeMessage);
}

function insertMessageRow(text, firedAt, releasableTo) {
  const { lastInsertRowid } = database
    .prepare(
      "INSERT INTO messages (text, fired_at, owner_cell, releasable_to, created_at) VALUES (?, ?, 'white', ?, ?)",
    )
    .run(text, firedAt, JSON.stringify(releasableTo), firedAt);
  return Number(lastInsertRowid);
}

/**
 * Fires one event: for a report inject, creates the report from the
 * payload, owned by White and released to `payload.release_to`; for a
 * message inject, inserts a `messages` row the same way. Always called
 * from inside another mutation's transaction (`fireScenarioEvent`), so this
 * inserts rows directly rather than through `createReport`, which would try
 * to open a second, nested transaction. Returns the ids created and the
 * cells the fired item reaches, for the caller to announce.
 */
function fireOne(row, access) {
  const timestamp = now();
  const payload = JSON.parse(row.payload);
  const releaseTo = injectReleaseTo(payload.release_to);
  let createdReportId = null;
  let createdMessageId = null;
  if (row.kind === 'report') {
    const fields = prepareReportFields(
      {
        text: payload.text,
        occurred_at: payload.occurred_at ?? row.trigger_at,
        source: payload.source ?? 'Scenario inject',
        author: payload.author ?? 'Game Master',
        reliability: payload.reliability ?? 'F',
        credibility: payload.credibility ?? 6,
        lon: payload.lon,
        lat: payload.lat,
        report_type: payload.report_type,
        fields: payload.fields,
        sidc: payload.sidc,
        nai_id: payload.nai_id,
        track_id: payload.track_id,
      },
      access,
    );
    createdReportId = insertReportRow(fields, 'white', releaseTo).id;
  } else {
    createdMessageId = insertMessageRow(payload.text, timestamp, releaseTo);
  }
  database
    .prepare(
      "UPDATE scenario_events SET state = 'fired', fired_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(timestamp, timestamp, row.id);
  return { reportId: createdReportId, messageId: createdMessageId, cells: ['white', ...releaseTo] };
}

/** `POST scenario-events/:id/fire`'s handler: fires one event — whether a
 * human game-master clicked "Fire now" or the module's own `connect`d
 * ticker called this through `runAs` — and announces it to exactly the
 * cells the inject reaches (docs/adr/0002: `reach: 'handler'`). */
export function fireScenarioEvent(id, access) {
  const row = assertPendingEvent(id);
  return mutate('scenario:fire', String(id), { owner_cell: 'white', releasable_to: [] }, () => {
    const { cells } = fireOne(row, access);
    return { event: shapeScenarioEvent(fetchRow('scenario_events', id)), cells };
  });
}

/** Pending events whose trigger time has arrived, in trigger order — for
 * the module's own `connect`d ticker, which fires each through `runAs`
 * individually so every one is announced only to its own cells. */
export function dueScenarioEventIds() {
  const clock = readClockRow();
  const nowMs = scenarioNowMs(clock);
  // Draft events never auto-fire, no matter how far in the past their
  // `trigger_at` sits — a draft is only sent by an explicit fire.
  const pending = database
    .prepare(
      "SELECT * FROM scenario_events WHERE state = 'pending' AND delivery_mode = 'scheduled'",
    )
    .all();
  return dueEvents(pending, nowMs).map((row) => row.id);
}
