import type { SQLInputValue } from 'node:sqlite';
// Instructor authoring: the private story and its situations.

import { fieldsOf, HttpError, type Json } from '../../../../server/http.ts';
import { countRows, numOrNull, type Row } from '../../../../server/state.ts';

import { database } from './connection.ts';
import { readSituation, readStory as readStoryColumns } from './rows.ts';
import { listScenarioEvents } from './scenarioEvents.ts';
import {
  existingRow,
  fetchRow,
  mutate,
  now,
  optionalString,
  requireBoundedString,
  requireEnum,
  requireInteger,
} from './shared.ts';

const SITUATION_STATUSES = ['planned', 'active', 'complete'];

//
// White-only narrative content (routes.js gates every one of these behind
// `access.white`, on top of the `game-master` role check, since `role`
// alone doesn't imply White — a Blue game-master must never reach this).
// Neither table is cell-owned: `story` is the one exercise-wide row (same
// lazy-insert-on-first-read pattern as `scenario_clock`), `situations` are
// plain White rows with no `owner_cell`/`releasable_to` to check.

function shapeStory(raw: Row) {
  const row = readStoryColumns(raw);
  return {
    title: row.title,
    briefing: row.briefing,
    objectives: row.objectives,
    instructor_notes: row.instructor_notes,
  };
}

function readStoryRow(): Row {
  const row = fetchRow('story', 1);
  if (row) return row;
  database
    .prepare(
      "INSERT INTO story (id, title, briefing, objectives, instructor_notes, updated_at) VALUES (1, '', '', '', '', ?)",
    )
    .run(now());
  return existingRow('story', 1);
}

export function readStory() {
  return shapeStory(readStoryRow());
}

/** Every field is optional and free text (Blue-facing briefing, private
 * objectives/notes) — no length bound beyond the dispatcher's body cap;
 * an instructor authoring a briefing needs more room than a name field. */
export function patchStory(input: Json) {
  const patch = fieldsOf(input);
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
  for (const key of ['title', 'briefing', 'objectives', 'instructor_notes']) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(optionalString(patch[key], key) ?? '');
    }
  }
  return mutate('instructor:story', 'story', { owner_cell: 'white', releasable_to: [] }, () => {
    readStoryRow(); // ensures the singleton row exists before this UPDATE
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database.prepare(`UPDATE story SET ${fields.join(', ')} WHERE id = 1`).run(...params);
    }
    return readStory();
  });
}

function shapeSituation(raw: Row) {
  const row = readSituation(raw);
  return {
    id: row.id,
    title: row.title,
    ground_truth: row.ground_truth,
    expected_response: row.expected_response,
    status: row.status,
    sort_order: row.sort_order,
  };
}

export function listSituations() {
  return database
    .prepare('SELECT * FROM situations ORDER BY sort_order, id')
    .all()
    .map(shapeSituation);
}

function nextSituationSortOrder() {
  const row = database.prepare('SELECT MAX(sort_order) AS m FROM situations').get();
  return (row ? (numOrNull(row, 'm') ?? -1) : -1) + 1;
}

/** Setting a situation active deactivates whichever one was active before
 * (the partial unique index on `situations(status)` allows only one), same
 * pattern as `scenarios(active)` — the prior active situation moves to
 * 'complete' rather than back to 'planned': the instructor is advancing the
 * story to its next beat, not un-scheduling the one just finished. */
function deactivatePriorSituation(excludeId: number | null, timestamp: string) {
  database
    .prepare(
      "UPDATE situations SET status = 'complete', updated_at = ? WHERE status = 'active' AND id <> ?",
    )
    .run(timestamp, excludeId ?? -1);
}

export function createSituation(input: Json) {
  const {
    title,
    ground_truth: groundTruth,
    expected_response: expectedResponse,
    status,
    sort_order: sortOrder,
  } = fieldsOf(input);
  const cleanTitle = requireBoundedString(title, 'title', 200);
  const cleanGroundTruth = optionalString(groundTruth, 'ground_truth') ?? '';
  const cleanExpected = optionalString(expectedResponse, 'expected_response') ?? '';
  const cleanStatus =
    status !== undefined ? requireEnum(status, 'status', SITUATION_STATUSES) : 'planned';
  const cleanSort = sortOrder !== undefined ? requireInteger(sortOrder, 'sort_order') : undefined;
  return mutate(
    'situation:create',
    () => cleanTitle,
    { owner_cell: 'white', releasable_to: [] },
    () => {
      const timestamp = now();
      if (cleanStatus === 'active') deactivatePriorSituation(null, timestamp);
      const order = cleanSort ?? nextSituationSortOrder();
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO situations (title, ground_truth, expected_response, status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(cleanTitle, cleanGroundTruth, cleanExpected, cleanStatus, order, timestamp, timestamp);
      return shapeSituation(existingRow('situations', Number(lastInsertRowid)));
    },
  );
}

export function updateSituation(id: number, input: Json) {
  const patch = fieldsOf(input);
  const existing = fetchRow('situations', id);
  if (!existing) throw new HttpError(404, `Situation ${id} not found.`);
  const cleanTitle = 'title' in patch ? requireBoundedString(patch.title, 'title', 200) : undefined;
  const cleanGroundTruth =
    'ground_truth' in patch
      ? (optionalString(patch.ground_truth, 'ground_truth') ?? '')
      : undefined;
  const cleanExpected =
    'expected_response' in patch
      ? (optionalString(patch.expected_response, 'expected_response') ?? '')
      : undefined;
  const cleanStatus =
    'status' in patch ? requireEnum(patch.status, 'status', SITUATION_STATUSES) : undefined;
  const cleanSort =
    'sort_order' in patch ? requireInteger(patch.sort_order, 'sort_order') : undefined;
  return mutate('situation:update', String(id), { owner_cell: 'white', releasable_to: [] }, () => {
    const timestamp = now();
    if (cleanStatus === 'active') deactivatePriorSituation(id, timestamp);
    const fields: string[] = [];
    const params: SQLInputValue[] = [];
    if (cleanTitle !== undefined) {
      fields.push('title = ?');
      params.push(cleanTitle);
    }
    if (cleanGroundTruth !== undefined) {
      fields.push('ground_truth = ?');
      params.push(cleanGroundTruth);
    }
    if (cleanExpected !== undefined) {
      fields.push('expected_response = ?');
      params.push(cleanExpected);
    }
    if (cleanStatus !== undefined) {
      fields.push('status = ?');
      params.push(cleanStatus);
    }
    if (cleanSort !== undefined) {
      fields.push('sort_order = ?');
      params.push(cleanSort);
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(timestamp);
      database
        .prepare(`UPDATE situations SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    return shapeSituation(existingRow('situations', id));
  });
}

/** Rejects deletion if any scenario event (any state) still names this
 * situation, rather than silently detaching it (`ON DELETE SET NULL` in the
 * schema exists only as a defensive backstop, never reached through this
 * route) — losing the link would be losing which authored beat a fired or
 * still-pending inject belongs to. */
export function deleteSituation(id: number) {
  const existing = fetchRow('situations', id);
  if (!existing) throw new HttpError(404, `Situation ${id} not found.`);
  const referenced = countRows(
    database,
    'SELECT COUNT(*) AS n FROM scenario_events WHERE situation_id = ?',
    id,
  );
  if (referenced > 0) {
    throw new HttpError(
      409,
      `Situation ${id} has ${referenced} scenario event(s) attached; detach or remove them first.`,
    );
  }
  mutate('situation:delete', String(id), { owner_cell: 'white', releasable_to: [] }, () => {
    database.prepare('DELETE FROM situations WHERE id = ?').run(id);
  });
}

export function getInstructorData() {
  return { story: readStory(), situations: listSituations(), events: listScenarioEvents() };
}
