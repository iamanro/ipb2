#!/usr/bin/env python3
"""Build a local SQLite database from the public Unit Generator sample."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

# IPB_DATA_ROOT/equipment when set (containers), else modules/equipment/data.
DATA_ROOT = (
    Path(os.environ["IPB_DATA_ROOT"]) / "equipment"
    if os.environ.get("IPB_DATA_ROOT")
    else Path(__file__).resolve().parents[1] / "data"
)
SOURCE_URL = "https://spatialillusions.com/unitgenerator/weg-database.zipdb"
SCOPE = "Public sample: Russian fixed-wing aircraft only; not the licensed full WEG database."


def download_archive(url: str) -> Path:
    temporary = tempfile.NamedTemporaryFile(prefix="unitgenerator-", suffix=".zipdb", delete=False)
    temporary.close()
    target = Path(temporary.name)
    try:
        with urllib.request.urlopen(url) as response, target.open("wb") as output:
            shutil.copyfileobj(response, output)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def optional_bool(value: object) -> int | None:
    return None if value is None else int(bool(value))


def safe_member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or len(path.parts) != 1:
        raise ValueError(f"Unsafe image member path: {name!r}")
    return path

def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()



def insert_sections(
    connection: sqlite3.Connection,
    card_identifier: str,
    sections: list[dict[str, object]],
    parent_id: int | None = None,
    depth: int = 0,
) -> list[str]:
    searchable: list[str] = []
    for ordinal, section in enumerate(sections):
        name = str(section.get("name", ""))
        cursor = connection.execute(
            """INSERT INTO sections
               (card_identifier, parent_id, ordinal, depth, name, name_invalid)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                card_identifier,
                parent_id,
                ordinal,
                depth,
                name,
                optional_bool(section.get("nameInvalid")),
            ),
        )
        section_id = int(cursor.lastrowid)
        searchable.append(name)
        for property_ordinal, property_data in enumerate(section.get("properties", [])):
            property_name = str(property_data.get("name", ""))
            property_value = str(property_data.get("value", ""))
            units = property_data.get("units")
            connection.execute(
                """INSERT INTO properties
                   (section_id, ordinal, name, value, units, property_name_invalid, value_invalid)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    section_id,
                    property_ordinal,
                    property_name,
                    property_value,
                    None if units is None else str(units),
                    optional_bool(property_data.get("propertyNameInvalid")),
                    optional_bool(property_data.get("valueInvalid")),
                ),
            )
            searchable.extend((property_name, property_value, "" if units is None else str(units)))
        searchable.extend(
            insert_sections(
                connection,
                card_identifier,
                section.get("sections", []),
                section_id,
                depth + 1,
            )
        )
    return searchable


def insert_navigation_node(
    connection: sqlite3.Connection,
    node: dict[str, object],
    parent_id: int | None = None,
    ordinal: int = 0,
    depth: int = 0,
    source_key: str | None = None,
) -> None:
    cursor = connection.execute(
        """INSERT INTO navigation_nodes
           (parent_id, ordinal, depth, source_key, key, name, variable, inode, iso_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            parent_id,
            ordinal,
            depth,
            source_key,
            str(node.get("key", "")),
            str(node.get("name", "")),
            str(node.get("variable", "")),
            node.get("inode"),
            node.get("iso_code"),
        ),
    )
    node_id = int(cursor.lastrowid)
    children = node.get("children", {})
    if not isinstance(children, dict):
        raise ValueError(f"Unexpected navigation children: {children!r}")
    for child_ordinal, (child_source_key, child) in enumerate(children.items()):
        if not isinstance(child, dict):
            raise ValueError(f"Unexpected navigation node: {child!r}")
        insert_navigation_node(
            connection,
            child,
            node_id,
            child_ordinal,
            depth + 1,
            str(child_source_key),
        )




def build_database(archive_path: Path, output_path: Path, image_directory: Path, schema_path: Path) -> None:
    archive_sha256 = file_sha256(archive_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image_directory.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary_output.unlink(missing_ok=True)

    with zipfile.ZipFile(archive_path) as archive:
        member_names = archive.namelist()
        json_member_names = sorted(
            name for name in member_names if name.startswith("json/") and name.endswith(".json")
        )
        json_documents = {name: json.loads(archive.read(name)) for name in json_member_names}
        required_members = {"json/cards.json", "json/metadata.json", "json/navigation.json"}
        missing_members = required_members.difference(json_documents)
        if missing_members:
            raise ValueError(f"Missing required JSON members: {sorted(missing_members)!r}")
        cards = json_documents["json/cards.json"]
        metadata = json_documents["json/metadata.json"]
        navigation = json_documents["json/navigation.json"]
        member_name_set = set(member_names)
        image_count = sum(len(card.get("images", [])) for card in cards)
        source_updated_at = max(
            (str(card.get("authorModDate", "")) for card in cards),
            default="",
        )

        connection = sqlite3.connect(temporary_output)
        try:
            connection.executescript(schema_path.read_text(encoding="utf-8"))
            connection.execute(
                """INSERT INTO source
                   (id, name, source_url, scope, source_kind, source_record_count,
                    source_asset_count, source_updated_at, imported_at)
                   VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "Spatial Illusions Unit Generator",
                    SOURCE_URL,
                    SCOPE,
                    "zipdb",
                    len(cards),
                    image_count,
                    source_updated_at or None,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            source_metadata = {
                "archiveSizeBytes": archive_path.stat().st_size,
                "archiveSha256": archive_sha256,
                "archiveMemberCount": len(member_names),
                "jsonMemberCount": len(json_member_names),
            }
            connection.executemany(
                "INSERT INTO metadata(key, value) VALUES (?, ?)",
                (
                    (str(key), str(value))
                    for key, value in {**metadata, **source_metadata}.items()
                ),
            )
            connection.executemany(
                "INSERT INTO source_documents(source_ref, top_level_type, json_data) VALUES (?, ?, ?)",
                (
                    (
                        member_path,
                        type(document).__name__,
                        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
                    )
                    for member_path, document in json_documents.items()
                ),
            )
            navigation_content = navigation.get("content")
            if not isinstance(navigation_content, dict):
                raise ValueError("Navigation content must be an object.")
            insert_navigation_node(connection, navigation_content)


            for source_ordinal, card in enumerate(cards):
                identifier = str(card["identifier"])
                connection.execute(
                    """INSERT INTO cards VALUES
                       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        identifier,
                        source_ordinal,
                        str(card.get("name", "")),
                        str(card.get("title", "")),
                        str(card.get("disname", "")),
                        str(card.get("disstring", "")),
                        str(card.get("notes", "")),
                        str(card.get("dateOfIntroduction", "")),
                        str(card.get("publishDate", "")),
                        str(card.get("modDate", "")),
                        str(card.get("authorModDate", "")),
                        str(card.get("inode", "")),
                        str(card.get("host", "")),
                        int(bool(card.get("live"))),
                        int(bool(card.get("hasLiveVersion"))),
                        json.dumps(card, ensure_ascii=False, separators=(",", ":")),
                    ),
                )

                search_details: list[str] = []
                for kind in ("domain", "origin", "proliferation"):
                    for ordinal, item in enumerate(card.get(kind, [])):
                        if len(item) != 1:
                            raise ValueError(f"Unexpected {kind} item for {identifier}: {item!r}")
                        source_key, value = next(iter(item.items()))
                        connection.execute(
                            "INSERT INTO classifications VALUES (?, ?, ?, ?, ?)",
                            (identifier, kind, ordinal, str(source_key), str(value)),
                        )
                        search_details.append(str(value))

                for ordinal, image in enumerate(card.get("images", [])):
                    image_name = str(image["name"])
                    safe_member_path(image_name)
                    if image_name not in member_name_set:
                        raise ValueError(f"Missing image member: {image_name!r}")
                    local_path = image_directory / image_name
                    local_path.write_bytes(archive.read(image_name))
                    try:
                        stored_path = local_path.resolve().relative_to(output_path.parent.resolve())
                    except ValueError:
                        stored_path = local_path.resolve()
                    connection.execute(
                        """INSERT INTO images
                           (card_identifier, ordinal, name, source_path, local_path)
                           VALUES (?, ?, ?, ?, ?)""",
                        (
                            identifier,
                            ordinal,
                            image_name,
                            str(image.get("url", "")),
                            str(stored_path),
                        ),
                    )

                search_details.extend(insert_sections(connection, identifier, card.get("sections", [])))
                connection.execute(
                    "INSERT INTO cards_fts VALUES (?, ?, ?, ?, ?)",
                    (
                        identifier,
                        str(card.get("name", "")),
                        str(card.get("title", "")),
                        str(card.get("notes", "")),
                        "\n".join(search_details),
                    ),
                )

            connection.commit()
            result = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if result != "ok":
                raise RuntimeError(f"SQLite integrity check failed: {result}")
        finally:
            connection.close()

    temporary_output.replace(output_path)
    print(f"Built {output_path} with {len(cards)} public sample cards.")
    print(SCOPE)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an existing zipdb archive instead of downloading it.")
    parser.add_argument("--output", type=Path, default=DATA_ROOT / "unitgenerator.db")
    parser.add_argument("--images", type=Path, default=DATA_ROOT / "images")
    parser.add_argument("--schema", type=Path, default=Path(__file__).with_name("schema.sql"))
    arguments = parser.parse_args()

    downloaded = arguments.archive is None
    archive_path = download_archive(SOURCE_URL) if downloaded else arguments.archive
    try:
        build_database(archive_path, arguments.output, arguments.images, arguments.schema)
    finally:
        if downloaded:
            archive_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
