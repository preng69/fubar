from __future__ import annotations

import hashlib
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from .files import SharedFile, find_shared_file, match_files
from .protocol import (
    DEFAULT_MAX_DATAGRAM,
    DEFAULT_PORT,
    FILE_ID_LEN,
    HEADER_LEN,
    Cancel,
    ErrorCode,
    ErrorMessage,
    Files,
    FileRecord,
    FindFiles,
    GetRange,
    Header,
    Hello,
    HelloAck,
    IntervalSet,
    MalformedMessage,
    MessageType,
    Packet,
    PayloadMessage,
    QueryKind,
    RangeData,
    RangeDone,
    crc32,
    decode_datagram,
    decode_payload,
    encode_payload,
    encode_message_datagram,
    message_type_name,
    random_peer_id,
    random_u64,
)


Address = tuple[str, int]
Logger = Callable[[str], None]

RANGE_DATA_FIXED_PAYLOAD_LEN: int = FILE_ID_LEN + 8 + 8 + 8 + 2 + 4
DEFAULT_MAX_RANGE_BYTES: int = 256 * 1024


class RangeRequestError(Exception):
    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code: ErrorCode = code
        self.detail: str = detail


@dataclass(frozen=True)
class DiscoveredFile:
    address: Address
    session_id: int
    record: FileRecord


@dataclass(frozen=True)
class DiscoveredPeer:
    address: Address
    session_id: int
    listen_port: int
    name: str


def datagram_payload_capacity(max_datagram: int) -> int:
    effective_max: int = max_datagram or DEFAULT_MAX_DATAGRAM
    return effective_max - HEADER_LEN - RANGE_DATA_FIXED_PAYLOAD_LEN


def validate_range_request(
    shared_file: SharedFile,
    request: GetRange,
    max_range_bytes: int = DEFAULT_MAX_RANGE_BYTES,
) -> None:
    if request.file_id != shared_file.file_id:
        raise RangeRequestError(ErrorCode.FILE_NOT_FOUND, "file not found")
    if request.from_offset >= request.to_offset:
        raise RangeRequestError(ErrorCode.INVALID_RANGE, "from_offset must be less than to_offset")
    if request.to_offset > shared_file.file_size:
        raise RangeRequestError(ErrorCode.INVALID_RANGE, "to_offset exceeds file size")
    if request.to_offset - request.from_offset > max_range_bytes:
        raise RangeRequestError(ErrorCode.RANGE_TOO_LARGE, "requested range is too large")
    if datagram_payload_capacity(request.max_datagram) <= 0:
        raise RangeRequestError(ErrorCode.RANGE_TOO_LARGE, "max_datagram is too small for RANGE_DATA")


def iter_range_data(
    shared_file: SharedFile,
    request: GetRange,
    max_range_bytes: int = DEFAULT_MAX_RANGE_BYTES,
) -> Iterable[RangeData]:
    validate_range_request(shared_file, request, max_range_bytes=max_range_bytes)
    capacity: int = datagram_payload_capacity(request.max_datagram)
    with shared_file.path.open("rb") as file:
        file.seek(request.from_offset)
        offset: int = request.from_offset
        remaining: int = request.to_offset - request.from_offset
        while remaining > 0:
            chunk_size: int = min(capacity, remaining)
            data: bytes = file.read(chunk_size)
            if not data:
                raise RangeRequestError(ErrorCode.TEMPORARILY_UNAVAILABLE, "could not read requested bytes")
            yield RangeData(
                file_id=request.file_id,
                requested_from=request.from_offset,
                requested_to=request.to_offset,
                data_offset=offset,
                data=data,
            )
            offset += len(data)
            remaining -= len(data)


def fit_files_response(
    total_matches: int,
    records: Iterable[FileRecord],
    max_datagram: int = DEFAULT_MAX_DATAGRAM,
) -> Files:
    selected: list[FileRecord] = []
    payload_limit: int = max_datagram - HEADER_LEN
    for record in records:
        candidate: Files = Files(total_matches=total_matches, records=tuple(selected + [record]))
        if len(encode_payload(candidate)) > payload_limit:
            break
        selected.append(record)
    return Files(total_matches=total_matches, records=tuple(selected))


class DTFPeer:
    def __init__(
        self,
        listen_port: int = DEFAULT_PORT,
        name: str = "",
        shared_files: Iterable[SharedFile] = (),
        peer_id: bytes | None = None,
        logger: Logger | None = None,
        max_range_bytes: int = DEFAULT_MAX_RANGE_BYTES,
    ) -> None:
        self.listen_port: int = listen_port
        self.name: str = name
        self.shared_files: list[SharedFile] = list(shared_files)
        self.peer_id: bytes = peer_id or random_peer_id()
        self.sessions: dict[int, Address] = {}
        self.cancelled_requests: set[int] = set()
        self.logger: Logger = logger or print
        self.max_range_bytes: int = max_range_bytes
        self._shared_files_lock: threading.RLock = threading.RLock()

    def set_shared_files(self, shared_files: Iterable[SharedFile]) -> None:
        with self._shared_files_lock:
            self.shared_files = list(shared_files)

    def get_shared_files(self) -> list[SharedFile]:
        with self._shared_files_lock:
            return list(self.shared_files)

    def serve(self, host: str = "0.0.0.0") -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, self.listen_port))
            self.logger(f"DTF peer listening on {host}:{self.listen_port}")
            while True:
                datagram, address = sock.recvfrom(65535)
                self.handle_datagram(sock, datagram, _address(address))

    def find(
        self,
        peer: Address,
        query_kind: int,
        query: str,
        max_results: int = 25,
        timeout: float = 0.5,
        attempts: int = 2,
    ) -> list[Files]:
        request: FindFiles = FindFiles(query_kind=query_kind, max_results=max_results, query=query)
        responses: list[Files] = []
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(("", 0))
            for _ in range(attempts):
                request_id: int = random_u64()
                self._send(sock, peer, MessageType.FIND_FILES, request, request_id=request_id, session_id=0)
                deadline: float = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    packet_message: tuple[Packet, PayloadMessage, Address] | None = self._recv_payload(sock, deadline)
                    if packet_message is None:
                        break
                    packet, message, _ = packet_message
                    if (
                        packet.header.request_id == request_id
                        and packet.header.message_type == MessageType.FILES
                        and isinstance(message, Files)
                    ):
                        responses.append(message)
                if responses:
                    break
        return responses

    def discover_peers(
        self,
        targets: Iterable[Address],
        timeout: float = 0.5,
        attempts: int = 2,
    ) -> list[DiscoveredPeer]:
        request: Hello = Hello(listen_port=self.listen_port, name=self.name)
        discovered: dict[Address, DiscoveredPeer] = {}
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.bind(("", 0))
            for _ in range(attempts):
                request_id: int = random_u64()
                for target in targets:
                    self._send(sock, target, MessageType.HELLO, request, request_id=request_id, session_id=0)
                deadline: float = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    packet_message: tuple[Packet, PayloadMessage, Address] | None = self._recv_payload(sock, deadline)
                    if packet_message is None:
                        break
                    packet, message, address = packet_message
                    if packet.header.sender_id == self.peer_id:
                        continue
                    remember_discovered_peer(discovered, packet, message, address, request_id=request_id)
        return sorted(discovered.values(), key=lambda peer: (peer.address[0], peer.address[1], peer.name))

    def hello(
        self,
        peer: Address,
        timeout: float = 0.5,
        attempts: int = 3,
    ) -> int:
        request: Hello = Hello(listen_port=self.listen_port, name=self.name)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(("", 0))
            for _ in range(attempts):
                request_id: int = random_u64()
                self._send(sock, peer, MessageType.HELLO, request, request_id=request_id, session_id=0)
                deadline: float = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    packet_message: tuple[Packet, PayloadMessage, Address] | None = self._recv_payload(sock, deadline)
                    if packet_message is None:
                        break
                    packet, message, address = packet_message
                    if (
                        address == peer
                        and packet.header.request_id == request_id
                        and packet.header.message_type == MessageType.HELLO_ACK
                        and isinstance(message, HelloAck)
                    ):
                        self.sessions[packet.header.session_id] = peer
                        return packet.header.session_id
        raise TimeoutError(f"no HELLO_ACK from {peer[0]}:{peer[1]}")

    def download(
        self,
        peer: Address,
        record_file_id: bytes,
        file_size: int,
        output_path: Path,
        range_size: int = 64 * 1024,
        max_datagram: int = DEFAULT_MAX_DATAGRAM,
        timeout: float = 1.0,
        attempts_per_range: int = 4,
    ) -> None:
        session_id: int = self.hello(peer)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind(("", 0))
            with output_path.open("wb") as output:
                output.truncate(file_size)
                for range_start in range(0, file_size, range_size):
                    range_end: int = min(range_start + range_size, file_size)
                    data: bytes = self._download_range(
                        sock=sock,
                        peer=peer,
                        session_id=session_id,
                        file_id=record_file_id,
                        start=range_start,
                        end=range_end,
                        max_datagram=max_datagram,
                        timeout=timeout,
                        attempts=attempts_per_range,
                    )
                    output.seek(range_start)
                    output.write(data)
        digest: bytes = _sha256_path(output_path)
        if digest != record_file_id:
            raise ValueError("downloaded file SHA-256 does not match file ID")

    def handle_datagram(self, sock: socket.socket, datagram: bytes, address: Address) -> None:
        packet: Packet | None = decode_datagram(datagram)
        if packet is None:
            self.logger(f"RX INVALID {address[0]}:{address[1]}")
            return
        self._log("RX", packet.header, address)
        message: PayloadMessage | None
        try:
            message = decode_payload(packet.header.message_type, packet.payload)
        except MalformedMessage as exc:
            self._send_error(
                sock,
                address,
                request_id=packet.header.request_id,
                session_id=packet.header.session_id,
                code=ErrorCode.MALFORMED_MESSAGE,
                detail=str(exc),
            )
            return
        if message is None:
            return
        if isinstance(message, Hello):
            self._handle_hello(sock, packet, message, address)
        elif isinstance(message, FindFiles):
            self._handle_find_files(sock, packet, message, address)
        elif isinstance(message, GetRange):
            self._handle_get_range(sock, packet, message, address)
        elif isinstance(message, Cancel):
            self.cancelled_requests.add(message.cancelled_request_id)

    def _handle_hello(self, sock: socket.socket, packet: Packet, _message: Hello, address: Address) -> None:
        session_id: int = random_u64()
        self.sessions[session_id] = address
        response: HelloAck = HelloAck(listen_port=self.listen_port, name=self.name)
        self._send(
            sock,
            address,
            MessageType.HELLO_ACK,
            response,
            request_id=packet.header.request_id,
            session_id=session_id,
        )

    def _handle_find_files(self, sock: socket.socket, packet: Packet, message: FindFiles, address: Address) -> None:
        try:
            QueryKind(message.query_kind)
        except ValueError:
            self._send_error(
                sock,
                address,
                request_id=packet.header.request_id,
                session_id=packet.header.session_id,
                code=ErrorCode.UNSUPPORTED_QUERY,
                detail="unsupported query kind",
            )
            return
        total, records = match_files(
            self.get_shared_files(),
            query_kind=message.query_kind,
            query=message.query,
            max_results=message.max_results,
        )
        response: Files = fit_files_response(total_matches=total, records=records)
        self._send(
            sock,
            address,
            MessageType.FILES,
            response,
            request_id=packet.header.request_id,
            session_id=packet.header.session_id,
        )

    def _handle_get_range(self, sock: socket.socket, packet: Packet, message: GetRange, address: Address) -> None:
        if packet.header.session_id == 0 or packet.header.session_id not in self.sessions:
            self._send_error(
                sock,
                address,
                request_id=packet.header.request_id,
                session_id=packet.header.session_id,
                code=ErrorCode.UNKNOWN_SESSION,
                detail="unknown session",
            )
            return
        shared_file: SharedFile | None = find_shared_file(self.get_shared_files(), message.file_id)
        if shared_file is None:
            self._send_error(
                sock,
                address,
                request_id=packet.header.request_id,
                session_id=packet.header.session_id,
                code=ErrorCode.FILE_NOT_FOUND,
                detail="file not found",
            )
            return
        sent_bytes: int = 0
        try:
            for response in iter_range_data(shared_file, message, max_range_bytes=self.max_range_bytes):
                if packet.header.request_id in self.cancelled_requests:
                    break
                self._send(
                    sock,
                    address,
                    MessageType.RANGE_DATA,
                    response,
                    request_id=packet.header.request_id,
                    session_id=packet.header.session_id,
                )
                sent_bytes += len(response.data)
        except RangeRequestError as exc:
            self._send_error(
                sock,
                address,
                request_id=packet.header.request_id,
                session_id=packet.header.session_id,
                code=exc.code,
                detail=exc.detail,
            )
            return
        done: RangeDone = RangeDone(
            file_id=message.file_id,
            requested_from=message.from_offset,
            requested_to=message.to_offset,
            sent_bytes=sent_bytes,
        )
        self._send(
            sock,
            address,
            MessageType.RANGE_DONE,
            done,
            request_id=packet.header.request_id,
            session_id=packet.header.session_id,
        )

    def _download_range(
        self,
        sock: socket.socket,
        peer: Address,
        session_id: int,
        file_id: bytes,
        start: int,
        end: int,
        max_datagram: int,
        timeout: float,
        attempts: int,
    ) -> bytes:
        buffer: bytearray = bytearray(end - start)
        received: IntervalSet = IntervalSet()
        for _ in range(attempts):
            missing: list[tuple[int, int]] = received.missing(start, end)
            if not missing:
                return bytes(buffer)
            for missing_start, missing_end in missing:
                request_id: int = random_u64()
                request: GetRange = GetRange(
                    file_id=file_id,
                    from_offset=missing_start,
                    to_offset=missing_end,
                    max_datagram=max_datagram,
                )
                self._send(sock, peer, MessageType.GET_RANGE, request, request_id=request_id, session_id=session_id)
                deadline: float = time.monotonic() + timeout
                while time.monotonic() < deadline and not received.covers(missing_start, missing_end):
                    packet_message: tuple[Packet, PayloadMessage, Address] | None = self._recv_payload(sock, deadline)
                    if packet_message is None:
                        break
                    packet, message, address = packet_message
                    if address != peer or packet.header.request_id != request_id:
                        continue
                    if isinstance(message, ErrorMessage):
                        raise RuntimeError(f"DTF error {message.error_code}: {message.detail}")
                    if isinstance(message, RangeData):
                        self._accept_range_data(message, file_id, start, end, buffer, received)
                    if isinstance(message, RangeDone) and received.covers(missing_start, missing_end):
                        break
        missing_after_retries: list[tuple[int, int]] = received.missing(start, end)
        raise TimeoutError(f"incomplete range {start}:{end}; missing {missing_after_retries}")

    def _accept_range_data(
        self,
        message: RangeData,
        file_id: bytes,
        start: int,
        end: int,
        buffer: bytearray,
        received: IntervalSet,
    ) -> None:
        data_end: int = message.data_offset + len(message.data)
        if message.file_id != file_id:
            return
        if message.data_crc32 != crc32(message.data):
            return
        if message.data_offset < start or data_end > end:
            return
        buffer_start: int = message.data_offset - start
        buffer[buffer_start : buffer_start + len(message.data)] = message.data
        received.add(message.data_offset, data_end)

    def _recv_payload(
        self,
        sock: socket.socket,
        deadline: float,
    ) -> tuple[Packet, PayloadMessage, Address] | None:
        timeout: float = max(0.0, deadline - time.monotonic())
        sock.settimeout(timeout)
        try:
            datagram, raw_address = sock.recvfrom(65535)
        except TimeoutError:
            return None
        address: Address = _address(raw_address)
        packet: Packet | None = decode_datagram(datagram)
        if packet is None:
            self.logger(f"RX INVALID {address[0]}:{address[1]}")
            return None
        self._log("RX", packet.header, address)
        try:
            message: PayloadMessage | None = decode_payload(packet.header.message_type, packet.payload)
        except MalformedMessage:
            return None
        if message is None:
            return None
        return packet, message, address

    def _send(
        self,
        sock: socket.socket,
        address: Address,
        message_type: MessageType,
        message: PayloadMessage,
        request_id: int,
        session_id: int,
    ) -> None:
        datagram: bytes = encode_message_datagram(
            message_type=message_type,
            message=message,
            request_id=request_id,
            session_id=session_id,
            sender_id=self.peer_id,
        )
        sock.sendto(datagram, address)
        header: Header = Header(
            message_type=message_type,
            flags=0,
            payload_len=len(datagram) - HEADER_LEN,
            request_id=request_id,
            session_id=session_id,
            sender_id=self.peer_id,
        )
        self._log("TX", header, address)

    def _send_error(
        self,
        sock: socket.socket,
        address: Address,
        request_id: int,
        session_id: int,
        code: ErrorCode,
        detail: str,
    ) -> None:
        self._send(
            sock,
            address,
            MessageType.ERROR,
            ErrorMessage(error_code=code, detail=detail),
            request_id=request_id,
            session_id=session_id,
        )

    def _log(self, direction: str, header: Header, address: Address) -> None:
        self.logger(
            f"{direction} {message_type_name(header.message_type)} "
            f"{address[0]}:{address[1]} "
            f"request_id={header.request_id} session_id={header.session_id}"
        )


class BackgroundPeerServer:
    def __init__(self, peer: DTFPeer, host: str = "0.0.0.0") -> None:
        self.peer: DTFPeer = peer
        self.host: str = host
        self._stop: threading.Event = threading.Event()
        self._thread: threading.Thread | None = None
        self._socket: socket.socket | None = None

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.is_running:
            return
        self._stop.clear()
        sock: socket.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.peer.listen_port))
        sock.settimeout(0.2)
        self._socket = sock
        self._thread = threading.Thread(target=self._run, name="dtf-peer-server", daemon=True)
        self._thread.start()
        self.peer.logger(f"DTF peer listening on {self.host}:{self.peer.listen_port}")

    def stop(self) -> None:
        self._stop.set()
        sock: socket.socket | None = self._socket
        if sock is not None:
            sock.close()
        thread: threading.Thread | None = self._thread
        if thread is not None:
            thread.join(timeout=1.0)
        self._socket = None
        self._thread = None

    def _run(self) -> None:
        sock: socket.socket | None = self._socket
        if sock is None:
            return
        while not self._stop.is_set():
            try:
                datagram, address = sock.recvfrom(65535)
            except TimeoutError:
                continue
            except OSError:
                break
            self.peer.handle_datagram(sock, datagram, _address(address))


def _address(value: tuple[str, int] | tuple[str, int, int, int]) -> Address:
    return value[0], value[1]


def parse_peer(value: str, default_port: int = DEFAULT_PORT) -> Address:
    if ":" not in value:
        return value, default_port
    host, raw_port = value.rsplit(":", 1)
    return host, int(raw_port)


def remember_discovered_peer(
    discovered: dict[Address, DiscoveredPeer],
    packet: Packet,
    message: PayloadMessage,
    address: Address,
    request_id: int,
) -> None:
    if packet.header.request_id != request_id:
        return
    if packet.header.message_type != MessageType.HELLO_ACK:
        return
    if not isinstance(message, HelloAck):
        return
    peer_address: Address = (address[0], message.listen_port or address[1])
    discovered[peer_address] = DiscoveredPeer(
        address=peer_address,
        session_id=packet.header.session_id,
        listen_port=message.listen_port,
        name=message.name,
    )


def _sha256_path(path: Path) -> bytes:
    digest: hashlib._Hash = hashlib.sha256()
    with path.open("rb") as file:
        while True:
            chunk: bytes = file.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.digest()
