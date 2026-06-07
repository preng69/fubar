from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

from .files import DEFAULT_CHUNK_SIZE, file_id_from_hex, index_paths
from .names import random_peer_name
from .peer import DEFAULT_MAX_RANGE_BYTES, DTFPeer, default_broadcast_target, parse_peer
from .protocol import DEFAULT_MAX_DATAGRAM, DEFAULT_PORT, Files, QueryKind


QUERY_KIND_NAMES: dict[str, QueryKind] = {
    "all": QueryKind.LIST_ALL,
    "substring": QueryKind.SUBSTRING,
    "id": QueryKind.EXACT_FILE_ID,
    "tag": QueryKind.TAG,
}


def build_parser() -> argparse.ArgumentParser:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(prog="dtf", description="DTF protocol peer")
    parser.add_argument("--name", default="", help="human-readable peer name")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="local DTF listen port")

    subparsers = parser.add_subparsers(dest="command", required=True)

    serve: argparse.ArgumentParser = subparsers.add_parser("serve", help="serve files over DTF")
    serve.add_argument("paths", nargs="+", type=Path, help="files or directories to share")
    serve.add_argument("--host", default="0.0.0.0", help="host/interface to bind")
    serve.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, help="preferred advertised chunk size")
    serve.add_argument("--tag", action="append", default=[], help="metadata tag to attach to shared files")
    serve.add_argument(
        "--max-range-bytes",
        type=int,
        default=DEFAULT_MAX_RANGE_BYTES,
        help="largest GET_RANGE request to serve",
    )

    peers: argparse.ArgumentParser = subparsers.add_parser("peers", help="find DTF peers on the local network")
    peers.add_argument(
        "targets",
        nargs="*",
        default=[],
        help="broadcast target host or host:port; defaults to local IPv4 with .255 last octet",
    )
    peers.add_argument("--timeout", type=float, default=0.5, help="seconds to wait per attempt")
    peers.add_argument("--attempts", type=int, default=2, help="number of broadcast HELLO attempts")

    find: argparse.ArgumentParser = subparsers.add_parser("find", help="find files from a known peer")
    find.add_argument("peer", help="peer host or host:port")
    find.add_argument("--kind", choices=sorted(QUERY_KIND_NAMES), default="all", help="query kind")
    find.add_argument("--query", default="", help="query text")
    find.add_argument("--max-results", type=int, default=25, help="maximum records requested")
    find.add_argument("--timeout", type=float, default=0.5, help="seconds to wait per attempt")
    find.add_argument("--attempts", type=int, default=2, help="number of FIND_FILES attempts")

    download: argparse.ArgumentParser = subparsers.add_parser("download", help="download a file by file ID")
    download.add_argument("peer", help="peer host or host:port")
    download.add_argument("file_id", help="64-character lowercase hexadecimal file ID")
    download.add_argument("output", type=Path, help="target file path")
    download.add_argument("--range-size", type=int, default=64 * 1024, help="requested byte range size")
    download.add_argument("--max-datagram", type=int, default=DEFAULT_MAX_DATAGRAM, help="requested max datagram size")
    download.add_argument("--timeout", type=float, default=1.0, help="seconds to wait for range data")
    download.add_argument("--attempts-per-range", type=int, default=4, help="retry attempts for each range")

    tui: argparse.ArgumentParser = subparsers.add_parser("tui", help="run a combined server/client TUI")
    tui.add_argument("served_folder", type=Path, help="local folder to serve")
    tui.add_argument(
        "--broadcast-target",
        action="append",
        default=[],
        help="broadcast target host or host:port; defaults to local IPv4 with .255 last octet",
    )

    web: argparse.ArgumentParser = subparsers.add_parser("web", help="run the Textual frontend on localhost")
    web.add_argument("served_folder", type=Path, help="local folder to serve")
    web.add_argument("--host", default="127.0.0.1", help="web host to bind")
    web.add_argument("--web-port", type=int, default=8080, help="web port to bind")
    web.add_argument(
        "--broadcast-target",
        action="append",
        default=[],
        help="broadcast target host or host:port; defaults to local IPv4 with .255 last octet",
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser: argparse.ArgumentParser = build_parser()
    args: argparse.Namespace = parser.parse_args(argv)
    peer_name: str = args.name or random_peer_name()

    if args.command == "serve":
        shared_files = index_paths(args.paths, chunk_size=args.chunk_size, tags=args.tag)
        peer: DTFPeer = DTFPeer(
            listen_port=args.port,
            name=peer_name,
            shared_files=shared_files,
            max_range_bytes=args.max_range_bytes,
        )
        print(f"Peer name: {peer_name}")
        print(f"Sharing {len(shared_files)} file(s)")
        for shared_file in shared_files:
            print(f"{shared_file.file_id.hex()} {shared_file.file_size} {shared_file.name}")
        peer.serve(host=args.host)
        return 0

    if args.command == "peers":
        targets = [parse_peer(target, default_port=args.port) for target in args.targets]
        if not targets:
            targets = [default_broadcast_target(args.port)]
        peer = DTFPeer(listen_port=args.port, name=peer_name)
        discovered_peers = peer.discover_peers(targets, timeout=args.timeout, attempts=args.attempts)
        for discovered_peer in discovered_peers:
            print(
                f"{discovered_peer.address[0]}:{discovered_peer.address[1]} "
                f"session_id={discovered_peer.session_id} "
                f"listen_port={discovered_peer.listen_port} "
                f"name={discovered_peer.name}"
            )
        return 0

    if args.command == "find":
        peer_address = parse_peer(args.peer)
        peer = DTFPeer(listen_port=args.port, name=peer_name)
        responses: list[Files] = peer.find(
            peer_address,
            query_kind=QUERY_KIND_NAMES[args.kind],
            query=args.query,
            max_results=args.max_results,
            timeout=args.timeout,
            attempts=args.attempts,
        )
        for response in responses:
            print(f"total_matches={response.total_matches} record_count={len(response.records)}")
            for record in response.records:
                tags: str = ",".join(record.tags)
                print(
                    f"{record.file_id.hex()} {record.file_size} {record.chunk_size} "
                    f"{record.media_type} {record.name} tags={tags}"
                )
        return 0

    if args.command == "download":
        peer_address = parse_peer(args.peer)
        file_id: bytes = file_id_from_hex(args.file_id)
        peer = DTFPeer(listen_port=args.port, name=peer_name)
        responses = peer.find(
            peer_address,
            query_kind=QueryKind.EXACT_FILE_ID,
            query=args.file_id,
            max_results=1,
        )
        matching_records = [record for response in responses for record in response.records if record.file_id == file_id]
        if not matching_records:
            print("file not found", file=sys.stderr)
            return 1
        record = matching_records[0]
        peer.download(
            peer=peer_address,
            record_file_id=file_id,
            file_size=record.file_size,
            output_path=args.output,
            range_size=args.range_size,
            max_datagram=args.max_datagram,
            timeout=args.timeout,
            attempts_per_range=args.attempts_per_range,
        )
        print(f"downloaded {record.name} to {args.output}")
        return 0

    if args.command == "tui":
        from .tui import run_tui

        targets = [parse_peer(target, default_port=args.port) for target in args.broadcast_target]
        if not targets:
            targets = [default_broadcast_target(args.port)]
        run_tui(
            served_folder=args.served_folder,
            name=peer_name,
            port=args.port,
            broadcast_targets=targets,
        )
        return 0

    if args.command == "web":
        from .web import run_web

        targets = [parse_peer(target, default_port=args.port) for target in args.broadcast_target]
        if not targets:
            targets = [default_broadcast_target(args.port)]
        run_web(
            served_folder=args.served_folder,
            name=peer_name,
            dtf_port=args.port,
            broadcast_targets=targets,
            host=args.host,
            web_port=args.web_port,
        )
        return 0

    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
