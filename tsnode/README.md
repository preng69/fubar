# DTF Package

Browser-friendly DTF package for discovering available files and downloading them from accessible peers.

The public API is intentionally above the wire protocol:

- `findAvailableFiles(...)` discovers files across configured discovery addresses
- `downloadFile(...)` connects to available peers and downloads ranges in parallel
- `createDtfFileServer(...)` serves indexed files and responds to discovery/download requests

The package does not provide a UDP socket implementation. Supply a `DtfDatagramTransport` for the browser or runtime you are using.

## Install From This Repo

From a Vite app on the same machine:

```sh
npm install ../fubar/tsnode
```

Or, during development:

```sh
npm link ../fubar/tsnode
```

## Client

```ts
import { createDtfClient } from "@dtf/mock";

const dtf = createDtfClient({
  localPeer,
  transport,
  discoveryAddresses: [lanBroadcast, knownPeer],
  acceptDiscoveryResponse(sourceAddress, discoveryAddress) {
    return discoveryAddress === lanBroadcast || sourceAddress === discoveryAddress;
  }
});

const available = await dtf.findAvailableFiles({
  queryKind: "name",
  query: "handbook"
});

const bytes = await dtf.downloadFile(available.records[0], {
  maxParallelRequests: 4,
  onProgress(progress) {
    console.log(progress.receivedBytes, progress.totalBytes);
  }
});
```

## File Server

```ts
import { createDtfFileServer, mockDtfDataset } from "@dtf/mock";

const server = createDtfFileServer({
  localPeer: mockDtfDataset.peers[0],
  transport,
  files: mockDtfDataset.files,
  contents: mockDtfDataset.contents
});
```

## Development

Run package commands from this directory:

```sh
npm run build
npm run typecheck
npm run smoke
```

## UDP Backend Server

The package also includes a JavaScript Node.js UDP server for the draft DTF
protocol. It wraps the compiled TypeScript DTF implementation from `dist`, so
build before running:

```sh
npm run server
```

The Node server uses two local folders:

- `files/uploads/` contains files this peer advertises and serves to other clients.
- `files/downloads/` receives files downloaded by the Node download helper.

Both folders are created automatically. Dotfiles are ignored when scanning
uploads, so the checked-in `.gitkeep` marker is not advertised.

By default the server listens on UDP `0.0.0.0:4747`, which makes it reachable
from other machines on the same local WiFi using this computer's LAN IP address.
You can override the bind address, port, displayed peer name, and folders:

```sh
$env:DTF_HOST = "0.0.0.0"
$env:DTF_PORT = "4747"
$env:DTF_PEER_NAME = "Living Room Server"
$env:DTF_UPLOADS_DIR = "C:\Users\you\DTF\uploads"
$env:DTF_DOWNLOADS_DIR = "C:\Users\you\DTF\downloads"
npm run server
```

On Windows, allow Node.js or UDP port `4747` through the firewall if another
machine cannot reach the server.

Download the first matching file from a peer into `files/downloads/` with:

```sh
npm run download -- 127.0.0.1:4747 handbook
```

Add `--all` to download every matching file:

```sh
npm run download -- 127.0.0.1:4747 handbook --all
```

Run the UDP smoke test with:

```sh
npm run server:smoke
```

## React Frontend

For the simplest one-server setup, run:

```sh
npm run app
```

Then open:

```text
http://localhost:8787
```

This serves the React frontend, HTTP API, WebSocket updates, and DTF UDP server
from one Node.js server.

During frontend development, you can still start the Node.js server:

```sh
npm run server
```

In another terminal, start the Vite frontend:

```sh
npm run dev
```

The frontend proxies `/api` and `/ws` to the Node.js server on port `8787`.
