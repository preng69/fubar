from __future__ import annotations

import hashlib
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .protocol import DEFAULT_MAX_DATAGRAM, FILE_ID_LEN, FileRecord, QueryKind


DEFAULT_CHUNK_SIZE: int = 64 * 1024


@dataclass(frozen=True)
class SharedFile:
    path: Path
    file_id: bytes
    file_size: int
    chunk_size: int
    name: str
    media_type: str
    tags: tuple[str, ...]

    def to_record(self) -> FileRecord:
        return FileRecord(
            file_id=self.file_id,
            file_size=self.file_size,
            chunk_size=self.chunk_size,
            name=self.name,
            media_type=self.media_type,
            tags=self.tags,
        )


def sha256_file(path: Path, block_size: int = 1024 * 1024) -> bytes:
    digest: hashlib._Hash = hashlib.sha256()
    with path.open("rb") as file:
        while True:
            block: bytes = file.read(block_size)
            if not block:
                break
            digest.update(block)
    return digest.digest()


def file_id_from_hex(value: str) -> bytes:
    normalized: str = value.strip().lower()
    if len(normalized) != FILE_ID_LEN * 2:
        raise ValueError("file id must be 64 lowercase hexadecimal characters")
    try:
        result: bytes = bytes.fromhex(normalized)
    except ValueError as exc:
        raise ValueError("file id must be valid hexadecimal") from exc
    if normalized != result.hex():
        raise ValueError("file id must be lowercase hexadecimal")
    return result


def media_type_for_path(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def iter_files(paths: Iterable[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_dir():
            files.extend(sorted(child for child in path.rglob("*") if child.is_file()))
        elif path.is_file():
            files.append(path)
        else:
            raise FileNotFoundError(str(path))
    return files


def index_paths(
    paths: Iterable[Path],
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    tags: Iterable[str] = (),
) -> list[SharedFile]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    normalized_tags: tuple[str, ...] = tuple(tag for tag in tags if tag)
    shared_files: list[SharedFile] = []
    for path in iter_files(paths):
        resolved: Path = path.resolve()
        size: int = resolved.stat().st_size
        shared_files.append(
            SharedFile(
                path=resolved,
                file_id=sha256_file(resolved),
                file_size=size,
                chunk_size=chunk_size,
                name=resolved.name,
                media_type=media_type_for_path(resolved),
                tags=normalized_tags,
            )
        )
    return shared_files


def match_files(
    shared_files: Iterable[SharedFile],
    query_kind: int,
    query: str,
    max_results: int,
) -> tuple[int, list[FileRecord]]:
    matches: list[SharedFile] = []
    normalized_query: str = query.strip()
    try:
        kind: QueryKind = QueryKind(query_kind)
    except ValueError:
        return 0, []

    if kind == QueryKind.LIST_ALL:
        matches = list(shared_files)
    elif kind == QueryKind.SUBSTRING:
        needle: str = normalized_query.lower()
        matches = [item for item in shared_files if needle in item.name.lower()]
    elif kind == QueryKind.EXACT_FILE_ID:
        try:
            wanted: bytes = file_id_from_hex(normalized_query)
        except ValueError:
            matches = []
        else:
            matches = [item for item in shared_files if item.file_id == wanted]
    elif kind == QueryKind.TAG:
        wanted_tag: str = normalized_query.lower()
        matches = [item for item in shared_files if wanted_tag in {tag.lower() for tag in item.tags}]

    limit: int = max_results if max_results > 0 else DEFAULT_MAX_DATAGRAM
    records: list[FileRecord] = [item.to_record() for item in matches[:limit]]
    return len(matches), records


def find_shared_file(shared_files: Iterable[SharedFile], file_id: bytes) -> SharedFile | None:
    for shared_file in shared_files:
        if shared_file.file_id == file_id:
            return shared_file
    return None
