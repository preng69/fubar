from __future__ import annotations

import binascii
import os
import struct
from dataclasses import dataclass
from enum import IntEnum
from typing import Iterable, TypeAlias


MAGIC: bytes = b"DTF1"
VERSION: int = 1
HEADER_LEN: int = 44
DEFAULT_PORT: int = 4747
DEFAULT_MAX_DATAGRAM: int = 1200
PEER_ID_LEN: int = 16
FILE_ID_LEN: int = 32

_HEADER_STRUCT: struct.Struct = struct.Struct("!4sBBHHHQQ16s")


class DTFError(Exception):
    pass


class MalformedMessage(DTFError):
    pass


class MessageType(IntEnum):
    HELLO = 0x01
    HELLO_ACK = 0x02
    FIND_FILES = 0x10
    FILES = 0x11
    GET_RANGE = 0x20
    RANGE_DATA = 0x21
    RANGE_DONE = 0x22
    CANCEL = 0x30
    ERROR = 0x40


class QueryKind(IntEnum):
    LIST_ALL = 0
    SUBSTRING = 1
    EXACT_FILE_ID = 2
    TAG = 3


class ErrorCode(IntEnum):
    MALFORMED_MESSAGE = 1
    UNSUPPORTED_VERSION = 2
    UNKNOWN_SESSION = 3
    FILE_NOT_FOUND = 4
    INVALID_RANGE = 5
    RANGE_TOO_LARGE = 6
    TEMPORARILY_UNAVAILABLE = 7
    UNSUPPORTED_QUERY = 8


@dataclass(frozen=True)
class Header:
    message_type: int
    flags: int
    payload_len: int
    request_id: int
    session_id: int
    sender_id: bytes
    header_len: int = HEADER_LEN


@dataclass(frozen=True)
class Packet:
    header: Header
    payload: bytes


@dataclass(frozen=True)
class Hello:
    listen_port: int
    name: str


@dataclass(frozen=True)
class HelloAck:
    listen_port: int
    name: str


@dataclass(frozen=True)
class FindFiles:
    query_kind: int
    max_results: int
    query: str


@dataclass(frozen=True)
class FileRecord:
    file_id: bytes
    file_size: int
    chunk_size: int
    name: str
    media_type: str
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class Files:
    total_matches: int
    records: tuple[FileRecord, ...]


@dataclass(frozen=True)
class GetRange:
    file_id: bytes
    from_offset: int
    to_offset: int
    max_datagram: int


@dataclass(frozen=True)
class RangeData:
    file_id: bytes
    requested_from: int
    requested_to: int
    data_offset: int
    data: bytes
    data_crc32: int | None = None

    @property
    def crc32(self) -> int:
        if self.data_crc32 is None:
            return crc32(self.data)
        return self.data_crc32


@dataclass(frozen=True)
class RangeDone:
    file_id: bytes
    requested_from: int
    requested_to: int
    sent_bytes: int


@dataclass(frozen=True)
class Cancel:
    cancelled_request_id: int
    file_id: bytes


@dataclass(frozen=True)
class ErrorMessage:
    error_code: int
    detail: str


PayloadMessage: TypeAlias = (
    Hello
    | HelloAck
    | FindFiles
    | Files
    | GetRange
    | RangeData
    | RangeDone
    | Cancel
    | ErrorMessage
)


class BufferReader:
    def __init__(self, data: bytes) -> None:
        self._data: bytes = data
        self._offset: int = 0

    @property
    def remaining(self) -> int:
        return len(self._data) - self._offset

    def read(self, size: int) -> bytes:
        if size < 0 or self.remaining < size:
            raise MalformedMessage("payload ended unexpectedly")
        value: bytes = self._data[self._offset : self._offset + size]
        self._offset += size
        return value

    def read_u8(self) -> int:
        return self._unpack("!B", 1)

    def read_u16(self) -> int:
        return self._unpack("!H", 2)

    def read_u32(self) -> int:
        return self._unpack("!I", 4)

    def read_u64(self) -> int:
        return self._unpack("!Q", 8)

    def read_string(self) -> str:
        size: int = self.read_u16()
        raw: bytes = self.read(size)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise MalformedMessage("string is not valid UTF-8") from exc

    def require_end(self) -> None:
        if self.remaining != 0:
            raise MalformedMessage("payload has trailing bytes")

    def _unpack(self, fmt: str, size: int) -> int:
        return int(struct.unpack(fmt, self.read(size))[0])


class PacketAssembly:
    def __init__(self) -> None:
        self._parts: list[bytes] = []

    def add(self, data: bytes) -> None:
        self._parts.append(data)

    def add_u8(self, value: int) -> None:
        self._parts.append(struct.pack("!B", value))

    def add_u16(self, value: int) -> None:
        self._parts.append(struct.pack("!H", value))

    def add_u32(self, value: int) -> None:
        self._parts.append(struct.pack("!I", value))

    def add_u64(self, value: int) -> None:
        self._parts.append(struct.pack("!Q", value))

    def add_string(self, value: str) -> None:
        self._parts.append(encode_string(value))

    def build(self) -> bytes:
        return b"".join(self._parts)


@dataclass
class IntervalSet:
    intervals: list[tuple[int, int]]

    def __init__(self) -> None:
        self.intervals = []

    def add(self, start: int, end: int) -> bool:
        if start >= end:
            return False
        inserted: bool = False
        changed: bool = True
        merged: list[tuple[int, int]] = []
        new_start: int = start
        new_end: int = end
        for current_start, current_end in self.intervals:
            if current_end < new_start:
                merged.append((current_start, current_end))
            elif new_end < current_start:
                if not inserted:
                    merged.append((new_start, new_end))
                    inserted = True
                merged.append((current_start, current_end))
            else:
                new_start = min(new_start, current_start)
                new_end = max(new_end, current_end)
        if not inserted:
            merged.append((new_start, new_end))
        if merged == self.intervals:
            changed = False
        self.intervals = merged
        return changed

    def covers(self, start: int, end: int) -> bool:
        return any(left <= start and right >= end for left, right in self.intervals)

    def missing(self, start: int, end: int) -> list[tuple[int, int]]:
        missing: list[tuple[int, int]] = []
        cursor: int = start
        for left, right in self.intervals:
            if right <= cursor:
                continue
            if left > cursor:
                missing.append((cursor, min(left, end)))
            cursor = max(cursor, right)
            if cursor >= end:
                break
        if cursor < end:
            missing.append((cursor, end))
        return missing


def random_peer_id() -> bytes:
    return os.urandom(PEER_ID_LEN)


def random_u64() -> int:
    return int.from_bytes(os.urandom(8), "big")


def crc32(data: bytes) -> int:
    return binascii.crc32(data) & 0xFFFFFFFF


def message_type_name(message_type: int) -> str:
    try:
        return MessageType(message_type).name
    except ValueError:
        return f"UNKNOWN_0x{message_type:02x}"


def encode_string(value: str) -> bytes:
    raw: bytes = value.encode("utf-8")
    if len(raw) > 0xFFFF:
        raise ValueError("string is too long for DTF")
    return struct.pack("!H", len(raw)) + raw


def require_len(value: bytes, expected: int, name: str) -> None:
    if len(value) != expected:
        raise ValueError(f"{name} must be {expected} bytes")


def encode_datagram(
    message_type: int,
    payload: bytes,
    request_id: int,
    session_id: int,
    sender_id: bytes,
    flags: int = 0,
) -> bytes:
    require_len(sender_id, PEER_ID_LEN, "sender_id")
    if len(payload) > 0xFFFF:
        raise ValueError("payload is too large for DTF header")
    header: bytes = _HEADER_STRUCT.pack(
        MAGIC,
        VERSION,
        message_type,
        flags,
        HEADER_LEN,
        len(payload),
        request_id,
        session_id,
        sender_id,
    )
    return header + payload


def decode_datagram(datagram: bytes) -> Packet | None:
    if len(datagram) < HEADER_LEN:
        return None
    magic, version, message_type, flags, header_len, payload_len, request_id, session_id, sender_id = (
        _HEADER_STRUCT.unpack(datagram[:HEADER_LEN])
    )
    if magic != MAGIC or version != VERSION or header_len < HEADER_LEN:
        return None
    actual_payload_len: int = len(datagram) - header_len
    if actual_payload_len != payload_len:
        return None
    if header_len > len(datagram):
        return None
    payload: bytes = datagram[header_len:]
    return Packet(
        header=Header(
            message_type=message_type,
            flags=flags,
            header_len=header_len,
            payload_len=payload_len,
            request_id=request_id,
            session_id=session_id,
            sender_id=sender_id,
        ),
        payload=payload,
    )


def encode_payload(message: PayloadMessage) -> bytes:
    if isinstance(message, Hello):
        return _encode_hello_like(message.listen_port, message.name)
    if isinstance(message, HelloAck):
        return _encode_hello_like(message.listen_port, message.name)
    if isinstance(message, FindFiles):
        return _encode_find_files(message)
    if isinstance(message, Files):
        return _encode_files(message)
    if isinstance(message, GetRange):
        return _encode_get_range(message)
    if isinstance(message, RangeData):
        return _encode_range_data(message)
    if isinstance(message, RangeDone):
        return _encode_range_done(message)
    if isinstance(message, Cancel):
        return _encode_cancel(message)
    if isinstance(message, ErrorMessage):
        return _encode_error(message)
    raise TypeError(f"unsupported message payload: {type(message)!r}")


def decode_payload(message_type: int, payload: bytes) -> PayloadMessage | None:
    try:
        kind: MessageType = MessageType(message_type)
    except ValueError:
        return None
    reader: BufferReader = BufferReader(payload)
    if kind == MessageType.HELLO:
        return _decode_hello(reader)
    if kind == MessageType.HELLO_ACK:
        return _decode_hello_ack(reader)
    if kind == MessageType.FIND_FILES:
        return _decode_find_files(reader)
    if kind == MessageType.FILES:
        return _decode_files(reader)
    if kind == MessageType.GET_RANGE:
        return _decode_get_range(reader)
    if kind == MessageType.RANGE_DATA:
        return _decode_range_data(reader)
    if kind == MessageType.RANGE_DONE:
        return _decode_range_done(reader)
    if kind == MessageType.CANCEL:
        return _decode_cancel(reader)
    if kind == MessageType.ERROR:
        return _decode_error(reader)
    return None


def encode_message_datagram(
    message_type: MessageType,
    message: PayloadMessage,
    request_id: int,
    session_id: int,
    sender_id: bytes,
    flags: int = 0,
) -> bytes:
    return encode_datagram(message_type, encode_payload(message), request_id, session_id, sender_id, flags)


def missing_subranges(
    received: Iterable[tuple[int, int]],
    start: int,
    end: int,
) -> list[tuple[int, int]]:
    intervals: IntervalSet = IntervalSet()
    for left, right in received:
        intervals.add(left, right)
    return intervals.missing(start, end)


def _encode_hello_like(listen_port: int, name: str) -> bytes:
    parts: PacketAssembly = PacketAssembly()
    parts.add_u16(listen_port)
    parts.add_string(name)
    return parts.build()


def _decode_hello(reader: BufferReader) -> Hello:
    listen_port: int = reader.read_u16()
    name: str = reader.read_string()
    reader.require_end()
    return Hello(listen_port=listen_port, name=name)


def _decode_hello_ack(reader: BufferReader) -> HelloAck:
    listen_port: int = reader.read_u16()
    name: str = reader.read_string()
    reader.require_end()
    return HelloAck(listen_port=listen_port, name=name)


def _encode_find_files(message: FindFiles) -> bytes:
    parts: PacketAssembly = PacketAssembly()
    parts.add_u8(message.query_kind)
    parts.add_u16(message.max_results)
    parts.add_string(message.query)
    return parts.build()


def _decode_find_files(reader: BufferReader) -> FindFiles:
    message: FindFiles = FindFiles(
        query_kind=reader.read_u8(),
        max_results=reader.read_u16(),
        query=reader.read_string(),
    )
    reader.require_end()
    return message


def _encode_file_record(record: FileRecord) -> bytes:
    require_len(record.file_id, FILE_ID_LEN, "file_id")
    parts: PacketAssembly = PacketAssembly()
    parts.add(record.file_id)
    parts.add_u64(record.file_size)
    parts.add_u32(record.chunk_size)
    parts.add_string(record.name)
    parts.add_string(record.media_type)
    parts.add_u16(len(record.tags))
    for tag in record.tags:
        parts.add_string(tag)
    return parts.build()


def _decode_file_record(reader: BufferReader) -> FileRecord:
    file_id: bytes = reader.read(FILE_ID_LEN)
    file_size: int = reader.read_u64()
    chunk_size: int = reader.read_u32()
    name: str = reader.read_string()
    media_type: str = reader.read_string()
    tag_count: int = reader.read_u16()
    tags: list[str] = []
    for _ in range(tag_count):
        tags.append(reader.read_string())
    return FileRecord(
        file_id=file_id,
        file_size=file_size,
        chunk_size=chunk_size,
        name=name,
        media_type=media_type,
        tags=tuple(tags),
    )


def _encode_files(message: Files) -> bytes:
    parts: PacketAssembly = PacketAssembly()
    parts.add_u32(message.total_matches)
    parts.add_u16(len(message.records))
    for record in message.records:
        parts.add(_encode_file_record(record))
    return parts.build()


def _decode_files(reader: BufferReader) -> Files:
    total_matches: int = reader.read_u32()
    record_count: int = reader.read_u16()
    records: list[FileRecord] = []
    for _ in range(record_count):
        records.append(_decode_file_record(reader))
    reader.require_end()
    return Files(total_matches=total_matches, records=tuple(records))


def _encode_get_range(message: GetRange) -> bytes:
    require_len(message.file_id, FILE_ID_LEN, "file_id")
    parts: PacketAssembly = PacketAssembly()
    parts.add(message.file_id)
    parts.add_u64(message.from_offset)
    parts.add_u64(message.to_offset)
    parts.add_u16(message.max_datagram)
    return parts.build()


def _decode_get_range(reader: BufferReader) -> GetRange:
    message: GetRange = GetRange(
        file_id=reader.read(FILE_ID_LEN),
        from_offset=reader.read_u64(),
        to_offset=reader.read_u64(),
        max_datagram=reader.read_u16(),
    )
    reader.require_end()
    return message


def _encode_range_data(message: RangeData) -> bytes:
    require_len(message.file_id, FILE_ID_LEN, "file_id")
    if len(message.data) > 0xFFFF:
        raise ValueError("RANGE_DATA data is too large")
    parts: PacketAssembly = PacketAssembly()
    parts.add(message.file_id)
    parts.add_u64(message.requested_from)
    parts.add_u64(message.requested_to)
    parts.add_u64(message.data_offset)
    parts.add_u16(len(message.data))
    parts.add_u32(message.crc32)
    parts.add(message.data)
    return parts.build()


def _decode_range_data(reader: BufferReader) -> RangeData:
    file_id: bytes = reader.read(FILE_ID_LEN)
    requested_from: int = reader.read_u64()
    requested_to: int = reader.read_u64()
    data_offset: int = reader.read_u64()
    data_len: int = reader.read_u16()
    data_crc32: int = reader.read_u32()
    if reader.remaining != data_len:
        raise MalformedMessage("RANGE_DATA data_len does not match payload length")
    data: bytes = reader.read(data_len)
    reader.require_end()
    return RangeData(
        file_id=file_id,
        requested_from=requested_from,
        requested_to=requested_to,
        data_offset=data_offset,
        data=data,
        data_crc32=data_crc32,
    )


def _encode_range_done(message: RangeDone) -> bytes:
    require_len(message.file_id, FILE_ID_LEN, "file_id")
    parts: PacketAssembly = PacketAssembly()
    parts.add(message.file_id)
    parts.add_u64(message.requested_from)
    parts.add_u64(message.requested_to)
    parts.add_u64(message.sent_bytes)
    return parts.build()


def _decode_range_done(reader: BufferReader) -> RangeDone:
    message: RangeDone = RangeDone(
        file_id=reader.read(FILE_ID_LEN),
        requested_from=reader.read_u64(),
        requested_to=reader.read_u64(),
        sent_bytes=reader.read_u64(),
    )
    reader.require_end()
    return message


def _encode_cancel(message: Cancel) -> bytes:
    require_len(message.file_id, FILE_ID_LEN, "file_id")
    parts: PacketAssembly = PacketAssembly()
    parts.add_u64(message.cancelled_request_id)
    parts.add(message.file_id)
    return parts.build()


def _decode_cancel(reader: BufferReader) -> Cancel:
    message: Cancel = Cancel(
        cancelled_request_id=reader.read_u64(),
        file_id=reader.read(FILE_ID_LEN),
    )
    reader.require_end()
    return message


def _encode_error(message: ErrorMessage) -> bytes:
    parts: PacketAssembly = PacketAssembly()
    parts.add_u16(message.error_code)
    parts.add_string(message.detail)
    return parts.build()


def _decode_error(reader: BufferReader) -> ErrorMessage:
    message: ErrorMessage = ErrorMessage(error_code=reader.read_u16(), detail=reader.read_string())
    reader.require_end()
    return message
