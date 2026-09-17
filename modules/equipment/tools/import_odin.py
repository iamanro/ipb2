#!/usr/bin/env python3
"""Import the public, live ODIN Worldwide Equipment Guide into SQLite."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse

from build_db import DATA_ROOT, insert_navigation_node, insert_sections

BASE_URL = "https://odin.t2com.army.mil/"
WEG_URL = urljoin(BASE_URL, "WEG")
SEARCH_URL = urljoin(BASE_URL, "dotcms/api/content/_search")
NAVIGATION_URL = urljoin(BASE_URL, "dotcms/api/subnav/weg")
QUERY = "+contentType:WegCard +live:true +deleted:false"
USER_AGENT = "WEG-Local-Importer/1.0"
SCOPE = "Public, live Worldwide Equipment Guide records from the U.S. Army ODIN website."


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def fetch_json(url: str, payload: dict[str, object] | None = None) -> object:
    data = compact_json(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except (TimeoutError, urllib.error.URLError):
            if attempt == 3:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("The request retry loop ended unexpectedly.")


def save_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(compact_json(value), encoding="utf-8")
    temporary.replace(path)


def cached_json(path: Path, url: str, refresh: bool, payload: dict[str, object] | None = None) -> object:
    if path.is_file() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    value = fetch_json(url, payload)
    save_json(path, value)
    return value


def response_cards(response: object) -> tuple[list[dict[str, object]], int]:
    if not isinstance(response, dict):
        raise ValueError("The ODIN response must be an object.")
    entity = response.get("entity")
    if not isinstance(entity, dict):
        raise ValueError("The ODIN response has no entity object.")
    view = entity.get("jsonObjectView")
    if not isinstance(view, dict) or not isinstance(view.get("contentlets"), list):
        raise ValueError("The ODIN response has no contentlet list.")
    cards = view["contentlets"]
    total = entity.get("resultsSize")
    if not isinstance(total, int):
        raise ValueError("The ODIN response has no result count.")
    return cards, total


def load_cards(cache_directory: Path, refresh: bool, batch_size: int) -> list[dict[str, object]]:
    cards: list[dict[str, object]] = []
    expected_total: int | None = None
    offset = 0
    while expected_total is None or offset < expected_total:
        response = cached_json(
            cache_directory / f"cards-{offset:06d}.json",
            SEARCH_URL,
            refresh,
            {
                "limit": batch_size,
                "offset": offset,
                "query": QUERY,
                "sort": "WegCard.domainSort asc",
            },
        )
        batch, total = response_cards(response)
        if expected_total is None:
            expected_total = total
        elif total != expected_total:
            raise ValueError(f"The ODIN result count changed from {expected_total} to {total}.")
        if not batch and offset < total:
            raise ValueError(f"ODIN returned an empty batch at offset {offset}.")
        cards.extend(batch)
        offset += len(batch)

    identifiers = [str(card.get("identifier", "")) for card in cards]
    if len(cards) != expected_total:
        raise ValueError(f"ODIN returned {len(cards)} of {expected_total} cards.")
    if "" in identifiers or len(set(identifiers)) != len(identifiers):
        raise ValueError("ODIN returned a missing or duplicate card identifier.")
    return cards


def decode_list(card: dict[str, object], field: str) -> list[dict[str, object]]:
    value = card.get(field)
    if value in (None, ""):
        return []
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"Card {card.get('identifier')} has an invalid {field} field.")
    return value


def official_image_url(source_path: str) -> str:
    encoded_path = quote(source_path.lstrip("/"), safe="/%:@")
    return urljoin(BASE_URL, f"dotcms/{encoded_path}")


def is_image_file(path: Path) -> bool:
    with path.open("rb") as source:
        signature = source.read(512)
    return (
        signature.startswith(b"\xff\xd8\xff")
        or signature.startswith(b"\x89PNG\r\n\x1a\n")
        or signature.startswith((b"GIF87a", b"GIF89a"))
        or (signature.startswith(b"RIFF") and signature[8:12] == b"WEBP")
        or signature.startswith(b"BM")
        or signature.startswith((b"II*\x00", b"MM\x00*"))
        or b"<svg" in signature.lstrip()[:256].lower()
    )


def local_image_path(
    image_directory: Path,
    identifier: str,
    ordinal: int,
    image_name: str,
    source_path: str,
) -> Path:
    suffix = Path(image_name).suffix.lower() or Path(unquote(urlparse(source_path).path)).suffix.lower()
    if not suffix or len(suffix) > 8:
        suffix = ".bin"
    return image_directory / identifier / f"{ordinal:02d}{suffix}"


def download_image(url: str, target: Path) -> Path:
    if target.is_file() and target.stat().st_size > 0:
        if is_image_file(target):
            return target
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                with temporary.open("wb") as output:
                    shutil.copyfileobj(response, output)
            if not is_image_file(temporary):
                raise ValueError(f"ODIN returned a non-image response for {url}.")
            temporary.replace(target)
            return target
        except (TimeoutError, urllib.error.URLError, ValueError):
            temporary.unlink(missing_ok=True)
            if attempt == 3:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("The image retry loop ended unexpectedly.")


def download_images(
    cards: list[dict[str, object]],
    image_directory: Path,
    mode: str,
    workers: int,
) -> dict[tuple[str, int], Path]:
    jobs: dict[object, tuple[str, int]] = {}
    downloaded: dict[tuple[str, int], Path] = {}
    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for card in cards:
            identifier = str(card["identifier"])
            images = decode_list(card, "images")
            selected = images[:1] if mode == "primary" else images
            for ordinal, image in enumerate(selected):
                source_path = str(image.get("url", ""))
                if not source_path:
                    continue
                target = local_image_path(
                    image_directory,
                    identifier,
                    ordinal,
                    str(image.get("name", "")),
                    source_path,
                )
                key = (identifier, ordinal)
                if target.is_file() and target.stat().st_size > 0:
                    downloaded[key] = target
                elif mode != "none":
                    future = executor.submit(download_image, official_image_url(source_path), target)
                    jobs[future] = key
        completed = 0
        for future in as_completed(jobs):
            key = jobs[future]
            try:
                downloaded[key] = future.result()
            except Exception as error:
                failures.append(f"{key[0]} image {key[1]}: {error}")
            completed += 1
            if completed % 100 == 0 or completed == len(jobs):
                print(f"Processed {completed} of {len(jobs)} images.", flush=True)
    if failures:
        failure_preview = "\n".join(failures[:20])
        raise RuntimeError(f"{len(failures)} image downloads failed:\n{failure_preview}")
    return downloaded


def prune_image_directory(
    image_directory: Path,
    local_images: dict[tuple[str, int], Path],
) -> int:
    expected = {path.resolve() for path in local_images.values()}
    removed = 0
    for path in image_directory.rglob("*"):
        if path.is_file() and path.resolve() not in expected:
            path.unlink()
            removed += 1
    directories = sorted(
        (path for path in image_directory.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for directory in directories:
        try:
            directory.rmdir()
        except OSError:
            pass
    return removed




def build_database(
    cards: list[dict[str, object]],
    navigation: dict[str, object],
    output_path: Path,
    image_directory: Path,
    local_images: dict[tuple[str, int], Path],
    schema_path: Path,
    batch_size: int,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary_output.unlink(missing_ok=True)
    image_count = sum(len(decode_list(card, "images")) for card in cards)
    source_updated_at = max((str(card.get("authorModDate", "")) for card in cards), default="")

    connection = sqlite3.connect(temporary_output)
    try:
        connection.executescript(schema_path.read_text(encoding="utf-8"))
        connection.execute(
            """INSERT INTO source
               (id, name, source_url, scope, source_kind, source_record_count,
                source_asset_count, source_updated_at, imported_at)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "U.S. Army ODIN Worldwide Equipment Guide",
                WEG_URL,
                SCOPE,
                "dotCMS API",
                len(cards),
                image_count,
                source_updated_at or None,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        navigation_json = compact_json(navigation)
        cards_digest = hashlib.sha256()
        for card in cards:
            cards_digest.update(compact_json(card).encode("utf-8"))
        connection.executemany(
            "INSERT INTO metadata(key, value) VALUES (?, ?)",
            (
                ("searchEndpoint", SEARCH_URL),
                ("navigationEndpoint", NAVIGATION_URL),
                ("query", QUERY),
                ("batchSize", str(batch_size)),
                ("navigationSha256", sha256_bytes(navigation_json.encode("utf-8"))),
                ("cardsSha256", cards_digest.hexdigest()),
                ("localAssetCount", str(len(local_images))),
            ),
        )
        connection.execute(
            "INSERT INTO source_documents(source_ref, top_level_type, json_data) VALUES (?, ?, ?)",
            (NAVIGATION_URL, "dict", navigation_json),
        )
        navigation_content = navigation.get("content")
        if not isinstance(navigation_content, dict):
            raise ValueError("The ODIN navigation response has no content object.")
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
                    compact_json(card),
                ),
            )

            searchable: list[str] = []
            for kind in ("domain", "origin", "proliferation"):
                values = card.get(kind) or []
                if not isinstance(values, list):
                    raise ValueError(f"Card {identifier} has an invalid {kind} field.")
                for ordinal, item in enumerate(values):
                    if not isinstance(item, dict) or len(item) != 1:
                        raise ValueError(f"Card {identifier} has an invalid {kind} item.")
                    source_key, value = next(iter(item.items()))
                    connection.execute(
                        "INSERT INTO classifications VALUES (?, ?, ?, ?, ?)",
                        (identifier, kind, ordinal, str(source_key), str(value)),
                    )
                    searchable.append(str(value))

            for ordinal, image in enumerate(decode_list(card, "images")):
                source_path = str(image.get("url", ""))
                image_name = str(image.get("name", ""))
                local_path = local_images.get((identifier, ordinal))
                stored_path = None
                if local_path is not None:
                    stored_path = str(local_path.resolve().relative_to(output_path.parent.resolve()))
                connection.execute(
                    """INSERT INTO images
                       (card_identifier, ordinal, name, source_path, local_path)
                       VALUES (?, ?, ?, ?, ?)""",
                    (identifier, ordinal, image_name, source_path, stored_path),
                )

            searchable.extend(insert_sections(connection, identifier, decode_list(card, "sections")))
            connection.execute(
                "INSERT INTO cards_fts VALUES (?, ?, ?, ?, ?)",
                (
                    identifier,
                    str(card.get("name", "")),
                    str(card.get("title", "")),
                    str(card.get("notes", "")),
                    "\n".join(searchable),
                ),
            )

        connection.commit()
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")
    finally:
        connection.close()

    temporary_output.replace(output_path)
    print(f"Built {output_path} with {len(cards)} official WEG cards and {image_count} image references.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DATA_ROOT / "unitgenerator.db")
    parser.add_argument("--images", type=Path, default=DATA_ROOT / "images")
    parser.add_argument("--cache", type=Path, default=DATA_ROOT / "odin-cache")
    parser.add_argument("--schema", type=Path, default=Path(__file__).with_name("schema.sql"))
    parser.add_argument("--batch-size", type=int, default=5000)
    parser.add_argument("--refresh", action="store_true", help="Ignore cached ODIN API responses.")
    parser.add_argument(
        "--download-images",
        choices=("none", "primary", "all"),
        default="all",
        help="Download no new images, each first image, or every image. References are always imported.",
    )
    parser.add_argument("--workers", type=int, default=8, help="Concurrent image downloads.")
    arguments = parser.parse_args()
    if arguments.batch_size < 1 or arguments.workers < 1:
        parser.error("Batch size and workers must be positive.")

    navigation = cached_json(
        arguments.cache / "navigation.json",
        NAVIGATION_URL,
        arguments.refresh,
    )
    if not isinstance(navigation, dict):
        raise ValueError("The ODIN navigation response must be an object.")
    cards = load_cards(arguments.cache, arguments.refresh, arguments.batch_size)
    local_images = download_images(cards, arguments.images, arguments.download_images, arguments.workers)
    build_database(
        cards,
        navigation,
        arguments.output,
        arguments.images,
        local_images,
        arguments.schema,
        arguments.batch_size,
    )
    if arguments.download_images == "all":
        removed = prune_image_directory(arguments.images, local_images)
        if removed:
            print(f"Removed {removed} obsolete image files.")


if __name__ == "__main__":
    main()
