Python implementation of the DTF protocol.

## Usage

Run commands from the repository root with `PYTHONPATH=pynode`.

Serve files:

```sh
PYTHONPATH=pynode python3 -m dtf.cli --name alice --port 4747 serve ./shared
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
