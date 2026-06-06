import type { DtfMockDataset } from "./types.js";

const textEncoder = new TextEncoder();

const FILE_IDS = {
  handbook: "0f3d5b0f0bdf4f58f90dce59ef6c0d04514d8af9c7b5ad8f8c955f77f5ad4b70",
  trailer: "7c6fd9a4420d9d73bb816e0ef1078f64d7079a2f7bfeb0ff9eac4eae8b77b9d1",
  dataset: "bfdf5a9e0fb8a6bc0a760be557d0f737bc79aa4f5cd2b8232a8744d2b26ad2ca"
} as const;

function repeatBytes(seed: string, targetLength: number): Uint8Array {
  const seedBytes = textEncoder.encode(seed);
  const bytes = new Uint8Array(targetLength);

  for (let index = 0; index < targetLength; index += 1) {
    bytes[index] = seedBytes[index % seedBytes.length] ^ ((index * 31) & 0xff);
  }

  return bytes;
}

export const mockDtfDataset: DtfMockDataset = {
  localPeer: {
    peerId: "11111111111111111111111111111111",
    name: "Vite Preview Client",
    listenPort: 4747
  },
  peers: [
    {
      peerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Ada Laptop",
      listenPort: 4747
    },
    {
      peerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "Build Server",
      listenPort: 4747
    },
    {
      peerId: "cccccccccccccccccccccccccccccccc",
      name: "Media Box",
      listenPort: 4747
    }
  ],
  files: [
    {
      fileId: FILE_IDS.handbook,
      fileSize: 18_432,
      chunkSize: 16_384,
      name: "dtf-handbook.txt",
      mediaType: "text/plain",
      tags: ["docs", "dtf", "sample"],
      peerIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
    },
    {
      fileId: FILE_IDS.trailer,
      fileSize: 92_160,
      chunkSize: 32_768,
      name: "launch-trailer.mp4",
      mediaType: "video/mp4",
      tags: ["video", "demo"],
      peerIds: ["cccccccccccccccccccccccccccccccc"]
    },
    {
      fileId: FILE_IDS.dataset,
      fileSize: 65_536,
      chunkSize: 16_384,
      name: "tiny-index.json",
      mediaType: "application/json",
      tags: ["metadata", "index", "sample"],
      peerIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
    }
  ],
  contents: {
    [FILE_IDS.handbook]: repeatBytes("DTF handbook mock content\n", 18_432),
    [FILE_IDS.trailer]: repeatBytes("mock mp4 bytes ", 92_160),
    [FILE_IDS.dataset]: repeatBytes('{"kind":"mock-index","items":[1,2,3]}\n', 65_536)
  }
};
