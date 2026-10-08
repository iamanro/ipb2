import type { SQLInputValue } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

import type { JsonObject } from '../../../server/http.ts';
import { num, numOrNull, rowJson, text, textOrNull, type Row } from '../../../server/state.ts';

export const KINDS = ['domain', 'origin', 'proliferation'];

/** Selected navigation keys per taxonomy kind. */
export type CardFilters = Record<string, string[]>;
export type CardsQuery = {
  text: string | null;
  filters: CardFilters;
  limit: number;
  offset: number;
};
/** A search hit: the card's list fields, plus what `apiCards` adds for display. */
export type CardSummary = {
  identifier: string;
  name: string | null;
  title: string | null;
  date_of_introduction: string | null;
  match: string | null;
  image_url?: string | null;
  domains?: string[];
  origins?: string[];
};
export type CardImage = {
  ordinal: number;
  name: string | null;
  source_path: string | null;
  local_path: string | null;
  url?: string | null;
};
/** A card section: its own fields as stored, its properties, its sub-sections. */
export type CardSection = {
  ordinal: number;
  depth: number;
  name: string | null;
  name_invalid: number | null;
  properties: JsonObject[];
  sections: CardSection[];
};
/** A whole card: its columns as stored, plus its images, sections and classifications. */
export type Card = JsonObject & {
  images: CardImage[];
  sections: CardSection[];
  classifications: JsonObject[];
};
/** A taxonomy node, its columns as stored plus the tree fields it is ordered by. */
type TaxonomyNode = JsonObject & {
  id: number;
  parent_id: number | null;
  key: string;
  name: string;
  ordinal: number;
  card_count?: number;
};

function readImage(row: Row): CardImage {
  return {
    ordinal: num(row, 'ordinal'),
    name: textOrNull(row, 'name'),
    source_path: textOrNull(row, 'source_path'),
    local_path: textOrNull(row, 'local_path'),
  };
}

export function openDatabase(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function placeholders(values: readonly SQLInputValue[]) {
  return values.map(() => '?').join(', ');
}

function searchExpression(query: string | null) {
  const tokens = (query || '').match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

/** Selected navigation keys plus every descendant key. */
function expandKeys(database: DatabaseSync, keys: string[]): string[] {
  return database
    .prepare(
      `WITH RECURSIVE picked(id, key) AS (
         SELECT id, key FROM navigation_nodes WHERE key IN (${placeholders(keys)})
         UNION
         SELECT n.id, n.key FROM navigation_nodes AS n JOIN picked ON n.parent_id = picked.id
       )
       SELECT key FROM picked`,
    )
    .all(...keys)
    .map((row) => text(row, 'key'));
}

function cardScope(database: DatabaseSync, query: string | null, filters: CardFilters) {
  const expression = searchExpression(query);
  const parameters: SQLInputValue[] = [];
  const conditions: string[] = [];
  let joins = '';
  if (expression) {
    joins = 'JOIN cards_fts ON cards_fts.card_identifier = c.identifier';
    conditions.push('cards_fts MATCH ?');
    parameters.push(expression);
  }
  for (const kind of KINDS) {
    const keys = filters[kind] || [];
    if (!keys.length) continue;
    // A selected region or category also matches every card filed under one
    // of its descendants, exactly like the source application's tree.
    const expanded = expandKeys(database, keys);
    const scope = expanded.length ? expanded : keys;
    conditions.push(
      `EXISTS (
         SELECT 1 FROM classifications AS selected
         WHERE selected.card_identifier = c.identifier
           AND selected.kind = ?
           AND selected.source_key IN (${placeholders(scope)})
       )`,
    );
    parameters.push(kind, ...scope);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { joins, where, parameters, expression };
}

export function listCards(
  database: DatabaseSync,
  { text: query, filters, limit, offset }: CardsQuery,
): { items: CardSummary[]; total: number } {
  const { joins, where, parameters, expression } = cardScope(database, query, filters);
  const matchColumn = expression
    ? "snippet(cards_fts, -1, '[', ']', ' … ', 24) AS match"
    : 'NULL AS match';
  const order = expression ? 'bm25(cards_fts), c.name COLLATE NOCASE' : 'c.source_ordinal';
  const items = database
    .prepare(
      `SELECT c.identifier, c.name, c.title, c.date_of_introduction, ${matchColumn}
       FROM cards AS c ${joins} ${where}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset)
    .map((row) => ({
      identifier: text(row, 'identifier'),
      name: textOrNull(row, 'name'),
      title: textOrNull(row, 'title'),
      date_of_introduction: textOrNull(row, 'date_of_introduction'),
      match: textOrNull(row, 'match'),
    }));
  const totalRow = database
    .prepare(`SELECT count(*) AS total FROM cards AS c ${joins} ${where}`)
    .get(...parameters);
  return { items, total: totalRow ? num(totalRow, 'total') : 0 };
}

export function listCardExtras(database: DatabaseSync, identifiers: string[]) {
  const images = new Map<string, CardImage>();
  const classifications = new Map<string, Record<string, string[]>>(
    identifiers.map((identifier) => [identifier, { domain: [], origin: [] }]),
  );
  if (!identifiers.length) return { images, classifications };
  const marks = placeholders(identifiers);
  for (const row of database
    .prepare(
      `SELECT card_identifier, ordinal, source_path, local_path
       FROM images WHERE ordinal = 0 AND card_identifier IN (${marks})`,
    )
    .all(...identifiers)) {
    images.set(text(row, 'card_identifier'), readImage(row));
  }
  for (const row of database
    .prepare(
      `SELECT cl.card_identifier, cl.kind, cl.value
       FROM classifications AS cl
       JOIN navigation_nodes AS node ON node.key = cl.source_key
       WHERE cl.kind IN ('domain', 'origin') AND cl.card_identifier IN (${marks})
       ORDER BY cl.card_identifier, cl.kind, node.depth, cl.ordinal`,
    )
    .all(...identifiers)) {
    // Rows are selected for these identifiers only, so the entry exists.
    const value = textOrNull(row, 'value');
    if (value !== null)
      classifications.get(text(row, 'card_identifier'))?.[text(row, 'kind')]?.push(value);
  }
  return { images, classifications };
}

export function showCard(database: DatabaseSync, identifier: string): Card | null {
  const card = database.prepare('SELECT * FROM cards WHERE identifier = ?').get(identifier);
  if (!card) return null;
  const { raw_json: _raw, ...columns } = rowJson(card);
  const classifications = database
    .prepare(
      `SELECT kind, ordinal, source_key, value FROM classifications
       WHERE card_identifier = ? ORDER BY kind, ordinal`,
    )
    .all(identifier)
    .map(rowJson);
  const images = database
    .prepare(
      `SELECT ordinal, name, source_path, local_path FROM images
       WHERE card_identifier = ? ORDER BY ordinal`,
    )
    .all(identifier)
    .map(readImage);

  const nodes = new Map<number, CardSection>();
  const roots: CardSection[] = [];
  for (const row of database
    .prepare(
      `SELECT id, parent_id, ordinal, depth, name, name_invalid
       FROM sections WHERE card_identifier = ? ORDER BY id`,
    )
    .all(identifier)) {
    const section: CardSection = {
      ordinal: num(row, 'ordinal'),
      depth: num(row, 'depth'),
      name: textOrNull(row, 'name'),
      name_invalid: numOrNull(row, 'name_invalid'),
      properties: [],
      sections: [],
    };
    nodes.set(num(row, 'id'), section);
    const parentId = numOrNull(row, 'parent_id');
    if (parentId === null) roots.push(section);
    else nodes.get(parentId)?.sections.push(section);
  }
  for (const row of database
    .prepare(
      `SELECT p.section_id, p.ordinal, p.name, p.value, p.units,
              p.property_name_invalid, p.value_invalid
       FROM properties AS p JOIN sections AS s ON s.id = p.section_id
       WHERE s.card_identifier = ? ORDER BY p.section_id, p.ordinal`,
    )
    .all(identifier)) {
    const { section_id: _section, ...property } = rowJson(row);
    nodes.get(num(row, 'section_id'))?.properties.push(property);
  }
  return { ...columns, classifications, images, sections: roots };
}

/**
 * Flatten rows depth-first with subtree card counts. card_count rolls up the
 * whole subtree, so a region reports every card filed under any of its
 * countries. Countries sort by name; categories keep source order.
 */
function orderTree(
  rows: TaxonomyNode[],
  cardsByKey: Map<string, Set<string>>,
  usedOnly: boolean,
  alphabetical: boolean,
): TaxonomyNode[] {
  const ids = new Set(rows.map((row) => row.id));
  const children = new Map<number | null, TaxonomyNode[]>();
  for (const row of rows) {
    const parent = row.parent_id !== null && ids.has(row.parent_id) ? row.parent_id : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(row);
    else children.set(parent, [row]);
  }
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  const compare = alphabetical
    ? (a: TaxonomyNode, b: TaxonomyNode) => collator.compare(a.name, b.name)
    : (a: TaxonomyNode, b: TaxonomyNode) => a.ordinal - b.ordinal;
  const ordered: TaxonomyNode[] = [];

  function walk(parent: number | null): Set<string> {
    const cards = new Set<string>();
    for (const row of (children.get(parent) || []).sort(compare)) {
      const position = ordered.length;
      ordered.push(row);
      const subtree = walk(row.id);
      for (const card of cardsByKey.get(row.key) || []) subtree.add(card);
      row.card_count = subtree.size;
      if (usedOnly && !subtree.size) ordered.length = position;
      for (const card of subtree) cards.add(card);
    }
    return cards;
  }

  walk(null);
  return ordered;
}

export function taxonomy(database: DatabaseSync, kind: string | null, usedOnly: boolean) {
  const load = (selectedKind: string): TaxonomyNode[] => {
    const rows = database
      .prepare(
        `WITH RECURSIVE tree AS (
           SELECT id, parent_id, ordinal, depth, key, name, variable, inode, iso_code,
                  name AS path
           FROM navigation_nodes WHERE key = ?
           UNION ALL
           SELECT n.id, n.parent_id, n.ordinal, n.depth, n.key, n.name, n.variable,
                  n.inode, n.iso_code, tree.path || ' > ' || n.name
           FROM navigation_nodes AS n JOIN tree ON n.parent_id = tree.id
         )
         SELECT * FROM tree WHERE key <> ? ORDER BY id`,
      )
      .all(selectedKind, selectedKind)
      .map((row): TaxonomyNode => ({
        ...rowJson(row),
        id: num(row, 'id'),
        parent_id: numOrNull(row, 'parent_id'),
        key: text(row, 'key'),
        name: text(row, 'name'),
        ordinal: num(row, 'ordinal'),
      }));
    const cardsByKey = new Map<string, Set<string>>();
    for (const row of database
      .prepare('SELECT source_key, card_identifier FROM classifications WHERE kind = ?')
      .all(selectedKind)) {
      const key = text(row, 'source_key');
      const cards = cardsByKey.get(key) ?? new Set<string>();
      cards.add(text(row, 'card_identifier'));
      cardsByKey.set(key, cards);
    }
    return orderTree(rows, cardsByKey, usedOnly, selectedKind !== 'domain');
  };
  if (kind) return load(kind);
  return Object.fromEntries(KINDS.map((selectedKind) => [selectedKind, load(selectedKind)]));
}

export function stats(database: DatabaseSync) {
  const counts: Record<string, number> = {};
  for (const table of [
    'source_documents',
    'navigation_nodes',
    'cards',
    'images',
    'sections',
    'properties',
    'classifications',
  ]) {
    const row = database.prepare(`SELECT count(*) AS n FROM ${table}`).get();
    counts[table] = row ? num(row, 'n') : 0;
  }
  const source = database.prepare('SELECT * FROM source').get();
  return { source: source ? rowJson(source) : null, counts };
}

export function imagePath(database: DatabaseSync, identifier: string, ordinal: number) {
  const row = database
    .prepare('SELECT local_path FROM images WHERE card_identifier = ? AND ordinal = ?')
    .get(identifier, ordinal);
  return (row && textOrNull(row, 'local_path')) || null;
}
