from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from dtf.peer import DTFPeer
from dtf.protocol import FILE_ID_LEN, FileRecord
from dtf.tui_helpers import (
    APP_NAME,
    app_header_title,
    collision_safe_path,
    copy_into_served_folder,
    download_path_for,
    file_list_title,
    refresh_shared_files,
    safe_filename,
    selected_index,
    served_copy_path_for,
)


class TuiHelpersTest(unittest.TestCase):
    def test_app_header_title_uses_app_name_and_peer_name(self) -> None:
        self.assertEqual(APP_NAME, "DTF boss")
        self.assertEqual(app_header_title("green robert"), "DTF boss - green robert")
        self.assertEqual(app_header_title(""), "DTF boss")

    def test_file_list_title_shows_filter(self) -> None:
        self.assertEqual(file_list_title(False, ""), "Files")
        self.assertEqual(file_list_title(True, ""), "Files matching /")
        self.assertEqual(file_list_title(True, "abc"), "Files matching /abc")
        self.assertEqual(file_list_title(False, "abc"), "Files matching /abc")

    def test_selected_index_prefers_explicit_key_and_falls_back_to_cursor(self) -> None:
        self.assertEqual(selected_index("1", cursor_row=0, row_count=3), 1)
        self.assertEqual(selected_index(None, cursor_row=2, row_count=3), 2)
        self.assertEqual(selected_index("bad", cursor_row=2, row_count=3), 2)
        self.assertIsNone(selected_index(None, cursor_row=0, row_count=0))

    def test_safe_filename_removes_path_components(self) -> None:
        self.assertEqual(safe_filename("../demo.txt"), "demo.txt")
        self.assertEqual(safe_filename(""), "downloaded-file")

    def test_collision_safe_path_appends_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root: Path = Path(directory)
            (root / "demo.txt").write_text("first", encoding="utf-8")

            path: Path = collision_safe_path(root, "demo.txt")

            self.assertEqual(path.name, "demo (1).txt")

    def test_download_and_served_copy_paths_use_record_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root: Path = Path(directory)
            record: FileRecord = FileRecord(
                file_id=b"a" * FILE_ID_LEN,
                file_size=1,
                chunk_size=4096,
                name="../remote.txt",
                media_type="text/plain",
                tags=(),
            )

            self.assertEqual(download_path_for(record, downloads_dir=root).name, "remote.txt")
            self.assertEqual(served_copy_path_for(record, served_folder=root).name, "remote.txt")

    def test_copy_into_served_folder_and_refresh_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root: Path = Path(directory)
            source: Path = root / "source.txt"
            served: Path = root / "served"
            source.write_text("payload", encoding="utf-8")
            record: FileRecord = FileRecord(
                file_id=b"a" * FILE_ID_LEN,
                file_size=7,
                chunk_size=4096,
                name="copied.txt",
                media_type="text/plain",
                tags=(),
            )
            peer: DTFPeer = DTFPeer(logger=lambda _line: None)

            copied: Path = copy_into_served_folder(source, served, record)
            count: int = refresh_shared_files(peer, served)

            self.assertEqual(copied.read_text(encoding="utf-8"), "payload")
            self.assertEqual(count, 1)
            self.assertEqual(peer.get_shared_files()[0].name, "copied.txt")


if __name__ == "__main__":
    unittest.main()
