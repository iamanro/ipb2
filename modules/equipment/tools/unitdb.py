#!/usr/bin/env python3
"""Query the local Spatial Illusions public sample database."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path
from typing import Any

DEFAULT_DATABASE = Path(__file__).resolve().parents[1] / "data" / "unitgenerator.db"


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def rows_as_dicts(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
    return [dict(row) for row in cursor]


def search_expression(text: str) -> str | None:
    tokens = re.findall(r"[^\W_]+", text, flags=re.UNICODE)
    if not tokens:
        return None
    return " AND ".join('"' + token.replace('"', '""') + '"' for token in tokens)


def expand_keys(connection: sqlite3.Connection, keys: list[str]) -> list[str]:
    """Return the selected navigation keys plus every descendant key."""
    placeholders = ", ".join("?" for _ in keys)
    return [
        row[0]
        for row in connection.execute(
            f"""WITH RECURSIVE picked(id, key) AS (
                    SELECT id, key FROM navigation_nodes WHERE key IN ({placeholders})
                    UNION
                    SELECT n.id, n.key FROM navigation_nodes AS n
                    JOIN picked ON n.parent_id = picked.id
                )
                SELECT key FROM picked""",
            keys,
        )
    ]


def card_scope(
    connection: sqlite3.Connection,
    text: str | None,
    filters: dict[str, list[str]],
) -> tuple[str, list[str], list[Any], str | None]:
    expression = search_expression(text or "")
    parameters: list[Any] = []
    joins = ""
    conditions: list[str] = []
    if expression:
        joins = "JOIN cards_fts ON cards_fts.card_identifier = c.identifier"
        conditions.append("cards_fts MATCH ?")
        parameters.append(expression)

    for kind, keys in filters.items():
        if not keys:
            continue
        # A selected region or category also matches every card filed under
        # one of its descendants, exactly like the source application's tree.
        expanded = expand_keys(connection, keys) or list(keys)
        placeholders = ", ".join("?" for _ in expanded)
        conditions.append(
            f"""EXISTS (
                SELECT 1 FROM classifications AS selected
                WHERE selected.card_identifier = c.identifier
                  AND selected.kind = ?
                  AND selected.source_key IN ({placeholders})
            )"""
        )
        parameters.extend((kind, *expanded))

    return joins, conditions, parameters, expression


def list_cards(
    connection: sqlite3.Connection,
    text: str | None,
    filters: dict[str, list[str]],
    limit: int,
    offset: int = 0,
) -> list[dict[str, Any]]:
    joins, conditions, parameters, expression = card_scope(connection, text, filters)
    if expression:
        match_column = "snippet(cards_fts, -1, '[', ']', ' … ', 24) AS match"
        order = "bm25(cards_fts), c.name COLLATE NOCASE"
    else:
        match_column = "NULL AS match"
        order = "c.source_ordinal"

    where = "WHERE " + " AND ".join(conditions) if conditions else ""
    parameters.extend((limit, offset))
    return rows_as_dicts(
        connection.execute(
            f"""SELECT c.identifier, c.name, c.title, c.date_of_introduction,
                       {match_column}
                FROM cards AS c
                {joins}
                {where}
                ORDER BY {order}
                LIMIT ? OFFSET ?""",
            parameters,
        )
    )


def search(connection: sqlite3.Connection, text: str, limit: int) -> list[dict[str, Any]]:
    return list_cards(connection, text, {}, limit)


def show(connection: sqlite3.Connection, identifier: str) -> dict[str, Any] | None:
    card = connection.execute("SELECT * FROM cards WHERE identifier = ?", (identifier,)).fetchone()
    if card is None:
        return None
    result = dict(card)
    result.pop("raw_json")
    result["classifications"] = rows_as_dicts(
        connection.execute(
            """SELECT kind, ordinal, source_key, value
               FROM classifications WHERE card_identifier = ?
               ORDER BY kind, ordinal""",
            (identifier,),
        )
    )
    result["images"] = rows_as_dicts(
        connection.execute(
            """SELECT ordinal, name, source_path, local_path
               FROM images WHERE card_identifier = ? ORDER BY ordinal""",
            (identifier,),
        )
    )

    section_rows = connection.execute(
        """SELECT id, parent_id, ordinal, depth, name, name_invalid
           FROM sections WHERE card_identifier = ? ORDER BY id""",
        (identifier,),
    )
    section_nodes: dict[int, dict[str, Any]] = {}
    roots: list[dict[str, Any]] = []
    for row in section_rows:
        section = {
            "ordinal": row["ordinal"],
            "depth": row["depth"],
            "name": row["name"],
            "name_invalid": row["name_invalid"],
            "properties": [],
            "sections": [],
        }
        section_nodes[row["id"]] = section
        if row["parent_id"] is None:
            roots.append(section)
        else:
            section_nodes[row["parent_id"]]["sections"].append(section)

    property_rows = connection.execute(
        """SELECT p.section_id, p.ordinal, p.name, p.value, p.units,
                  p.property_name_invalid, p.value_invalid
           FROM properties AS p
           JOIN sections AS s ON s.id = p.section_id
           WHERE s.card_identifier = ?
           ORDER BY p.section_id, p.ordinal""",
        (identifier,),
    )
    for row in property_rows:
        section_nodes[row["section_id"]]["properties"].append(
            {
                "ordinal": row["ordinal"],
                "name": row["name"],
                "value": row["value"],
                "units": row["units"],
                "property_name_invalid": row["property_name_invalid"],
                "value_invalid": row["value_invalid"],
            }
        )
    result["sections"] = roots
    return result


def taxonomy(
    connection: sqlite3.Connection,
    kind: str | None,
    used_only: bool,
) -> dict[str, list[dict[str, Any]]] | list[dict[str, Any]]:
    def load(selected_kind: str) -> list[dict[str, Any]]:
        rows = rows_as_dicts(
            connection.execute(
                """WITH RECURSIVE tree AS (
                        SELECT id, parent_id, ordinal, depth, key, name, variable,
                               inode, iso_code, name AS path
                        FROM navigation_nodes WHERE key = ?
                        UNION ALL
                        SELECT n.id, n.parent_id, n.ordinal, n.depth, n.key, n.name,
                               n.variable, n.inode, n.iso_code,
                               tree.path || ' > ' || n.name
                        FROM navigation_nodes AS n
                        JOIN tree ON n.parent_id = tree.id
                    )
                    SELECT * FROM tree WHERE key <> ? ORDER BY id""",
                (selected_kind, selected_kind),
            )
        )
        cards_by_key: dict[str, set[str]] = {}
        for source_key, card_identifier in connection.execute(
            "SELECT source_key, card_identifier FROM classifications WHERE kind = ?",
            (selected_kind,),
        ):
            cards_by_key.setdefault(source_key, set()).add(card_identifier)
        return order_tree(rows, cards_by_key, used_only, alphabetical=selected_kind != "domain")

    if kind:
        return load(kind)
    return {selected_kind: load(selected_kind) for selected_kind in ("domain", "origin", "proliferation")}


def order_tree(
    rows: list[dict[str, Any]],
    cards_by_key: dict[str, set[str]],
    used_only: bool,
    alphabetical: bool,
) -> list[dict[str, Any]]:
    """Flatten rows depth-first with subtree card counts.

    card_count rolls up the whole subtree, so a region reports every card filed
    under any of its countries. Countries sort by name; categories keep source order.
    """
    children: dict[int | None, list[dict[str, Any]]] = {}
    ids = {row["id"] for row in rows}
    for row in rows:
        parent = row["parent_id"] if row["parent_id"] in ids else None
        children.setdefault(parent, []).append(row)
    sort_key = (lambda row: row["name"].casefold()) if alphabetical else (lambda row: row["ordinal"])
    ordered: list[dict[str, Any]] = []

    def walk(parent: int | None) -> set[str]:
        cards: set[str] = set()
        for row in sorted(children.get(parent, []), key=sort_key):
            position = len(ordered)
            ordered.append(row)
            subtree_cards = walk(row["id"]) | cards_by_key.get(row["key"], set())
            row["card_count"] = len(subtree_cards)
            if used_only and not subtree_cards:
                del ordered[position:]
            cards |= subtree_cards
        return cards

    walk(None)
    return ordered


def filter_cards(
    connection: sqlite3.Connection,
    text: str | None,
    domains: list[str],
    origins: list[str],
    proliferation: list[str],
    limit: int,
    offset: int = 0,
) -> list[dict[str, Any]]:
    return list_cards(
        connection,
        text,
        {"domain": domains, "origin": origins, "proliferation": proliferation},
        limit,
        offset,
    )


def count_cards(
    connection: sqlite3.Connection,
    text: str | None,
    domains: list[str],
    origins: list[str],
    proliferation: list[str],
) -> int:
    filters = {"domain": domains, "origin": origins, "proliferation": proliferation}
    joins, conditions, parameters, _ = card_scope(connection, text, filters)
    where = "WHERE " + " AND ".join(conditions) if conditions else ""
    return int(
        connection.execute(
            f"""SELECT count(*)
                FROM cards AS c
                {joins}
                {where}""",
            parameters,
        ).fetchone()[0]
    )


def stats(connection: sqlite3.Connection) -> dict[str, Any]:
    counts = {}
    for table in (
        "source_documents",
        "navigation_nodes",
        "cards",
        "images",
        "sections",
        "properties",
        "classifications",
    ):
        counts[table] = connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    source = dict(connection.execute("SELECT * FROM source").fetchone())
    return {"source": source, "counts": counts}


def query(connection: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    statement = sql.lstrip().lower()
    if not (statement.startswith("select") or statement.startswith("with") or statement.startswith("pragma")):
        raise ValueError("Only SELECT, WITH, and PRAGMA queries are allowed.")
    return rows_as_dicts(connection.execute(sql))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search", help="Search cards and their properties.")
    search_parser.add_argument("text")
    search_parser.add_argument("--limit", type=int, default=20)

    filter_parser = subparsers.add_parser(
        "filter",
        help="Filter cards with the source application's AND/OR taxonomy rules.",
    )
    filter_parser.add_argument("--text", help="Also apply full-text search.")
    filter_parser.add_argument("--domain", action="append", default=[], metavar="KEY")
    filter_parser.add_argument("--origin", action="append", default=[], metavar="KEY")
    filter_parser.add_argument("--proliferation", action="append", default=[], metavar="KEY")
    filter_parser.add_argument("--limit", type=int, default=20)

    taxonomy_parser = subparsers.add_parser("taxonomy", help="Browse source navigation categories.")
    taxonomy_parser.add_argument("kind", nargs="?", choices=("domain", "origin", "proliferation"))
    taxonomy_parser.add_argument("--used-only", action="store_true")

    show_parser = subparsers.add_parser("show", help="Show one complete normalized card.")
    show_parser.add_argument("identifier")

    subparsers.add_parser("stats", help="Show source scope and row counts.")

    query_parser = subparsers.add_parser("query", help="Run a read-only SQLite query.")
    query_parser.add_argument("sql")

    arguments = parser.parse_args()
    with connect(arguments.database) as connection:
        if arguments.command == "search":
            result: Any = search(connection, arguments.text, arguments.limit)
        elif arguments.command == "filter":
            result = filter_cards(
                connection,
                arguments.text,
                arguments.domain,
                arguments.origin,
                arguments.proliferation,
                arguments.limit,
            )
        elif arguments.command == "taxonomy":
            result = taxonomy(connection, arguments.kind, arguments.used_only)
        elif arguments.command == "show":
            result = show(connection, arguments.identifier)
        elif arguments.command == "stats":
            result = stats(connection)
        else:
            result = query(connection, arguments.sql)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
