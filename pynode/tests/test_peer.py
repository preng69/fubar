from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from dtf.files import SharedFile
from dtf.peer import (
    DEFAULT_MAX_RANGE_BYTES,
    BackgroundPeerServer,
    DiscoveredPeer,
    DTFPeer,
    RangeRequestError,
    broadcast_from_ipv4,
    datagram_payload_capacity,
    fit_files_response,
    iter_range_data,
    _message_log_detail,
    _short_id,
    remember_discovered_peer,
    validate_range_request,
)
from dtf.protocol import (
    FILE_ID_LEN,
    HEADER_LEN,
    FileRecord,
    GetRange,
    Header,
    HelloAck,
    MessageType,
    Packet,
    RangeData,
    crc32,
    encode_payload,
)


class PeerRangeTest(unittest.TestCase):
    def test_iter_range_data_chunks_to_fit_datagram(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path: Path = Path(directory) / "payload.bin"
            payload: bytes = bytes(range(256)) * 4
            path.write_bytes(payload)
            file_id: bytes = hashlib.sha256(payload).digest()
            shared_file: SharedFile = SharedFile(
                path=path,
                file_id=file_id,
                file_size=len(payload),
                chunk_size=4096,
                name=path.name,
                media_type="application/octet-stream",
                tags=(),
            )
            request: GetRange = GetRange(
                file_id=file_id,
                from_offset=10,
                to_offset=300,
                max_datagram=128,
            )

            chunks: list[RangeData] = list(iter_range_data(shared_file, request))

            capacity: int = datagram_payload_capacity(128)
            self.assertGreater(capacity, 0)
            self.assertTrue(all(len(chunk.data) <= capacity for chunk in chunks))
            self.assertEqual(b"".join(chunk.data for chunk in chunks), payload[10:300])
            self.assertTrue(all(chunk.crc32 == crc32(chunk.data) for chunk in chunks))

    def test_validate_range_request_rejects_invalid_ranges(self) -> None:
        shared_file: SharedFile = SharedFile(
            path=Path("/tmp/unused"),
            file_id=b"a" * FILE_ID_LEN,
            file_size=100,
            chunk_size=4096,
            name="unused",
            media_type="application/octet-stream",
            tags=(),
        )

        with self.assertRaises(RangeRequestError):
            validate_range_request(shared_file, GetRange(shared_file.file_id, 10, 10, 1200))
        with self.assertRaises(RangeRequestError):
            validate_range_request(shared_file, GetRange(shared_file.file_id, 0, 101, 1200))
        with self.assertRaises(RangeRequestError):
            validate_range_request(
                shared_file,
                GetRange(shared_file.file_id, 0, DEFAULT_MAX_RANGE_BYTES + 1, 1200),
            )

    def test_log_includes_command_and_identifiers(self) -> None:
        logs: list[str] = []
        peer: DTFPeer = DTFPeer(peer_id=b"p" * 16, logger=logs.append)
        header: Header = Header(
            message_type=MessageType.HELLO,
            flags=0,
            payload_len=0,
            request_id=1,
            session_id=2,
            sender_id=b"p" * 16,
        )

        peer._log("TX", header, ("127.0.0.1", 4747))

        self.assertEqual(logs, ["TX HELLO 127.0.0.1:4747 request_id=..1 session_id=..2"])

    def test_get_range_log_detail_includes_range_indexes(self) -> None:
        detail: str = _message_log_detail(
            GetRange(file_id=b"a" * FILE_ID_LEN, from_offset=1024, to_offset=2048, max_datagram=1200)
        )

        self.assertEqual(detail, "range=1024:2048 file_id=..6161")

    def test_short_id_truncates_to_last_four_characters(self) -> None:
        self.assertEqual(_short_id(123456789836), "..9836")
        self.assertEqual(_short_id(b"\x00\x01\xab\xcd"), "..abcd")

    def test_range_data_is_not_logged(self) -> None:
        logs: list[str] = []
        peer: DTFPeer = DTFPeer(peer_id=b"p" * 16, logger=logs.append)
        header: Header = Header(
            message_type=MessageType.RANGE_DATA,
            flags=0,
            payload_len=0,
            request_id=123456,
            session_id=654321,
            sender_id=b"p" * 16,
        )

        peer._log("RX", header, ("127.0.0.1", 4747))
        peer._log("TX", header, ("127.0.0.1", 4747))

        self.assertEqual(logs, [])

    def test_shared_files_can_be_replaced_safely(self) -> None:
        peer: DTFPeer = DTFPeer(logger=lambda _line: None)
        shared_file: SharedFile = SharedFile(
            path=Path("/tmp/demo"),
            file_id=b"a" * FILE_ID_LEN,
            file_size=1,
            chunk_size=4096,
            name="demo",
            media_type="application/octet-stream",
            tags=(),
        )

        peer.set_shared_files([shared_file])

        self.assertEqual(peer.get_shared_files(), [shared_file])

    def test_hello_reuses_cached_peer_session(self) -> None:
        peer: DTFPeer = DTFPeer(logger=lambda _line: None)
        address: tuple[str, int] = ("127.0.0.1", 4747)
        peer.peer_sessions[address] = 1234
        peer.sessions[1234] = address

        self.assertEqual(peer.hello(address), 1234)

    def test_forget_session_removes_both_session_indexes(self) -> None:
        peer: DTFPeer = DTFPeer(logger=lambda _line: None)
        address: tuple[str, int] = ("127.0.0.1", 4747)
        peer.peer_sessions[address] = 1234
        peer.sessions[1234] = address

        peer.forget_session(address)

        self.assertEqual(peer.peer_sessions, {})
        self.assertEqual(peer.sessions, {})

    def test_background_server_initial_state_and_stop_are_safe(self) -> None:
        peer: DTFPeer = DTFPeer(logger=lambda _line: None)
        server: BackgroundPeerServer = BackgroundPeerServer(peer)

        self.assertFalse(server.is_running)
        server.stop()
        self.assertFalse(server.is_running)

    def test_broadcast_from_ipv4_sets_last_octet_to_255(self) -> None:
        self.assertEqual(broadcast_from_ipv4("192.168.1.42"), "192.168.1.255")
        self.assertEqual(broadcast_from_ipv4("10.2.0.9"), "10.2.0.255")
        with self.assertRaises(ValueError):
            broadcast_from_ipv4("not-an-ip")

    def test_fit_files_response_keeps_payload_inside_datagram_limit(self) -> None:
        records: list[FileRecord] = [
            FileRecord(
                file_id=bytes([index]) * FILE_ID_LEN,
                file_size=1,
                chunk_size=4096,
                name=f"large-name-{index}-" + ("x" * 100),
                media_type="application/octet-stream",
                tags=("demo",),
            )
            for index in range(10)
        ]

        response = fit_files_response(total_matches=len(records), records=records, max_datagram=300)

        self.assertLessEqual(len(encode_payload(response)) + HEADER_LEN, 300)
        self.assertLess(len(response.records), len(records))
        self.assertEqual(response.total_matches, len(records))

    def test_remember_discovered_peer_dedupes_by_advertised_port(self) -> None:
        discovered: dict[tuple[str, int], DiscoveredPeer] = {}
        packet: Packet = Packet(
            header=Header(
                message_type=MessageType.HELLO_ACK,
                flags=0,
                payload_len=0,
                request_id=99,
                session_id=1234,
                sender_id=b"s" * 16,
            ),
            payload=b"",
        )

        remember_discovered_peer(
            discovered,
            packet,
            HelloAck(listen_port=4747, name="alice"),
            ("192.168.1.10", 55555),
            request_id=99,
        )
        remember_discovered_peer(
            discovered,
            packet,
            HelloAck(listen_port=4747, name="alice"),
            ("192.168.1.10", 55556),
            request_id=99,
        )

        self.assertEqual(list(discovered), [("192.168.1.10", 4747)])
        self.assertEqual(discovered[("192.168.1.10", 4747)].name, "alice")

    def test_remember_discovered_peer_ignores_unrelated_packet(self) -> None:
        discovered: dict[tuple[str, int], DiscoveredPeer] = {}
        packet: Packet = Packet(
            header=Header(
                message_type=MessageType.FIND_FILES,
                flags=0,
                payload_len=0,
                request_id=100,
                session_id=1234,
                sender_id=b"s" * 16,
            ),
            payload=b"",
        )

        remember_discovered_peer(
            discovered,
            packet,
            HelloAck(listen_port=4747, name="alice"),
            ("192.168.1.10", 4747),
            request_id=99,
        )

        self.assertEqual(discovered, {})


if __name__ == "__main__":
    unittest.main()
