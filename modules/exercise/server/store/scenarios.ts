import type { SQLInputValue } from 'node:sqlite';
// Exercise scenarios: fictional countries and renamed places over Czechia.

import { fieldsOf, HttpError, type Json } from '../../../../server/http.ts';
import { countRows, num, type Row } from '../../../../server/state.ts';
import {
  AFFILIATIONS,
  DEFAULT_COLORS,
  normalizeGeometry,
  normalizeRegionIds,
  planExampleScenario,
  requireColor,
  requirePlaceKind,
} from '../scenarioGeography.ts';

import { database, regionsReference } from './connection.ts';
import { readCountry, readPlace, readScenario } from './rows.ts';
import {
  existingRow,
  fetchRow,
  mutate,
  now,
  requireBoundedString,
  requireEnum,
  requireLatitude,
  requireLongitude,
} from './shared.ts';

//
// One "scenario" holds every country and place the IPB and print maps draw
// when it is active. `regions.json` (built from kraje/okresy) is read
// through `referenceFile`, so a rebuild is picked up without a restart;
// countries/places are plain rows, with `geometry`/`regions` stored as JSON
// text and parsed back out when shaping a row for the API. None of this is
// cell-owned — every route here is `verb: 'none'`.

/** The current `regions.json` FeatureCollection, or null if it hasn't been built. */
type CountryColumns = {
  name: string;
  affiliation: string;
  color: string;
  regions: Json;
  geometry: Json;
};
type PlaceColumns = { real_name: string; kind: string; lon: number; lat: number; name: string };

function currentRegionsData(): Json {
  if (!regionsReference) return null;
  try {
    return regionsReference.get()?.data ?? null;
  } catch {
    return null; // a malformed file on disk; treat as "not built yet" rather than 500
  }
}

export function getRegions() {
  const data = currentRegionsData();
  if (!data) {
    throw new HttpError(
      503,
      'No regions data. Build modules/exercise/data/regions.json first (see README, "Building the reference data").',
    );
  }
  return data;
}

function readScenarioMeta(): Row {
  const row = fetchRow('scenario_meta', 1);
  if (row) return row;
  database.prepare('INSERT INTO scenario_meta (id, example_seeded) VALUES (1, 0)').run();
  return existingRow('scenario_meta', 1);
}

function markExampleSeeded() {
  readScenarioMeta();
  database.prepare('UPDATE scenario_meta SET example_seeded = 1 WHERE id = 1').run();
}

function shapeCountry(raw: Row) {
  const row = readCountry(raw);
  const regions: Json = JSON.parse(row.regions);
  const geometry: Json = row.geometry ? JSON.parse(row.geometry) : null;
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    name: row.name,
    affiliation: row.affiliation,
    color: row.color,
    regions,
    geometry,
    position: row.position,
  };
}

function shapePlace(raw: Row) {
  const row = readPlace(raw);
  return {
    id: row.id,
    scenario_id: row.scenario_id,
    real_name: row.real_name,
    kind: row.kind,
    lon: row.lon,
    lat: row.lat,
    name: row.name,
  };
}

function listCountries(scenarioId: number) {
  return database
    .prepare('SELECT * FROM scenario_countries WHERE scenario_id = ? ORDER BY position, id')
    .all(scenarioId)
    .map(shapeCountry);
}

function listPlaces(scenarioId: number) {
  return database
    .prepare('SELECT * FROM scenario_places WHERE scenario_id = ? ORDER BY id')
    .all(scenarioId)
    .map(shapePlace);
}

function shapeScenario(raw: Row) {
  const row = readScenario(raw);
  return {
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    example: Boolean(row.example),
    created_at: row.created_at,
    updated_at: row.updated_at,
    countries: listCountries(row.id),
    places: listPlaces(row.id),
  };
}

function shapeScenarioSummary(raw: Row) {
  const row = readScenario(raw);
  const countryCount = countRows(
    database,
    'SELECT COUNT(*) AS n FROM scenario_countries WHERE scenario_id = ?',
    row.id,
  );
  const placeCount = countRows(
    database,
    'SELECT COUNT(*) AS n FROM scenario_places WHERE scenario_id = ?',
    row.id,
  );
  return {
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    example: Boolean(row.example),
    country_count: countryCount,
    place_count: placeCount,
    updated_at: row.updated_at,
  };
}

function touchScenario(id: number, timestamp = now()) {
  database.prepare('UPDATE scenarios SET updated_at = ? WHERE id = ?').run(timestamp, id);
}

function insertScenarioRow({ name, example }: { name: string; example: boolean }) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      'INSERT INTO scenarios (name, active, example, created_at, updated_at) VALUES (?, 0, ?, ?, ?)',
    )
    .run(name, example ? 1 : 0, timestamp, timestamp);
  return Number(lastInsertRowid);
}

function insertCountryRow(
  scenarioId: number,
  position: number,
  { name, affiliation, color, regions, geometry }: CountryColumns,
) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO scenario_countries
         (scenario_id, name, affiliation, color, regions, geometry, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scenarioId,
      name,
      affiliation,
      color,
      JSON.stringify(regions),
      geometry ? JSON.stringify(geometry) : null,
      position,
      timestamp,
      timestamp,
    );
  return Number(lastInsertRowid);
}

function insertPlaceRow(
  scenarioId: number,
  { real_name: realName, kind, lon, lat, name }: PlaceColumns,
) {
  const timestamp = now();
  const { lastInsertRowid } = database
    .prepare(
      `INSERT INTO scenario_places (scenario_id, real_name, kind, lon, lat, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(scenarioId, realName, kind, lon, lat, name, timestamp, timestamp);
  return Number(lastInsertRowid);
}

/** Inserts the EXAMPLE scenario built from `regionsData` and marks it seeded. */
function seedExampleScenario(regionsData: Json) {
  return mutate('scenario:example', 'example', null, () => {
    const plan = planExampleScenario(regionsData);
    const scenarioId = insertScenarioRow({ name: plan.name, example: true });
    plan.countries.forEach((country, index) => insertCountryRow(scenarioId, index, country));
    plan.places.forEach((place) => insertPlaceRow(scenarioId, place));
    markExampleSeeded();
    return shapeScenario(existingRow('scenarios', scenarioId));
  });
}

/** `POST scenarios/example`: (re)creates the example on demand, 503 without regions data. */
export function createExampleScenario() {
  return seedExampleScenario(getRegions());
}

/**
 * Auto-seeds the EXAMPLE scenario the first time scenarios are listed, if it
 * has never been seeded before and regions data exists. Silent no-op
 * otherwise, so listing before the regions build finishes just tries again
 * next time.
 */
function maybeSeedExample() {
  if (num(readScenarioMeta(), 'example_seeded')) return;
  const regionsData = currentRegionsData();
  if (regionsData) seedExampleScenario(regionsData);
}

export function listScenarios() {
  maybeSeedExample();
  return database
    .prepare('SELECT * FROM scenarios ORDER BY created_at, id')
    .all()
    .map(shapeScenarioSummary);
}

export function createScenario(input: Json) {
  const { name } = fieldsOf(input);
  const cleanName = requireBoundedString(name, 'name', 120);
  return mutate(
    'scenario:create',
    () => cleanName,
    null,
    () => {
      const id = insertScenarioRow({ name: cleanName, example: false });
      return shapeScenario(existingRow('scenarios', id));
    },
  );
}

export function getScenario(id: number) {
  const row = fetchRow('scenarios', id);
  if (!row) throw new HttpError(404, `Scenario ${id} not found.`);
  return shapeScenario(row);
}

export function updateScenario(id: number, input: Json) {
  const patch = fieldsOf(input);
  const existing = fetchRow('scenarios', id);
  if (!existing) throw new HttpError(404, `Scenario ${id} not found.`);
  const { active } = patch;
  if (active !== undefined && typeof active !== 'boolean') {
    throw new HttpError(400, 'active must be a boolean.');
  }
  const cleanName = 'name' in patch ? requireBoundedString(patch.name, 'name', 120) : undefined;
  return mutate('scenario:update', String(id), null, () => {
    const timestamp = now();
    // Deactivate every other scenario first, inside this transaction, so the
    // partial unique index on scenarios(active) never sees two active rows.
    if (active === true) {
      database
        .prepare('UPDATE scenarios SET active = 0, updated_at = ? WHERE active = 1 AND id <> ?')
        .run(timestamp, id);
    }
    const fields: string[] = [];
    const params: SQLInputValue[] = [];
    if (cleanName !== undefined) {
      fields.push('name = ?');
      params.push(cleanName);
    }
    if (active !== undefined) {
      fields.push('active = ?');
      params.push(active ? 1 : 0);
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(timestamp);
      database.prepare(`UPDATE scenarios SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return shapeScenario(existingRow('scenarios', id));
  });
}

export function deleteScenario(id: number) {
  const existing = fetchRow('scenarios', id);
  if (!existing) throw new HttpError(404, `Scenario ${id} not found.`);
  mutate('scenario:delete', String(id), null, () => {
    database.prepare('DELETE FROM scenarios WHERE id = ?').run(id); // cascades to countries/places
  });
}

export function duplicateScenario(id: number) {
  const raw = fetchRow('scenarios', id);
  if (!raw) throw new HttpError(404, `Scenario ${id} not found.`);
  const row = readScenario(raw);
  return mutate('scenario:duplicate', String(id), null, () => {
    const newId = insertScenarioRow({ name: `${row.name} (copy)`, example: false });
    for (const country of listCountries(id)) insertCountryRow(newId, country.position, country);
    for (const place of listPlaces(id)) insertPlaceRow(newId, place);
    return shapeScenario(existingRow('scenarios', newId));
  });
}

export function getActiveScenario() {
  const row = database.prepare('SELECT * FROM scenarios WHERE active = 1').get();
  return { scenario: row ? shapeScenario(row) : null };
}

export function createCountry(scenarioId: number, input: Json) {
  const { name, affiliation, color, regions, geometry } = fieldsOf(input);
  const scenario = fetchRow('scenarios', scenarioId);
  if (!scenario) throw new HttpError(404, `Scenario ${scenarioId} not found.`);
  const cleanName = requireBoundedString(name, 'name', 120);
  const cleanAffiliation = requireEnum(affiliation, 'affiliation', AFFILIATIONS);
  const cleanColor =
    color === undefined || color === null
      ? (DEFAULT_COLORS[cleanAffiliation] ?? '')
      : requireColor(color);
  const cleanRegions = normalizeRegionIds(regions);
  const cleanGeometry = normalizeGeometry(geometry);
  return mutate(
    'scenario-country:create',
    () => cleanName,
    null,
    () => {
      const position = countRows(
        database,
        'SELECT COUNT(*) AS n FROM scenario_countries WHERE scenario_id = ?',
        scenarioId,
      );
      const id = insertCountryRow(scenarioId, position, {
        name: cleanName,
        affiliation: cleanAffiliation,
        color: cleanColor,
        regions: cleanRegions,
        geometry: cleanGeometry,
      });
      touchScenario(scenarioId);
      return shapeCountry(existingRow('scenario_countries', id));
    },
  );
}

export function updateCountry(id: number, input: Json) {
  const patch = fieldsOf(input);
  const raw = fetchRow('scenario_countries', id);
  if (!raw) throw new HttpError(404, `Country ${id} not found.`);
  const row = readCountry(raw);
  const fields: string[] = [];
  const params: SQLInputValue[] = [];
  if ('name' in patch) {
    fields.push('name = ?');
    params.push(requireBoundedString(patch.name, 'name', 120));
  }
  if ('affiliation' in patch) {
    fields.push('affiliation = ?');
    params.push(requireEnum(patch.affiliation, 'affiliation', AFFILIATIONS));
  }
  if ('color' in patch) {
    fields.push('color = ?');
    params.push(requireColor(patch.color));
  }
  if ('regions' in patch) {
    fields.push('regions = ?');
    params.push(JSON.stringify(normalizeRegionIds(patch.regions)));
  }
  if ('geometry' in patch) {
    const geometry = normalizeGeometry(patch.geometry);
    fields.push('geometry = ?');
    params.push(geometry ? JSON.stringify(geometry) : null);
  }
  if ('position' in patch) {
    const { position } = patch;
    if (typeof position !== 'number' || !Number.isInteger(position)) {
      throw new HttpError(400, 'position must be an integer.');
    }
    fields.push('position = ?');
    params.push(position);
  }
  return mutate('scenario-country:update', String(id), null, () => {
    if (fields.length) {
      fields.push('updated_at = ?');
      params.push(now());
      database
        .prepare(`UPDATE scenario_countries SET ${fields.join(', ')} WHERE id = ?`)
        .run(...params, id);
    }
    touchScenario(row.scenario_id);
    return shapeCountry(existingRow('scenario_countries', id));
  });
}

export function deleteCountry(id: number) {
  const raw = fetchRow('scenario_countries', id);
  if (!raw) throw new HttpError(404, `Country ${id} not found.`);
  const row = readCountry(raw);
  mutate('scenario-country:delete', String(id), null, () => {
    database.prepare('DELETE FROM scenario_countries WHERE id = ?').run(id);
    touchScenario(row.scenario_id);
  });
}

export function createPlace(scenarioId: number, input: Json) {
  const { real_name: realName, kind, lon, lat, name } = fieldsOf(input);
  const scenario = fetchRow('scenarios', scenarioId);
  if (!scenario) throw new HttpError(404, `Scenario ${scenarioId} not found.`);
  const cleanRealName = requireBoundedString(realName, 'real_name', 120);
  const cleanKind = requirePlaceKind(kind);
  const cleanLon = requireLongitude(lon);
  const cleanLat = requireLatitude(lat);
  const cleanName = requireBoundedString(name, 'name', 120);
  return mutate(
    'scenario-place:create',
    () => cleanName,
    null,
    () => {
      const id = insertPlaceRow(scenarioId, {
        real_name: cleanRealName,
        kind: cleanKind,
        lon: cleanLon,
        lat: cleanLat,
        name: cleanName,
      });
      touchScenario(scenarioId);
      return shapePlace(existingRow('scenario_places', id));
    },
  );
}

export function updatePlace(id: number, input: Json) {
  const patch = fieldsOf(input);
  const raw = fetchRow('scenario_places', id);
  if (!raw) throw new HttpError(404, `Place ${id} not found.`);
  const row = readPlace(raw);
  const cleanName = 'name' in patch ? requireBoundedString(patch.name, 'name', 120) : undefined;
  return mutate('scenario-place:update', String(id), null, () => {
    if (cleanName !== undefined) {
      const timestamp = now();
      database
        .prepare('UPDATE scenario_places SET name = ?, updated_at = ? WHERE id = ?')
        .run(cleanName, timestamp, id);
      touchScenario(row.scenario_id, timestamp);
    }
    return shapePlace(existingRow('scenario_places', id));
  });
}

export function deletePlace(id: number) {
  const raw = fetchRow('scenario_places', id);
  if (!raw) throw new HttpError(404, `Place ${id} not found.`);
  const row = readPlace(raw);
  mutate('scenario-place:delete', String(id), null, () => {
    database.prepare('DELETE FROM scenario_places WHERE id = ?').run(id);
    touchScenario(row.scenario_id);
  });
}
