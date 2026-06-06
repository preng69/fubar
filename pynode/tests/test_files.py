from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from dtf.files import file_id_from_hex, index_paths, match_files
from dtf.protocol import QueryKind


class FilesTest(unittest.TestCase):
    def test_index_paths_and_match_queries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root: Path = Path(directory)
            alpha: Path = root / "alpha-report.txt"
            beta: Path = root / "beta.bin"
            alpha.write_text("alpha", encoding="utf-8")
            beta.write_bytes(b"beta")

            shared_files = index_paths([root], tags=("demo",), chunk_size=4096)

            self.assertEqual(len(shared_files), 2)
            total, all_records = match_files(shared_files, QueryKind.LIST_ALL, "", 25)
            self.assertEqual(total, 2)
            self.assertEqual(len(all_records), 2)

            total, substring_records = match_files(shared_files, QueryKind.SUBSTRING, "REPORT", 25)
            self.assertEqual(total, 1)
            self.assertEqual(substring_records[0].name, "alpha-report.txt")

            total, tag_records = match_files(shared_files, QueryKind.TAG, "DEMO", 25)
            self.assertEqual(total, 2)
            self.assertEqual(len(tag_records), 2)

            total, exact_records = match_files(
                shared_files,
                QueryKind.EXACT_FILE_ID,
                shared_files[0].file_id.hex(),
                25,
            )
            self.assertEqual(total, 1)
            self.assertEqual(exact_records[0].file_id, shared_files[0].file_id)

    def test_max_results_zero_uses_responder_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root: Path = Path(directory)
            for index in range(3):
                (root / f"file-{index}.txt").write_text(str(index), encoding="utf-8")

            shared_files = index_paths([root])
            total, records = match_files(shared_files, QueryKind.LIST_ALL, "", 0)

            self.assertEqual(total, 3)
            self.assertEqual(len(records), 3)

    def test_file_id_from_hex_validation(self) -> None:
        self.assertEqual(file_id_from_hex("ab" * 32), bytes.fromhex("ab" * 32))
        with self.assertRaises(ValueError):
            file_id_from_hex("ab")
        with self.assertRaises(ValueError):
            file_id_from_hex("zz" * 32)


if __name__ == "__main__":
    unittest.main()
