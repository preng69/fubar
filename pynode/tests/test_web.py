from __future__ import annotations

import sys
import unittest
from pathlib import Path

from dtf.web import DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, build_tui_command


class WebTest(unittest.TestCase):
    def test_build_tui_command_quotes_name_and_folder(self) -> None:
        command: str = build_tui_command(
            served_folder=Path("shared files"),
            name="green robert",
            dtf_port=4748,
            broadcast_targets=[("10.2.0.255", 4747)],
        )

        self.assertIn(sys.executable, command)
        self.assertIn("-m dtf.cli", command)
        self.assertIn("--name 'green robert'", command)
        self.assertIn("--port 4748 tui 'shared files'", command)
        self.assertIn("--broadcast-target 10.2.0.255:4747", command)

    def test_web_defaults_are_localhost_8080(self) -> None:
        self.assertEqual(DEFAULT_WEB_HOST, "127.0.0.1")
        self.assertEqual(DEFAULT_WEB_PORT, 8080)


if __name__ == "__main__":
    unittest.main()
