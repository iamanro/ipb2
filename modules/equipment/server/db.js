import { DatabaseSync } from 'node:sqlite';

export const KINDS = ['domain', 'origin', 'proliferation'];

export function openDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function searchExpression(text) {
  const tokens = (text || '').match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

/** Selected navigation keys plus every descendant key. */
function expandKeys(database, keys) {
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
    .map((row) => row.key);
}

function cardScope(database, text, filters) {
  const expression = searchExpression(text);
  const parameters = [];
  const conditions = [];
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

export function listCards(database, { text, filters, limit, offset }) {
  const { joins, where, parameters, expression } = cardScope(database, text, filters);
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
    .all(...parameters, limit, offset);
  const total = database
    .prepare(`SELECT count(*) AS total FROM cards AS c ${joins} ${where}`)
    .get(...parameters).total;
  return { items, total };
}

export function listCardExtras(database, identifiers) {
  const images = new Map();
  const classifications = new Map(
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
    images.set(row.card_identifier, row);
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
    classifications.get(row.card_identifier)[row.kind].push(row.value);
  }
  return { images, classifications };
}

export function showCard(database, identifier) {
  const card = database.prepare('SELECT * FROM cards WHERE identifier = ?').get(identifier);
  if (!card) return null;
  const { raw_json: _raw, ...result } = card;
  result.classifications = database
    .prepare(
      `SELECT kind, ordinal, source_key, value FROM classifications
       WHERE card_identifier = ? ORDER BY kind, ordinal`,
    )
    .all(identifier);
  result.images = database
    .prepare(
      `SELECT ordinal, name, source_path, local_path FROM images
       WHERE card_identifier = ? ORDER BY ordinal`,
    )
    .all(identifier);

  const nodes = new Map();
  const roots = [];
  for (const row of database
    .prepare(
      `SELECT id, parent_id, ordinal, depth, name, name_invalid
       FROM sections WHERE card_identifier = ? ORDER BY id`,
    )
    .all(identifier)) {
    const section = {
      ordinal: row.ordinal,
      depth: row.depth,
      name: row.name,
      name_invalid: row.name_invalid,
      properties: [],
      sections: [],
    };
    nodes.set(row.id, section);
    if (row.parent_id === null) roots.push(section);
    else nodes.get(row.parent_id).sections.push(section);
  }
  for (const row of database
    .prepare(
      `SELECT p.section_id, p.ordinal, p.name, p.value, p.units,
              p.property_name_invalid, p.value_invalid
       FROM properties AS p JOIN sections AS s ON s.id = p.section_id
       WHERE s.card_identifier = ? ORDER BY p.section_id, p.ordinal`,
    )
    .all(identifier)) {
    const { section_id: sectionId, ...property } = row;
    nodes.get(sectionId).properties.push(property);
  }
  result.sections = roots;
  return result;
}

/**
 * Flatten rows depth-first with subtree card counts. card_count rolls up the
 * whole subtree, so a region reports every card filed under any of its
 * countries. Countries sort by name; categories keep source order.
 */
function orderTree(rows, cardsByKey, usedOnly, alphabetical) {
  const ids = new Set(rows.map((row) => row.id));
  const children = new Map();
  for (const row of rows) {
    const parent = ids.has(row.parent_id) ? row.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  const compare = alphabetical
    ? (a, b) => collator.compare(a.name, b.name)
    : (a, b) => a.ordinal - b.ordinal;
  const ordered = [];

  function walk(parent) {
    const cards = new Set();
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

export function taxonomy(database, kind, usedOnly) {
  const load = (selectedKind) => {
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
      .all(selectedKind, selectedKind);
    const cardsByKey = new Map();
    for (const row of database
      .prepare('SELECT source_key, card_identifier FROM classifications WHERE kind = ?')
      .all(selectedKind)) {
      if (!cardsByKey.has(row.source_key)) cardsByKey.set(row.source_key, new Set());
      cardsByKey.get(row.source_key).add(row.card_identifier);
    }
    return orderTree(rows, cardsByKey, usedOnly, selectedKind !== 'domain');
  };
  if (kind) return load(kind);
  return Object.fromEntries(KINDS.map((selectedKind) => [selectedKind, load(selectedKind)]));
}

export function stats(database) {
  const counts = {};
  for (const table of [
    'source_documents',
    'navigation_nodes',
    'cards',
    'images',
    'sections',
    'properties',
    'classifications',
  ]) {
    counts[table] = database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  }
  return { source: database.prepare('SELECT * FROM source').get(), counts };
}

export function imagePath(database, identifier, ordinal) {
  const row = database
    .prepare('SELECT local_path FROM images WHERE card_identifier = ? AND ordinal = ?')
    .get(identifier, ordinal);
  return row?.local_path || null;
}
