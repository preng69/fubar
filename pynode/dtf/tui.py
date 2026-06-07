from __future__ import annotations

import queue
import threading
from pathlib import Path
from typing import Callable, Iterable

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.events import Key
from textual.widgets import DataTable, Footer, Header, RichLog, Static

from .catalog import (
    CatalogFile,
    available_from_label,
    build_catalog,
    filter_catalog_by_name,
    records_by_peer_to_peer_files,
)
from .files import DEFAULT_CHUNK_SIZE, index_paths
from .peer import Address, BackgroundPeerServer, DTFPeer, DiscoveredPeer, default_broadcast_target
from .protocol import DEFAULT_PORT, FileRecord, Files, QueryKind
from .swarm import download_swarm
from .tui_helpers import (
    app_header_title,
    copy_into_served_folder,
    download_path_for,
    file_list_title,
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

    #catalog-pane {
        width: 100%;
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
        ("p", "refresh_catalog", "Find files"),
        ("d", "download_file", "Download"),
        ("r", "refresh_served", "Refresh served"),
        ("q", "quit", "Quit"),
    ]

    def __init__(
        self,
        served_folder: Path,
        name: str = "",
        port: int = DEFAULT_PORT,
        broadcast_targets: Iterable[Address] | None = None,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
    ) -> None:
        super().__init__()
        self.served_folder: Path = served_folder.resolve()
        self.served_folder.mkdir(parents=True, exist_ok=True)
        self.peer_name: str = name
        self.title = app_header_title(self.peer_name)
        self.port: int = port
        self.broadcast_targets: list[Address] = list(broadcast_targets or [default_broadcast_target(port)])
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
        self.catalog: list[CatalogFile] = []
        self.visible_catalog: list[CatalogFile] = []
        self.selected_catalog_key: str | None = None
        self.filter_active: bool = False
        self.filter_text: str = ""

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="main"):
            with Vertical(id="catalog-pane"):
                yield Static("Files", id="catalog-title")
                yield DataTable(id="catalog", cursor_type="row")
        yield Static("Starting...", id="status")
        yield RichLog(id="log", wrap=True)
        yield Footer()

    def on_mount(self) -> None:
        catalog: DataTable = self.query_one("#catalog", DataTable)
        catalog.add_columns("Name", "Size", "Available from", "Type", "ID")
        self.set_interval(0.25, self._drain_logs)
        self.server.start()
        self._focus_catalog()
        self._set_status(f"Serving {len(self.peer.get_shared_files())} file(s) from {self.served_folder}")
        self.action_refresh_catalog()

    def on_unmount(self) -> None:
        self.server.stop()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        self._mark_row_selected(event.data_table, event.row_key)

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        self._mark_row_selected(event.data_table, event.row_key)

    def on_data_table_cell_highlighted(self, event: DataTable.CellHighlighted) -> None:
        self._mark_row_index(event.data_table, event.coordinate.row)

    def on_key(self, event: Key) -> None:
        if _is_filter_start_key(event) and not self.filter_active:
            self.filter_active = True
            self.filter_text = ""
            self._apply_catalog_filter()
            event.stop()
            event.prevent_default()
            return
        if not self.filter_active:
            return
        if event.key == "escape":
            self._clear_catalog_filter()
            event.stop()
            event.prevent_default()
            return
        if event.key == "backspace":
            self.filter_text = self.filter_text[:-1]
            if not self.filter_text:
                self.filter_active = False
            self._apply_catalog_filter()
            event.stop()
            event.prevent_default()
            return
        if event.character and _is_filter_character(event.character):
            self.filter_text += event.character
            self._apply_catalog_filter()
            event.stop()
            event.prevent_default()

    def _mark_row_selected(self, data_table: DataTable, row_key: object) -> None:
        key: str = _row_key_to_string(row_key)
        row_index: int | None = selected_index(key, data_table.cursor_row, data_table.row_count)
        if row_index is not None:
            self._mark_row_index(data_table, row_index)

    def _mark_row_index(self, data_table: DataTable, row_index: int) -> None:
        if data_table.id == "catalog":
            self.selected_catalog_key = str(row_index)
            catalog_index: int | None = selected_index(self.selected_catalog_key, row_index, len(self.visible_catalog))
            if catalog_index is not None:
                selected_file: CatalogFile = self.visible_catalog[catalog_index]
                self._set_status(f"Selected {selected_file.name} from {len(selected_file.sources)} source(s)")

    def action_refresh_catalog(self) -> None:
        self._set_status("Finding peers and files via broadcast...")
        self._run_thread("refresh-catalog", self._refresh_catalog_worker)

    def action_download_file(self) -> None:
        selected_file: CatalogFile | None = self._selected_catalog_file()
        if selected_file is None:
            self._set_status("Select a file first")
            return
        self._set_status(f"Downloading {selected_file.name}...")
        self._run_thread("download-file", lambda: self._download_file_worker(selected_file))

    def action_refresh_served(self) -> None:
        count: int = refresh_shared_files(self.peer, self.served_folder, chunk_size=self.chunk_size)
        self._set_status(f"Serving {count} file(s) from {self.served_folder}")

    def _refresh_catalog_worker(self) -> None:
        try:
            peers: list[DiscoveredPeer] = self.peer.discover_peers(self.broadcast_targets, timeout=0.7, attempts=2)
        except Exception as exc:
            self.call_from_thread(self._set_status, f"Peer discovery failed: {exc}")
            return
        records_by_peer: dict[Address, list[FileRecord]] = {}
        for discovered_peer in peers:
            try:
                responses: list[Files] = self.peer.find(
                    discovered_peer.address,
                    query_kind=QueryKind.LIST_ALL,
                    query="",
                    max_results=100,
                    timeout=0.7,
                    attempts=2,
                )
            except Exception as exc:
                self.log_queue.put(f"File listing failed for {discovered_peer.address[0]}:{discovered_peer.address[1]}: {exc}")
                records_by_peer[discovered_peer.address] = []
                continue
            records_by_peer[discovered_peer.address] = [
                record for response in responses for record in response.records
            ]
        catalog: list[CatalogFile] = build_catalog(records_by_peer_to_peer_files(peers, records_by_peer))
        self.call_from_thread(self._set_catalog, peers, catalog)

    def _download_file_worker(self, selected_file: CatalogFile) -> None:
        try:
            sources = list(selected_file.sources)
            if not sources:
                raise RuntimeError("no peers currently offer this file")
            self.call_from_thread(self._set_status, f"Swarm downloading from {len(sources)} source(s)...")
            record: FileRecord = sources[0].record
            downloaded_path: Path = download_path_for(record)
            result = download_swarm(
                peer=self.peer,
                sources=sources,
                file_id=selected_file.file_id,
                file_size=selected_file.file_size,
                output_path=downloaded_path,
            )
            served_copy: Path = copy_into_served_folder(downloaded_path, self.served_folder, record)
            count: int = refresh_shared_files(self.peer, self.served_folder, chunk_size=self.chunk_size)
        except Exception as exc:
            self.call_from_thread(self._set_status, f"Download failed: {exc}")
            return
        self.call_from_thread(
            self._set_status,
            f"Swarm downloaded {result.range_count} range(s) from {result.source_count} source(s); "
            f"copied to {served_copy}; serving {count} file(s)",
        )

    def _set_catalog(self, peers: list[DiscoveredPeer], catalog: list[CatalogFile]) -> None:
        self.peers = peers
        self.catalog = catalog
        self._apply_catalog_filter()
        self._set_catalog_status()

    def _apply_catalog_filter(self) -> None:
        self.visible_catalog = filter_catalog_by_name(self.catalog, self.filter_text)
        table: DataTable = self.query_one("#catalog", DataTable)
        table.clear()
        self.selected_catalog_key = None
        for index, item in enumerate(self.visible_catalog):
            table.add_row(
                item.name,
                str(item.file_size),
                available_from_label(source.peer for source in item.sources),
                item.media_type,
                item.display_id,
                key=str(index),
            )
        if self.visible_catalog:
            table.move_cursor(row=0, column=0, animate=False)
            self.selected_catalog_key = "0"
        self._focus_catalog()
        self._set_catalog_title()

    def _clear_catalog_filter(self) -> None:
        self.filter_text = ""
        self.filter_active = False
        self._apply_catalog_filter()

    def _selected_catalog_file(self) -> CatalogFile | None:
        table: DataTable = self.query_one("#catalog", DataTable)
        index: int | None = selected_index(self.selected_catalog_key, table.cursor_row, len(self.visible_catalog))
        if index is None:
            return None
        return self.visible_catalog[index]

    def _set_catalog_status(self) -> None:
        self._set_status(f"Found {len(self.catalog)} file(s) from {len(self.peers)} peer(s)")

    def _set_catalog_title(self) -> None:
        self.query_one("#catalog-title", Static).update(file_list_title(self.filter_active, self.filter_text))

    def _focus_catalog(self) -> None:
        self.query_one("#catalog", DataTable).focus()

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

    def _run_thread(self, name: str, target: Callable[[], None]) -> None:
        thread: threading.Thread = threading.Thread(target=target, name=f"dtf-tui-{name}", daemon=True)
        thread.start()


def run_tui(
    served_folder: Path,
    name: str = "",
    port: int = DEFAULT_PORT,
    broadcast_targets: Iterable[Address] | None = None,
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


def _is_filter_character(value: str) -> bool:
    return len(value) == 1 and value.isprintable()


def _is_filter_start_key(event: Key) -> bool:
    return event.key in {"/", "slash"} or event.character == "/"
