from __future__ import annotations

import unittest

from dtf.names import ADJECTIVES, NAMES, random_peer_name


class NamesTest(unittest.TestCase):
    def test_random_peer_name_is_adjective_plus_name(self) -> None:
        value: str = random_peer_name()
        words: list[str] = value.split()

        self.assertEqual(len(words), 2)
        self.assertIn(words[0], ADJECTIVES)
        self.assertIn(words[1], NAMES)


if __name__ == "__main__":
    unittest.main()
