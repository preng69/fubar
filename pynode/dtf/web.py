from __future__ import annotations

import shlex
import sys
from pathlib import Path
from typing import Iterable

from .peer import Address
from .protocol import DEFAULT_PORT
from .tui_helpers import app_header_title


DEFAULT_WEB_HOST: str = "127.0.0.1"
DEFAULT_WEB_PORT: int = 8080


def build_tui_command(
    served_folder: Path,
    name: str,
    dtf_port: int = DEFAULT_PORT,
    broadcast_targets: Iterable[Address] = (),
) -> str:
    parts: list[str] = [
        sys.executable,
        "-m",
        "dtf.cli",
    ]
    if name:
        parts.extend(["--name", name])
    parts.extend(["--port", str(dtf_port), "tui", str(served_folder)])
    for host, port in broadcast_targets:
        parts.extend(["--broadcast-target", f"{host}:{port}"])
    return " ".join(shlex.quote(part) for part in parts)


def run_web(
    served_folder: Path,
    name: str,
    dtf_port: int = DEFAULT_PORT,
    broadcast_targets: Iterable[Address] = (),
    host: str = DEFAULT_WEB_HOST,
    web_port: int = DEFAULT_WEB_PORT,
) -> None:
    try:
        from textual_serve.server import Server
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "textual-serve is required for web mode; install with "
            "`python3 -m pip install -r requirements.txt` from pynode"
        ) from exc

    command: str = build_tui_command(
        served_folder=served_folder,
        name=name,
        dtf_port=dtf_port,
        broadcast_targets=broadcast_targets,
    )
    server = Server(
        command,
        host=host,
        port=web_port,
        title=app_header_title(name),
        public_url=f"http://{host}:{web_port}",
    )
    server.serve()
