from __future__ import annotations

import unittest

from dtf.protocol import (
    FILE_ID_LEN,
    FindFiles,
    Files,
    FileRecord,
    GetRange,
    IntervalSet,
    MalformedMessage,
    MessageType,
    QueryKind,
    RangeData,
    crc32,
    decode_datagram,
    decode_payload,
    encode_message_datagram,
    encode_payload,
    missing_subranges,
)


class ProtocolTest(unittest.TestCase):
    def test_find_files_datagram_round_trip(self) -> None:
        sender_id: bytes = b"a" * 16
        message: FindFiles = FindFiles(
            query_kind=QueryKind.SUBSTRING,
            max_results=10,
            query="report",
        )

        datagram: bytes = encode_message_datagram(
            MessageType.FIND_FILES,
            message,
            request_id=123,
            session_id=0,
            sender_id=sender_id,
        )

        packet = decode_datagram(datagram)
        self.assertIsNotNone(packet)
        assert packet is not None
        self.assertEqual(packet.header.request_id, 123)
        self.assertEqual(packet.header.sender_id, sender_id)
        decoded = decode_payload(packet.header.message_type, packet.payload)
        self.assertEqual(decoded, message)

    def test_invalid_datagrams_are_ignored(self) -> None:
        self.assertIsNone(decode_datagram(b""))
        self.assertIsNone(decode_datagram(b"NOPE" + b"\x00" * 40))

    def test_files_payload_round_trip(self) -> None:
        record: FileRecord = FileRecord(
            file_id=b"f" * FILE_ID_LEN,
            file_size=99,
            chunk_size=65536,
            name="demo.txt",
            media_type="text/plain",
            tags=("demo", "text"),
        )
        message: Files = Files(total_matches=1, records=(record,))

        payload: bytes = encode_payload(message)
        decoded = decode_payload(MessageType.FILES, payload)

        self.assertEqual(decoded, message)

    def test_range_data_crc_and_length_validation(self) -> None:
        message: RangeData = RangeData(
            file_id=b"x" * FILE_ID_LEN,
            requested_from=10,
            requested_to=15,
            data_offset=10,
            data=b"hello",
        )

        payload: bytes = encode_payload(message)
        decoded = decode_payload(MessageType.RANGE_DATA, payload)

        self.assertIsInstance(decoded, RangeData)
        assert isinstance(decoded, RangeData)
        self.assertEqual(decoded.data_crc32, crc32(b"hello"))

        malformed: bytearray = bytearray(payload)
        malformed[FILE_ID_LEN + 8 + 8 + 8 + 1] = 99
        with self.assertRaises(MalformedMessage):
            decode_payload(MessageType.RANGE_DATA, bytes(malformed))

    def test_interval_set_tracks_missing_ranges(self) -> None:
        intervals: IntervalSet = IntervalSet()
        self.assertTrue(intervals.add(10, 20))
        self.assertFalse(intervals.add(10, 20))
        self.assertTrue(intervals.add(30, 40))
        self.assertTrue(intervals.add(18, 32))
        self.assertTrue(intervals.covers(10, 40))
        self.assertEqual(intervals.missing(0, 45), [(0, 10), (40, 45)])

    def test_missing_subranges_accepts_unsorted_ranges(self) -> None:
        missing = missing_subranges([(20, 30), (0, 10), (8, 22)], 0, 35)
        self.assertEqual(missing, [(30, 35)])


class GetRangeTest(unittest.TestCase):
    def test_get_range_payload_round_trip(self) -> None:
        message: GetRange = GetRange(
            file_id=b"g" * FILE_ID_LEN,
            from_offset=1,
            to_offset=100,
            max_datagram=1200,
        )

        decoded = decode_payload(MessageType.GET_RANGE, encode_payload(message))

        self.assertEqual(decoded, message)


if __name__ == "__main__":
    unittest.main()
