from __future__ import annotations

import concurrent.futures
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .peer import Address, DTFPeer, DiscoveredPeer
from .protocol import DEFAULT_MAX_DATAGRAM, FileRecord, QueryKind


DEFAULT_SWARM_RANGE_SIZE: int = 64 * 1024


@dataclass(frozen=True)
class SwarmSource:
    peer: DiscoveredPeer
    record: FileRecord


@dataclass(frozen=True)
class RangeTask:
    start: int
    end: int
    attempts: int = 0


@dataclass(frozen=True)
class RangeResult:
    start: int
    data: bytes
    source: SwarmSource


@dataclass(frozen=True)
class SwarmDownloadResult:
    output_path: Path
    file_size: int
    source_count: int
    range_count: int


def split_ranges(file_size: int, range_size: int = DEFAULT_SWARM_RANGE_SIZE) -> list[RangeTask]:
    if file_size < 0:
        raise ValueError("file_size must not be negative")
    if range_size <= 0:
        raise ValueError("range_size must be positive")
    return [RangeTask(start, min(start + range_size, file_size)) for start in range(0, file_size, range_size)]


def matching_sources(
    peers: Iterable[DiscoveredPeer],
    records_by_peer: dict[Address, Iterable[FileRecord]],
    file_id: bytes,
    file_size: int,
) -> list[SwarmSource]:
    sources: list[SwarmSource] = []
    seen: set[Address] = set()
    for peer in peers:
        if peer.address in seen:
            continue
        for record in records_by_peer.get(peer.address, ()):
            if record.file_id == file_id and record.file_size == file_size:
                sources.append(SwarmSource(peer=peer, record=record))
                seen.add(peer.address)
                break
    return sources


def merge_discovered_peers(peers: Iterable[DiscoveredPeer]) -> list[DiscoveredPeer]:
    merged: dict[Address, DiscoveredPeer] = {}
    for peer in peers:
        merged[peer.address] = peer
    return sorted(merged.values(), key=lambda peer: (peer.address[0], peer.address[1], peer.name))


def find_swarm_sources(
    peer: DTFPeer,
    peers: Iterable[DiscoveredPeer],
    file_id: bytes,
    file_size: int,
    timeout: float = 0.7,
    attempts: int = 2,
) -> list[SwarmSource]:
    records_by_peer: dict[Address, list[FileRecord]] = {}
    for discovered_peer in peers:
        responses = peer.find(
            discovered_peer.address,
            query_kind=QueryKind.EXACT_FILE_ID,
            query=file_id.hex(),
            max_results=5,
            timeout=timeout,
            attempts=attempts,
        )
        records_by_peer[discovered_peer.address] = [
            record for response in responses for record in response.records
        ]
    return matching_sources(peers, records_by_peer, file_id=file_id, file_size=file_size)


def download_swarm(
    peer: DTFPeer,
    sources: list[SwarmSource],
    file_id: bytes,
    file_size: int,
    output_path: Path,
    range_size: int = DEFAULT_SWARM_RANGE_SIZE,
    max_datagram: int = DEFAULT_MAX_DATAGRAM,
    timeout: float = 1.0,
    attempts_per_range: int = 4,
) -> SwarmDownloadResult:
    if not sources:
        raise ValueError("at least one swarm source is required")
    tasks: list[RangeTask] = split_ranges(file_size, range_size=range_size)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as output:
        output.truncate(file_size)
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(sources)) as executor:
            pending: dict[concurrent.futures.Future[RangeResult], tuple[RangeTask, SwarmSource]] = {}
            source_index: int = 0
            for task in tasks:
                source: SwarmSource = sources[source_index % len(sources)]
                source_index += 1
                pending[_submit_range(executor, peer, source, file_id, task, max_datagram, timeout)] = (task, source)

            completed: int = 0
            while pending:
                done, _ = concurrent.futures.wait(
                    pending,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                for future in done:
                    task, source = pending.pop(future)
                    try:
                        result: RangeResult = future.result()
                    except Exception:
                        retry_task: RangeTask = RangeTask(task.start, task.end, task.attempts + 1)
                        if retry_task.attempts >= attempts_per_range:
                            raise
                        retry_source: SwarmSource = sources[source_index % len(sources)]
                        source_index += 1
                        pending[
                            _submit_range(
                                executor,
                                peer,
                                retry_source,
                                file_id,
                                retry_task,
                                max_datagram,
                                timeout,
                            )
                        ] = (retry_task, retry_source)
                        continue
                    output.seek(result.start)
                    output.write(result.data)
                    completed += 1
                    peer.logger(
                        f"SWARM wrote range {result.start}:{result.start + len(result.data)} "
                        f"from {result.source.peer.address[0]}:{result.source.peer.address[1]}"
                    )

    digest: bytes = _sha256_path(output_path)
    if digest != file_id:
        raise ValueError("downloaded file SHA-256 does not match file ID")
    return SwarmDownloadResult(
        output_path=output_path,
        file_size=file_size,
        source_count=len(sources),
        range_count=completed,
    )


def _submit_range(
    executor: concurrent.futures.Executor,
    peer: DTFPeer,
    source: SwarmSource,
    file_id: bytes,
    task: RangeTask,
    max_datagram: int,
    timeout: float,
) -> concurrent.futures.Future[RangeResult]:
    return executor.submit(_download_range_from_source, peer, source, file_id, task, max_datagram, timeout)


def _download_range_from_source(
    peer: DTFPeer,
    source: SwarmSource,
    file_id: bytes,
    task: RangeTask,
    max_datagram: int,
    timeout: float,
) -> RangeResult:
    data: bytes = peer.download_range(
        peer=source.peer.address,
        file_id=file_id,
        start=task.start,
        end=task.end,
        max_datagram=max_datagram,
        timeout=timeout,
    )
    return RangeResult(start=task.start, data=data, source=source)


def _sha256_path(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while True:
            chunk: bytes = file.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.digest()
