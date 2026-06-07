from __future__ import annotations

import shutil
from pathlib import Path

from .files import DEFAULT_CHUNK_SIZE, index_paths
from .peer import DTFPeer, DiscoveredPeer
from .protocol import FileRecord, QueryKind


APP_NAME: str = "DTF boss"


def app_header_title(peer_name: str) -> str:
    normalized: str = peer_name.strip()
    if not normalized:
        return APP_NAME
    return f"{APP_NAME} - {normalized}"


def file_list_title(filter_active: bool, filter_text: str) -> str:
    if filter_active or filter_text:
        return f"Files matching /{filter_text}"
    return "Files"


def file_query_for_filter(filter_text: str) -> tuple[QueryKind, str]:
    if filter_text:
        return QueryKind.SUBSTRING, filter_text
    return QueryKind.LIST_ALL, ""


def selected_index(explicit_key: str | None, cursor_row: int, row_count: int) -> int | None:
    if explicit_key is not None:
        try:
            index: int = int(explicit_key)
        except ValueError:
            index = -1
        else:
            if 0 <= index < row_count:
                return index
    if 0 <= cursor_row < row_count:
        return cursor_row
    return None


def safe_filename(name: str, fallback: str = "downloaded-file") -> str:
    candidate: str = Path(name).name.strip()
    if not candidate or candidate in {".", ".."}:
        candidate = fallback
    return candidate.replace("/", "_").replace("\\", "_")


def collision_safe_path(directory: Path, filename: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    safe_name: str = safe_filename(filename)
    candidate: Path = directory / safe_name
    if not candidate.exists():
        return candidate
    stem: str = candidate.stem
    suffix: str = candidate.suffix
    index: int = 1
    while True:
        next_candidate: Path = directory / f"{stem} ({index}){suffix}"
        if not next_candidate.exists():
            return next_candidate
        index += 1


def download_path_for(record: FileRecord, downloads_dir: Path | None = None) -> Path:
    target_dir: Path = downloads_dir or Path.home() / "Downloads"
    return collision_safe_path(target_dir, record.name)


def served_copy_path_for(record: FileRecord, served_folder: Path) -> Path:
    return collision_safe_path(served_folder, record.name)


def copy_into_served_folder(source: Path, served_folder: Path, record: FileRecord) -> Path:
    destination: Path = served_copy_path_for(record, served_folder)
    if source.resolve() == destination.resolve():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return destination


def refresh_shared_files(
    peer: DTFPeer,
    served_folder: Path,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> int:
    shared_files = index_paths([served_folder], chunk_size=chunk_size)
    peer.set_shared_files(shared_files)
    return len(shared_files)


def peer_label(peer: DiscoveredPeer) -> str:
    name: str = peer.name or "(unnamed)"
    return f"{peer.address[0]}:{peer.address[1]} {name}"


def file_label(record: FileRecord) -> str:
    return f"{record.name} ({record.file_size} bytes)"
