# DTF Mock

Browser-friendly mock client for building a Vite UI against the draft DTF protocol while the real implementation is still in development.

This package is intentionally deterministic. It does not simulate UDP transport behavior such as latency, packet loss, out-of-order delivery, retries, or transport failures.

## Install From This Repo

From a Vite app on the same machine:

```sh
npm install ../fubar/tsnode
```

Or, during development:

```sh
npm link ../fubar/tsnode
```

## Basic Usage

```ts
import { createDtfMockClient } from "@dtf/mock";

const dtf = createDtfMockClient();

const { records } = await dtf.findFiles({
  queryKind: "name",
  query: "handbook"
});

const file = records[0];
const session = await dtf.hello({
  peerId: file.peers[0].peerId
});

const bytes = await dtf.downloadFile(file.fileId, {
  sessionId: session.sessionId,
  onProgress(progress) {
    console.log(progress.receivedBytes, progress.totalBytes);
  }
});
```

## Mock Data

The default dataset includes:

- Three peers: `Ada Laptop`, `Build Server`, and `Media Box`
- Three files: `dtf-handbook.txt`, `launch-trailer.mp4`, and `tiny-index.json`
- Tags for testing `all`, `name`, `fileId`, and `tag` discovery flows
- In-memory bytes for range reads and full-file downloads

You can inspect or reuse the dataset directly:

```ts
import { mockDtfDataset } from "@dtf/mock";

console.log(mockDtfDataset.files);
```

## API

### `createDtfMockClient(options?)`

Creates a mock DTF client. Pass a custom dataset to override the default peers, files, and byte contents.

### `client.findFiles(request?)`

Supports protocol-shaped query kinds:

- `all`
- `name`
- `fileId`
- `tag`

Returns `{ requestId, totalMatches, records }`.

### `client.hello(request)`

Creates a deterministic mock session for a known peer.

### `client.getRange(request)`

Returns a byte range for a known file. Ranges use DTF semantics: `fromOffset` is inclusive and `toOffset` is exclusive.

### `client.downloadFile(fileId, options?)`

Downloads the whole in-memory file by calling `getRange` in chunks. Use `onProgress` to update UI state.

### `client.cancel(requestId)`

Stores a cancellation marker for app code that wants to wire a cancel action. For full-file downloads, prefer passing an `AbortSignal`.

```ts
const controller = new AbortController();

const download = dtf.downloadFile(file.fileId, {
  signal: controller.signal
});

controller.abort();
await download;
```

## Development

```sh
npm install
npm run build
npm run smoke
```
