from __future__ import annotations

import secrets


ADJECTIVES: tuple[str, ...] = (
    "blue",
    "brave",
    "bright",
    "calm",
    "clear",
    "green",
    "kind",
    "lucky",
    "quiet",
    "red",
    "swift",
    "warm",
)

NAMES: tuple[str, ...] = (
    "ada",
    "alice",
    "amelia",
    "charlie",
    "frida",
    "grace",
    "james",
    "linus",
    "maria",
    "robert",
    "sam",
    "sara",
)


def random_peer_name() -> str:
    return f"{secrets.choice(ADJECTIVES)} {secrets.choice(NAMES)}"
