import type { SQLInputValue } from 'node:sqlite';
// The current situation: tracks and their position history.

import type { Access, Owner } from '../../../../server/dispatch.ts';
import { fieldsOf, HttpError, type Json } from '../../../../server/http.ts';
import { releasableArray } from '../../../../server/policy.ts';
import { num, text, type Row } from '../../../../server/state.ts';

import { database } from './connection.ts';
import { readTrack, readTrackPosition } from './rows.ts';
import {
  cellsOf,
  fetchRow,
  mutate,
  now,
  optionalString,
  requireEnum,
  requireLatitude,
  requireLongitude,
  requireSidc,
  requireString,
  touchRequirementsForReport,
  visibleRows,
} from './shared.ts';

const TRACK_STATUSES = ['confirmed', 'suspected', 'destroyed', 'lost'];

//
// `tracks` holds the head (most recent) position; `track_positions` is the
// full history. The head only ever moves forward in `observed_at` — an
// out-of-order report still gets recorded, but cannot move it backwards.

function shapeTrackPosition(raw: Row) {
  const row = readTrackPosition(raw);
  return {
    id: row.id,
    lon: row.lon,
    lat: row.lat,
    observed_at: row.observed_at,
    report_id: row.report_id,
  };
}

export function shapeTrack(raw: Row) {
  const row = readTrack(raw);
  const history = database
    .prepare('SELECT * FROM track_positions WHERE track_id = ? ORDER BY observed_at, id')
    .all(row.id)
    .map(shapeTrackPosition);
  return {
    id: row.id,
    sidc: row.sidc,
    designation: row.designation,
    status: row.status,
    lon: row.lon,
    lat: row.lat,
    observed_at: row.observed_at,
    notes: row.notes,
    history,
    owner_cell: row.owner_cell,
    releasable_to: releasableArray(row.releasable_to),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listTracks(access: Access) {
  return visibleRows(access, 'track', 'tracks', 'observed_at DESC, id DESC').map(shapeTrack);
}

function getTrack(id: number) {
  const row = fetchRow('tracks', id);
  if (!row) throw new HttpError(404, `Track ${id} not found.`);
  return shapeTrack(row);
}

export function requireTimestamp(value: Json | undefined, name: string): string {
  const timestamp = requireString(value, name);
  if (Number.isNaN(new Date(timestamp).getTime())) {
    throw new HttpError(400, `${name} must be a valid timestamp.`);
  }
  return timestamp;
}

export function createTrack(owner: Owner, input: Json) {
  const { sidc, designation, status, lon, lat, observed_at: observedAt, notes } = fieldsOf(input);
  const validSidc = requireSidc(sidc);
  const validStatus = requireEnum(status ?? 'confirmed', 'status', TRACK_STATUSES);
  const validLon = requireLongitude(lon);
  const validLat = requireLatitude(lat);
  const validObserved = requireTimestamp(observedAt, 'observed_at');
  const validDesignation = optionalString(designation, 'designation');
  const validNotes = optionalString(notes, 'notes');
  return mutate(
    'track:create',
    () => validDesignation ?? validSidc,
    cellsOf(owner),
    () => {
      const timestamp = now();
      const { lastInsertRowid } = database
        .prepare(
          `INSERT INTO tracks (sidc, designation, status, lon, lat, observed_at, notes, owner_cell, releasable_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validSidc,
          validDesignation,
          validStatus,
          validLon,
          validLat,
          validObserved,
          validNotes,
          owner.owner_cell,
          JSON.stringify(owner.releasable_to),
          timestamp,
          timestamp,
        );
      const id = Number(lastInsertRowid);
      database
        .prepare(
          `INSERT INTO track_positions (track_id, lon, lat, observed_at, report_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(id, validLon, validLat, validObserved, timestamp);
      return getTrack(id);
    },
  );
}

export function updateTrack(item: Row, input: Json) {
  const patch = fieldsOf(input);
  const itemId = num(item, 'id');
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
  if ('sidc' in patch) {
    fields.push('sidc = ?');
    params.push(requireSidc(patch.sidc));
  }
  if ('designation' in patch) {
    fields.push('designation = ?');
    params.push(optionalString(patch.designation, 'designation'));
  }
  if ('status' in patch) {
    fields.push('status = ?');
    params.push(requireEnum(patch.status, 'status', TRACK_STATUSES));
  }
  if ('notes' in patch) {
    fields.push('notes = ?');
    params.push(optionalString(patch.notes, 'notes'));
  }
  return mutate('track:update', String(itemId), cellsOf(item), () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE tracks SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, itemId);
    }
    return getTrack(itemId);
  });
}

export function deleteTrack(item: Row) {
  const itemId = num(item, 'id');
  return mutate('track:delete', String(itemId), cellsOf(item), () => {
    database.prepare('DELETE FROM tracks WHERE id = ?').run(itemId);
    return { deleted: true };
  });
}

/**
 * Appends a position to a track's history. The head (`tracks.lon/lat/observed_at`)
 * only moves when the new position is at least as recent as the current
 * head, so a late-arriving, out-of-order report enriches history without
 * dragging the map picture backwards. When `report_id` is given, that
 * report is linked back to this track.
 */
export function addTrackPosition(item: Row, input: Json, access: Access) {
  const { lon, lat, observed_at: observedAt, report_id: reportId } = fieldsOf(input);
  const itemId = num(item, 'id');
  const headObservedAt = text(item, 'observed_at');
  const validLon = requireLongitude(lon);
  const validLat = requireLatitude(lat);
  const validObserved = requireTimestamp(observedAt, 'observed_at');
  const validReportId =
    reportId === undefined || reportId === null ? null : resolveTrackReportId(reportId, access);
  return mutate('track:position', String(itemId), cellsOf(item), () => {
    const timestamp = now();
    database
      .prepare(
        `INSERT INTO track_positions (track_id, lon, lat, observed_at, report_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(itemId, validLon, validLat, validObserved, validReportId, timestamp);
    if (new Date(validObserved).getTime() >= new Date(headObservedAt).getTime()) {
      database
        .prepare('UPDATE tracks SET lon = ?, lat = ?, observed_at = ?, updated_at = ? WHERE id = ?')
        .run(validLon, validLat, validObserved, timestamp, itemId);
    }
    if (validReportId !== null) {
      database
        .prepare(
          'UPDATE reports SET track_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(itemId, timestamp, validReportId);
      touchRequirementsForReport(validReportId);
    }
    return getTrack(itemId);
  });
}

function resolveTrackReportId(reportId: Json, access: Access): number {
  if (typeof reportId !== 'number' || !Number.isInteger(reportId))
    throw new HttpError(400, 'report_id must be an integer.');
  access.see('report', reportId);
  return reportId;
}
