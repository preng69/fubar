import { createDtfClient, createDtfFileServer, mockDtfDataset } from "../dist/index.js";
import { decodeDtfPacket } from "../dist/codec.js";
import { DtfMessageType } from "../dist/types.js";

const network = createMultiServerMemoryTransports(
  ["ada", "build", "quiet"],
  new Map([["lan", ["ada", "build"]]])
);
const client = createDtfClient({
  localPeer: mockDtfDataset.localPeer,
  transport: network.clientTransport,
  discoveryAddresses: ["lan", "quiet"],
  discoveryResponseTimeoutMs: 1,
  acceptDiscoveryResponse(_sourceAddress, discoveryAddress) {
    return discoveryAddress === "lan";
  }
});
const servers = [
  createDtfFileServer({
    localPeer: mockDtfDataset.peers[0],
    transport: network.serverTransports.get("ada"),
    files: [mockDtfDataset.files[0]],
    contents: mockDtfDataset.contents
  }),
  createDtfFileServer({
    localPeer: mockDtfDataset.peers[1],
    transport: network.serverTransports.get("build"),
    files: [mockDtfDataset.files[0]],
    contents: mockDtfDataset.contents
  })
];

try {
  const available = await client.findAvailableFiles({
    queryKind: "name",
    query: "handbook"
  });

  if (available.records.length !== 1) {
    throw new Error(`Expected one available file, got ${available.records.length}`);
  }

  const [file] = available.records;

  if (file.peers.length !== 2) {
    throw new Error(`Expected two serving peers for the available file, got ${file.peers.length}`);
  }

  let progressEvents = 0;
  let attributedProgressEvents = 0;
  const bytes = await client.downloadFile(file, {
    chunkSize: 512,
    maxDatagram: 140,
    maxParallelRequests: 2,
    onProgress(progress) {
      progressEvents += 1;

      if (progress.fileId !== file.fileId) {
        throw new Error("Expected progress events for the downloaded file");
      }

      if (progress.peer?.peerId && progress.chunk?.toOffset > progress.chunk?.fromOffset) {
        attributedProgressEvents += 1;
      }
    }
  });
  const expectedBytes = mockDtfDataset.contents[file.fileId];

  if (!bytesEqual(bytes, expectedBytes)) {
    throw new Error("Expected downloaded bytes to match mock content");
  }

  if (progressEvents === 0) {
    throw new Error("Expected download progress events");
  }

  if (attributedProgressEvents !== progressEvents) {
    throw new Error("Expected every download progress event to include peer and chunk attribution");
  }

  if ((network.rangeRequests.get("ada") ?? 0) === 0 || (network.rangeRequests.get("build") ?? 0) === 0) {
    throw new Error("Expected parallel download to request ranges from both serving peers");
  }

  if (network.peakActiveRangeRequests !== 5) {
    throw new Error(`Expected maxParallelRequests below 5 to clamp to 5, got ${network.peakActiveRangeRequests}`);
  }
} finally {
  client.dispose();

  for (const server of servers) {
    server.dispose();
  }
}

console.log("DTF package smoke test passed");

function createMultiServerMemoryTransports(addresses, routes = new Map()) {
  const clientHandlers = new Set();
  const rangeRequests = new Map(addresses.map((address) => [address, 0]));
  const activeRangeRequestAddresses = new Map();
  let activeRangeRequests = 0;
  let peakActiveRangeRequests = 0;
  const serverHandlersByAddress = new Map(addresses.map((address) => [address, new Set()]));
  const serverTransports = new Map(
    addresses.map((address) => [
      address,
      {
        send(bytes, _address) {
          const packet = decodeDtfPacket(bytes);

          if (
            (packet?.type === DtfMessageType.RangeDone || packet?.type === DtfMessageType.Error) &&
            activeRangeRequestAddresses.get(packet.requestId) === address
          ) {
            activeRangeRequestAddresses.delete(packet.requestId);
            activeRangeRequests -= 1;
          }

          for (const handler of [...clientHandlers]) {
            handler({ bytes, address });
          }
        },
        subscribe(handler) {
          const handlers = serverHandlersByAddress.get(address);
          handlers.add(handler);
          return () => handlers.delete(handler);
        }
      }
    ])
  );

  const clientTransport = {
    send(bytes, address) {
      const route = routes.get(address) ?? [address];

      for (const routedAddress of route) {
        const handlers = serverHandlersByAddress.get(routedAddress);

        if (!handlers) {
          continue;
        }

        const packet = decodeDtfPacket(bytes);

        if (packet?.type === DtfMessageType.GetRange) {
          rangeRequests.set(routedAddress, (rangeRequests.get(routedAddress) ?? 0) + 1);
          activeRangeRequestAddresses.set(packet.requestId, routedAddress);
          activeRangeRequests += 1;
          peakActiveRangeRequests = Math.max(peakActiveRangeRequests, activeRangeRequests);
        }

        for (const handler of [...handlers]) {
          handler({ bytes, address: "client" });
        }
      }
    },
    subscribe(handler) {
      clientHandlers.add(handler);
      return () => clientHandlers.delete(handler);
    }
  };

  return {
    clientTransport,
    rangeRequests,
    serverTransports,
    get peakActiveRangeRequests() {
      return peakActiveRangeRequests;
    }
  };
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}
