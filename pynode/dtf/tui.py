from __future__ import annotations

import queue
import threading
from pathlib import Path
from typing import Iterable

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Footer, Header, RichLog, Static

from .files import DEFAULT_CHUNK_SIZE, index_paths
from .peer import Address, BackgroundPeerServer, DTFPeer, DiscoveredPeer
from .protocol import DEFAULT_PORT, FileRecord, Files, QueryKind
from .tui_helpers import (
    app_header_title,
    copy_into_served_folder,
    download_path_for,
    file_label,
    peer_label,
    refresh_shared_files,
    selected_index,
)


class DtfTuiApp(App[None]):
    CSS = """
    Screen {
        layout: vertical;
    }

    #main {
        height: 3fr;
    }

    #peers-pane, #files-pane {
        width: 1fr;
        height: 100%;
    }

    #status {
        height: 1;
        padding: 0 1;
    }

    #log {
        height: 10;
        border: solid $primary;
    }
    """

    BINDINGS = [
        ("p", "refresh_peers", "Find peers"),
        ("f", "list_files", "List files"),
        ("d", "download_file", "Download"),
        ("r", "refresh_served", "Refresh served"),
        ("q", "quit", "Quit"),
    ]

    def __init__(
        self,
        served_folder: Path,
        name: str = "",
        port: int = DEFAULT_PORT,
        broadcast_targets: Iterable[Address] = (("255.255.255.255", DEFAULT_PORT),),
        chunk_size: int = DEFAULT_CHUNK_SIZE,
    ) -> None:
        super().__init__()
        self.served_folder: Path = served_folder.resolve()
        self.served_folder.mkdir(parents=True, exist_ok=True)
        self.peer_name: str = name
        self.title = app_header_title(self.peer_name)
        self.port: int = port
        self.broadcast_targets: list[Address] = list(broadcast_targets)
        self.chunk_size: int = chunk_size
        self.log_queue: queue.Queue[str] = queue.Queue()
        self.peer: DTFPeer = DTFPeer(
            listen_port=port,
            name=self.peer_name,
            shared_files=index_paths([self.served_folder], chunk_size=chunk_size),
            logger=self.log_queue.put,
        )
        self.server: BackgroundPeerServer = BackgroundPeerServer(self.peer)
        self.peers: list[DiscoveredPeer] = []
        self.files: list[FileRecord] = []
        self.selected_peer_key: str | None = None
        self.selected_file_key: str | None = None

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="main"):
            with Vertical(id="peers-pane"):
                yield Static("Peers")
                yield DataTable(id="peers")
            with Vertical(id="files-pane"):
                yield Static("Files")
                yield DataTable(id="files")
        yield Static("Starting...", id="status")
        yield RichLog(id="log", wrap=True)
        yield Footer()

    def on_mount(self) -> None:
        peers: DataTable = self.query_one("#peers", DataTable)
        peers.add_columns("Address", "Name", "Session")
        files: DataTable = self.query_one("#files", DataTable)
        files.add_columns("Name", "Size", "Type", "ID")
        self.set_interval(0.25, self._drain_logs)
        self.server.start()
        self._set_status(f"Serving {len(self.peer.get_shared_files())} file(s) from {self.served_folder}")

    def on_unmount(self) -> None:
        self.server.stop()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        self._mark_row_selected(event.data_table, event.row_key)

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        self._mark_row_selected(event.data_table, event.row_key)

    def _mark_row_selected(self, data_table: DataTable, row_key: object) -> None:
        key: str = _row_key_to_string(row_key)
        if data_table.id == "peers":
            self.selected_peer_key = key
            self.selected_file_key = None
            peer_index: int | None = selected_index(key, data_table.cursor_row, len(self.peers))
            if peer_index is not None:
                self._set_status(f"Selected peer {peer_label(self.peers[peer_index])}")
        elif data_table.id == "files":
            self.selected_file_key = key
            file_index: int | None = selected_index(key, data_table.cursor_row, len(self.files))
            if file_index is not None:
                self._set_status(f"Selected file {file_label(self.files[file_index])}")

    def action_refresh_peers(self) -> None:
        self._set_status("Finding peers via broadcast...")
        self._run_thread("refresh-peers", self._refresh_peers_worker)

    def action_list_files(self) -> None:
        selected: DiscoveredPeer | None = self._selected_peer()
        if selected is None:
            self._set_status("Select a peer first")
            return
        self._set_status(f"Listing files from {peer_label(selected)}...")
        self._run_thread("list-files", lambda: self._list_files_worker(selected))

    def action_download_file(self) -> None:
        selected_peer: DiscoveredPeer | None = self._selected_peer()
        selected_file: FileRecord | None = self._selected_file()
        if selected_peer is None:
            self._set_status("Select a peer first")
            return
        if selected_file is None:
            self._set_status("Select a file first")
            return
        self._set_status(f"Downloading {selected_file.name}...")
        self._run_thread("download-file", lambda: self._download_file_worker(selected_peer, selected_file))

    def action_refresh_served(self) -> None:
        count: int = refresh_shared_files(self.peer, self.served_folder, chunk_size=self.chunk_size)
        self._set_status(f"Serving {count} file(s) from {self.served_folder}")

    def _refresh_peers_worker(self) -> None:
        try:
            peers: list[DiscoveredPeer] = self.peer.discover_peers(self.broadcast_targets, timeout=0.7, attempts=2)
        except Exception as exc:
            self.call_from_thread(self._set_status, f"Peer discovery failed: {exc}")
            return
        self.call_from_thread(self._set_peers, peers)

    def _list_files_worker(self, selected: DiscoveredPeer) -> None:
        try:
            responses: list[Files] = self.peer.find(
                selected.address,
                query_kind=QueryKind.LIST_ALL,
                query="",
                max_results=100,
                timeout=0.7,
                attempts=2,
            )
            records: list[FileRecord] = [record for response in responses for record in response.records]
        except Exception as exc:
            self.call_from_thread(self._set_status, f"File listing failed: {exc}")
            return
        self.call_from_thread(self._set_files, records)

    def _download_file_worker(self, selected_peer: DiscoveredPeer, selected_file: FileRecord) -> None:
        try:
            downloaded_path: Path = download_path_for(selected_file)
            self.peer.download(
                peer=selected_peer.address,
                record_file_id=selected_file.file_id,
                file_size=selected_file.file_size,
                output_path=downloaded_path,
            )
            served_copy: Path = copy_into_served_folder(downloaded_path, self.served_folder, selected_file)
            count: int = refresh_shared_files(self.peer, self.served_folder, chunk_size=self.chunk_size)
        except Exception as exc:
            self.call_from_thread(self._set_status, f"Download failed: {exc}")
            return
        self.call_from_thread(
            self._set_status,
            f"Downloaded to {downloaded_path}; copied to {served_copy}; serving {count} file(s)",
        )

    def _set_peers(self, peers: list[DiscoveredPeer]) -> None:
        self.peers = peers
        self.selected_peer_key = None
        self.selected_file_key = None
        table: DataTable = self.query_one("#peers", DataTable)
        table.clear()
        for index, peer in enumerate(peers):
            table.add_row(
                f"{peer.address[0]}:{peer.address[1]}",
                peer.name or "(unnamed)",
                str(peer.session_id),
                key=str(index),
            )
        self._set_files([])
        self._set_status(f"Found {len(peers)} peer(s)")

    def _set_files(self, files: list[FileRecord]) -> None:
        self.files = files
        self.selected_file_key = None
        table: DataTable = self.query_one("#files", DataTable)
        table.clear()
        for index, record in enumerate(files):
            table.add_row(
                record.name,
                str(record.file_size),
                record.media_type,
                record.file_id.hex()[:16],
                key=str(index),
            )
        self._set_status(f"Listed {len(files)} file(s)")

    def _selected_peer(self) -> DiscoveredPeer | None:
        table: DataTable = self.query_one("#peers", DataTable)
        index: int | None = selected_index(self.selected_peer_key, table.cursor_row, len(self.peers))
        if index is None:
            return None
        return self.peers[index]

    def _selected_file(self) -> FileRecord | None:
        table: DataTable = self.query_one("#files", DataTable)
        index: int | None = selected_index(self.selected_file_key, table.cursor_row, len(self.files))
        if index is None:
            return None
        return self.files[index]

    def _set_status(self, message: str) -> None:
        self.query_one("#status", Static).update(message)

    def _drain_logs(self) -> None:
        log: RichLog = self.query_one("#log", RichLog)
        while True:
            try:
                line: str = self.log_queue.get_nowait()
            except queue.Empty:
                break
            log.write(line)

    def _run_thread(self, name: str, target: object) -> None:
        if not callable(target):
            raise TypeError("target must be callable")
        thread: threading.Thread = threading.Thread(target=target, name=f"dtf-tui-{name}", daemon=True)
        thread.start()


def run_tui(
    served_folder: Path,
    name: str = "",
    port: int = DEFAULT_PORT,
    broadcast_targets: Iterable[Address] = (("255.255.255.255", DEFAULT_PORT),),
) -> None:
    app: DtfTuiApp = DtfTuiApp(
        served_folder=served_folder,
        name=name,
        port=port,
        broadcast_targets=broadcast_targets,
    )
    app.run()


def _row_key_to_string(row_key: object) -> str:
    value: object = getattr(row_key, "value", row_key)
    return str(value)
