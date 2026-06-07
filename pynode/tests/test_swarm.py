from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from dtf.peer import Address, DTFPeer, DiscoveredPeer
from dtf.protocol import FileRecord, Files
from dtf.swarm import (
    DEFAULT_CONCURRENT_RANGES_PER_PEER,
    SwarmSource,
    download_swarm,
    find_swarm_sources,
    matching_sources,
    merge_discovered_peers,
    split_ranges,
)


class FakeRangePeer(DTFPeer):
    def __init__(self, payload: bytes, fail_first_start: int | None = None) -> None:
        super().__init__(logger=lambda _line: None)
        self.payload: bytes = payload
        self.fail_first_start: int | None = fail_first_start
        self.calls: list[tuple[Address, int, int]] = []
        self.failed_starts: set[int] = set()

    def download_range(
        self,
        peer: Address,
        file_id: bytes,
        start: int,
        end: int,
        max_datagram: int = 1200,
        timeout: float = 1.0,
        attempts: int = 4,
    ) -> bytes:
        self.calls.append((peer, start, end))
        if self.fail_first_start == start and start not in self.failed_starts:
            self.failed_starts.add(start)
            raise TimeoutError("planned failure")
        return self.payload[start:end]


class FakeFindPeer(DTFPeer):
    def __init__(self, responses: dict[Address, list[Files]]) -> None:
        super().__init__(logger=lambda _line: None)
        self.responses: dict[Address, list[Files]] = responses

    def find(
        self,
        peer: Address,
        query_kind: int,
        query: str,
        max_results: int = 25,
        timeout: float = 0.5,
        attempts: int = 2,
    ) -> list[Files]:
        return self.responses.get(peer, [])


class SwarmTest(unittest.TestCase):
    def test_split_ranges(self) -> None:
        self.assertEqual([(task.start, task.end) for task in split_ranges(10, 4)], [(0, 4), (4, 8), (8, 10)])

    def test_matching_sources_filters_by_file_id_and_size(self) -> None:
        wanted_id: bytes = b"a" * 32
        other_id: bytes = b"b" * 32
        peers: list[DiscoveredPeer] = [
            DiscoveredPeer(("10.0.0.2", 4747), session_id=1, listen_port=4747, name="one"),
            DiscoveredPeer(("10.0.0.3", 4747), session_id=2, listen_port=4747, name="two"),
        ]
        wanted_record: FileRecord = FileRecord(wanted_id, 100, 4096, "demo.bin", "application/octet-stream")
        wrong_record: FileRecord = FileRecord(other_id, 100, 4096, "other.bin", "application/octet-stream")

        sources = matching_sources(
            peers,
            {
                peers[0].address: [wanted_record],
                peers[1].address: [wrong_record],
            },
            file_id=wanted_id,
            file_size=100,
        )

        self.assertEqual(sources, [SwarmSource(peer=peers[0], record=wanted_record)])

    def test_find_swarm_sources_queries_exact_file_id(self) -> None:
        file_id: bytes = b"c" * 32
        peer_info: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one")
        record: FileRecord = FileRecord(file_id, 5, 4096, "demo.bin", "application/octet-stream")
        fake_peer: FakeFindPeer = FakeFindPeer({peer_info.address: [Files(total_matches=1, records=(record,))]})

        sources = find_swarm_sources(fake_peer, [peer_info], file_id=file_id, file_size=5)

        self.assertEqual(sources, [SwarmSource(peer=peer_info, record=record)])

    def test_merge_discovered_peers_dedupes_by_address(self) -> None:
        older: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "old")
        newer: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 2, 4747, "new")
        other: DiscoveredPeer = DiscoveredPeer(("10.0.0.3", 4747), 3, 4747, "other")

        merged = merge_discovered_peers([older, other, newer])

        self.assertEqual(merged, [newer, other])

    def test_download_swarm_assembles_ranges_from_workers(self) -> None:
        payload: bytes = b"abcdefghijklmnopqrstuvwxyz"
        file_id: bytes = hashlib.sha256(payload).digest()
        peer_infos: list[DiscoveredPeer] = [
            DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one"),
            DiscoveredPeer(("10.0.0.3", 4747), 2, 4747, "two"),
        ]
        record: FileRecord = FileRecord(file_id, len(payload), 4096, "demo.bin", "application/octet-stream")
        sources: list[SwarmSource] = [SwarmSource(peer=peer_info, record=record) for peer_info in peer_infos]
        fake_peer: FakeRangePeer = FakeRangePeer(payload)

        with tempfile.TemporaryDirectory() as directory:
            output_path: Path = Path(directory) / "out.bin"
            result = download_swarm(fake_peer, sources, file_id, len(payload), output_path, range_size=5)

            self.assertEqual(output_path.read_bytes(), payload)
            self.assertEqual(result.source_count, 2)
            self.assertEqual(result.range_count, 6)
            self.assertGreater(len({call[0] for call in fake_peer.calls}), 1)

    def test_default_concurrent_ranges_per_peer_is_ten(self) -> None:
        self.assertEqual(DEFAULT_CONCURRENT_RANGES_PER_PEER, 10)

    def test_download_swarm_rejects_non_positive_concurrency(self) -> None:
        payload: bytes = b"abc"
        file_id: bytes = hashlib.sha256(payload).digest()
        peer_info: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one")
        record: FileRecord = FileRecord(file_id, len(payload), 4096, "demo.bin", "application/octet-stream")

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                download_swarm(
                    FakeRangePeer(payload),
                    [SwarmSource(peer=peer_info, record=record)],
                    file_id,
                    len(payload),
                    Path(directory) / "out.bin",
                    concurrent_ranges_per_peer=0,
                )

    def test_download_swarm_retries_failed_range(self) -> None:
        payload: bytes = b"abcdefghij"
        file_id: bytes = hashlib.sha256(payload).digest()
        peer_info: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one")
        record: FileRecord = FileRecord(file_id, len(payload), 4096, "demo.bin", "application/octet-stream")
        fake_peer: FakeRangePeer = FakeRangePeer(payload, fail_first_start=0)

        with tempfile.TemporaryDirectory() as directory:
            output_path: Path = Path(directory) / "out.bin"
            download_swarm(
                fake_peer,
                [SwarmSource(peer=peer_info, record=record)],
                file_id,
                len(payload),
                output_path,
                range_size=5,
                attempts_per_range=2,
            )

            self.assertEqual(output_path.read_bytes(), payload)
            self.assertEqual(fake_peer.calls.count((peer_info.address, 0, 5)), 2)


if __name__ == "__main__":
    unittest.main()
