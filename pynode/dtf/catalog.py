from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .peer import Address, DiscoveredPeer
from .protocol import FileRecord
from .swarm import SwarmSource


@dataclass(frozen=True)
class PeerFile:
    peer: DiscoveredPeer
    record: FileRecord


@dataclass(frozen=True)
class CatalogFile:
    file_id: bytes
    file_size: int
    name: str
    media_type: str
    sources: tuple[SwarmSource, ...]

    @property
    def display_id(self) -> str:
        return self.file_id.hex()[:16]


def peer_display_name(peer: DiscoveredPeer) -> str:
    if peer.name:
        return peer.name
    return f"{peer.address[0]}:{peer.address[1]}"


def available_from_label(peers: Iterable[DiscoveredPeer]) -> str:
    names: list[str] = [peer_display_name(peer) for peer in peers]
    if not names:
        return ""
    if len(names) <= 2:
        return ", ".join(names)
    return f"{names[0]} + {len(names) - 1} more"


def build_catalog(peer_files: Iterable[PeerFile]) -> list[CatalogFile]:
    grouped: dict[tuple[bytes, int], list[PeerFile]] = {}
    for peer_file in peer_files:
        key: tuple[bytes, int] = (peer_file.record.file_id, peer_file.record.file_size)
        grouped.setdefault(key, []).append(peer_file)

    catalog: list[CatalogFile] = []
    for (file_id, file_size), entries in grouped.items():
        name_sorted_entries: list[PeerFile] = sorted(
            entries,
            key=lambda entry: (
                entry.record.name.lower(),
                peer_display_name(entry.peer).lower(),
                entry.peer.address,
            ),
        )
        source_sorted_entries: list[PeerFile] = sorted(
            entries,
            key=lambda entry: (peer_display_name(entry.peer).lower(), entry.peer.address),
        )
        display_record: FileRecord = name_sorted_entries[0].record
        sources: tuple[SwarmSource, ...] = tuple(
            SwarmSource(peer=entry.peer, record=entry.record) for entry in source_sorted_entries
        )
        catalog.append(
            CatalogFile(
                file_id=file_id,
                file_size=file_size,
                name=display_record.name,
                media_type=display_record.media_type,
                sources=sources,
            )
        )

    return sorted(catalog, key=lambda item: (item.name.lower(), item.file_size, item.file_id))


def filter_catalog_by_name(catalog: Iterable[CatalogFile], query: str) -> list[CatalogFile]:
    normalized_query: str = query.casefold()
    if not normalized_query:
        return list(catalog)
    return [item for item in catalog if normalized_query in item.name.casefold()]


def records_by_peer_to_peer_files(
    peers: Iterable[DiscoveredPeer],
    records_by_peer: dict[Address, Iterable[FileRecord]],
) -> list[PeerFile]:
    peer_files: list[PeerFile] = []
    for peer in peers:
        for record in records_by_peer.get(peer.address, ()):
            peer_files.append(PeerFile(peer=peer, record=record))
    return peer_files
