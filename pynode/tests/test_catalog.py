from __future__ import annotations

import unittest

from dtf.catalog import (
    CatalogFile,
    PeerFile,
    available_from_label,
    build_catalog,
    filter_catalog_by_name,
    peer_display_name,
    records_by_peer_to_peer_files,
)
from dtf.peer import DiscoveredPeer
from dtf.protocol import FileRecord


class CatalogTest(unittest.TestCase):
    def test_available_from_label_collapses_after_two_peers(self) -> None:
        peers: list[DiscoveredPeer] = [
            DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "alpha"),
            DiscoveredPeer(("10.0.0.3", 4747), 2, 4747, "bravo"),
            DiscoveredPeer(("10.0.0.4", 4747), 3, 4747, "charlie"),
        ]

        self.assertEqual(available_from_label(peers[:1]), "alpha")
        self.assertEqual(available_from_label(peers[:2]), "alpha, bravo")
        self.assertEqual(available_from_label(peers), "alpha + 2 more")

    def test_peer_display_name_falls_back_to_address(self) -> None:
        peer: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "")

        self.assertEqual(peer_display_name(peer), "10.0.0.2:4747")

    def test_build_catalog_groups_by_file_id_and_size(self) -> None:
        file_id: bytes = b"a" * 32
        peer_one: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one")
        peer_two: DiscoveredPeer = DiscoveredPeer(("10.0.0.3", 4747), 2, 4747, "two")
        entries: list[PeerFile] = [
            PeerFile(peer_one, FileRecord(file_id, 100, 4096, "zeta.bin", "application/octet-stream")),
            PeerFile(peer_two, FileRecord(file_id, 100, 4096, "alpha.bin", "application/octet-stream")),
        ]

        catalog = build_catalog(entries)

        self.assertEqual(len(catalog), 1)
        self.assertEqual(catalog[0].name, "alpha.bin")
        self.assertEqual([source.peer for source in catalog[0].sources], [peer_one, peer_two])

    def test_build_catalog_keeps_conflicting_sizes_separate_and_sorts(self) -> None:
        file_id: bytes = b"a" * 32
        peer: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one")

        catalog = build_catalog(
            [
                PeerFile(peer, FileRecord(b"b" * 32, 10, 4096, "bravo.bin", "application/octet-stream")),
                PeerFile(peer, FileRecord(file_id, 200, 4096, "alpha.bin", "application/octet-stream")),
                PeerFile(peer, FileRecord(file_id, 100, 4096, "alpha.bin", "application/octet-stream")),
            ]
        )

        self.assertEqual([(item.name, item.file_size) for item in catalog], [("alpha.bin", 100), ("alpha.bin", 200), ("bravo.bin", 10)])

    def test_records_by_peer_to_peer_files_uses_peer_order(self) -> None:
        peer: DiscoveredPeer = DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one")
        record: FileRecord = FileRecord(b"a" * 32, 10, 4096, "alpha.bin", "application/octet-stream")

        peer_files = records_by_peer_to_peer_files([peer], {peer.address: [record]})

        self.assertEqual(peer_files, [PeerFile(peer, record)])

    def test_filter_catalog_by_name_matches_case_insensitively(self) -> None:
        catalog: list[CatalogFile] = [
            _catalog_file("alpha Report.txt"),
            _catalog_file("budget.csv"),
            _catalog_file("REPORT-final.pdf"),
        ]

        self.assertEqual(
            [item.name for item in filter_catalog_by_name(catalog, "report")],
            ["alpha Report.txt", "REPORT-final.pdf"],
        )
        self.assertEqual(
            [item.name for item in filter_catalog_by_name(catalog, "PHA r")],
            ["alpha Report.txt"],
        )

    def test_filter_catalog_by_name_empty_query_returns_all_files(self) -> None:
        catalog: list[CatalogFile] = [_catalog_file("alpha.txt"), _catalog_file("bravo.txt")]

        self.assertEqual(filter_catalog_by_name(catalog, ""), catalog)


def _catalog_file(name: str) -> CatalogFile:
    return build_catalog(
        [
            PeerFile(
                DiscoveredPeer(("10.0.0.2", 4747), 1, 4747, "one"),
                FileRecord(name.encode("utf-8").ljust(32, b"x")[:32], 10, 4096, name, "text/plain"),
            )
        ]
    )[0]


if __name__ == "__main__":
    unittest.main()
