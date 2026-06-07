Python implementation of the DTF protocol.

## Usage

Run commands from the repository root with `PYTHONPATH=pynode`.

Install TUI dependencies:

```sh
cd pynode
python3 -m pip install -r requirements.txt
```

Serve files:

```sh
PYTHONPATH=pynode python3 -m dtf.cli --port 4747 serve ./shared
```

Run the combined server/client Textual TUI:

```sh
PYTHONPATH=pynode python3 -m dtf.cli tui ./shared
```

Run the same Textual frontend in a browser:

```sh
PYTHONPATH=pynode python3 -m dtf.cli web ./shared
```

Then open `http://127.0.0.1:8080`.

The TUI serves `./shared`, discovers peers with broadcast, lists all available
files alphabetically, and shows which peers each file is available from.
Downloads use swarm mode: the app downloads ranges in parallel from every
discovered peer that offers the selected file ID. Each successful download lands
in `$HOME/Downloads` and is also copied into the served folder so it becomes
available to other peers.
Peer and file discovery starts automatically when the TUI opens. Use `p` to
refresh the full catalogue manually, arrow keys to highlight a file, and `d` to
download it. Press `/` to filter visible files by a case-insensitive filename
substring; Backspace removes filter characters, and Esc clears the filter.
If `--name` is omitted, the peer starts with a random two-word name such as
`green robert`.
The default broadcast target is derived from this machine's local IPv4 address
by replacing the last octet with `.255`, for example `192.168.1.42` becomes
`192.168.1.255`.

Find DTF peers on the local network:

```sh
PYTHONPATH=pynode python3 -m dtf.cli peers
PYTHONPATH=pynode python3 -m dtf.cli peers 192.168.1.255:4747 --timeout 1
```

Find files from a known peer:

```sh
PYTHONPATH=pynode python3 -m dtf.cli find 127.0.0.1:4747 --kind all
PYTHONPATH=pynode python3 -m dtf.cli find 127.0.0.1:4747 --kind substring --query report
```

Download a file by ID:

```sh
PYTHONPATH=pynode python3 -m dtf.cli download 127.0.0.1:4747 \
  0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  ./downloaded-file
```

Every sent and received DTF command is logged to stdout as `TX ...` or `RX ...`
with peer address, request ID, and session ID.

## Make targets

From the `pynode` directory:

```sh
make serve SERVE_PATHS=./shared PORT=4747
make tui SERVE_PATHS=./shared
make web SERVE_PATHS=./shared
make peers
make peers TARGETS=192.168.1.255:4747 ARGS="--timeout 1"
make find PEER=127.0.0.1:4747 KIND=substring QUERY=report
make download PEER=127.0.0.1:4747 FILE_ID=... OUTPUT=./downloaded-file
make test
```
