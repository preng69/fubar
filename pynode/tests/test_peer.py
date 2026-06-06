from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from dtf.files import SharedFile
from dtf.peer import (
    DEFAULT_MAX_RANGE_BYTES,
    DTFPeer,
    RangeRequestError,
    datagram_payload_capacity,
    fit_files_response,
    iter_range_data,
    validate_range_request,
)
from dtf.protocol import FILE_ID_LEN, HEADER_LEN, FileRecord, GetRange, Header, MessageType, RangeData, crc32, encode_payload


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

        self.assertEqual(logs, ["TX HELLO 127.0.0.1:4747 request_id=1 session_id=2"])

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


if __name__ == "__main__":
    unittest.main()
