import { createDtfMockClient } from "../dist/index.js";

const client = createDtfMockClient();
const allFiles = await client.findFiles({ queryKind: "all" });

if (allFiles.records.length !== 3) {
  throw new Error(`Expected 3 mock files, got ${allFiles.records.length}`);
}

const taggedFiles = await client.findFiles({ queryKind: "tag", query: "sample" });

if (taggedFiles.records.length !== 2) {
  throw new Error(`Expected 2 sample-tagged files, got ${taggedFiles.records.length}`);
}

const firstFile = allFiles.records[0];
const session = await client.hello({ peerId: firstFile.peers[0].peerId });
const range = await client.getRange({
  fileId: firstFile.fileId,
  fromOffset: 0,
  toOffset: 128,
  sessionId: session.sessionId
});

if (range.data.byteLength !== 128) {
  throw new Error(`Expected 128 bytes, got ${range.data.byteLength}`);
}

let progressEvents = 0;
const download = await client.downloadFile(firstFile.fileId, {
  sessionId: session.sessionId,
  onProgress: () => {
    progressEvents += 1;
  }
});

if (download.byteLength !== firstFile.fileSize) {
  throw new Error(`Expected ${firstFile.fileSize} downloaded bytes, got ${download.byteLength}`);
}

if (progressEvents === 0) {
  throw new Error("Expected download progress events");
}

console.log("DTF mock smoke test passed");
