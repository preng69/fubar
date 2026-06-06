import dgram from "node:dgram";
import { pathToFileURL } from "node:url";
import { createDtfFileServer, mockDtfDataset } from "../dist/index.js";
import { DTF_DEFAULT_PORT } from "../dist/types.js";

export function createDtfServer(options = {}) {
  const dataset = options.dataset ?? mockDtfDataset;
  const listenPort = Number(options.port ?? process.env.DTF_PORT ?? DTF_DEFAULT_PORT);
  const host = options.host ?? process.env.DTF_HOST ?? "0.0.0.0";
  const socket = dgram.createSocket("udp4");
  const subscribers = new Set();
  const localPeer = {
    ...dataset.localPeer,
    name: options.peerName ?? process.env.DTF_PEER_NAME ?? dataset.localPeer.name,
    listenPort
  };
  const files = dataset.files.map(({ peerIds, ...file }) => file);
  const transport = {
    send(bytes, address) {
      socket.send(Buffer.from(bytes), address.port, address.address);
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    }
  };
  const fileServer = createDtfFileServer({
    localPeer,
    transport,
    files,
    contents: dataset.contents,
    sessionIdFactory: options.sessionIdFactory,
    maxRangeLength: options.maxRangeLength,
    defaultMaxDatagram: options.defaultMaxDatagram
  });

  socket.on("message", (bytes, address) => {
    for (const subscriber of subscribers) {
      subscriber({ bytes, address });
    }
  });

  return {
    socket,
    fileServer,
    host,
    port: listenPort,
    start() {
      return new Promise((resolve) => {
        socket.bind(listenPort, host, () => {
          socket.setBroadcast(true);
          resolve(socket.address());
        });
      });
    },
    close() {
      fileServer.dispose();
      return new Promise((resolve) => socket.close(resolve));
    }
  };
}

export async function startDtfServer(options = {}) {
  const server = createDtfServer(options);
  const address = await server.start();
  return { server, address };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { address } = await startDtfServer();
  console.log(`DTF mock UDP server listening on ${address.address}:${address.port}`);
  console.log("Use this machine's local WiFi IP from other devices on the same network.");
}
