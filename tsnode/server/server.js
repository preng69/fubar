import dgram from "node:dgram";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { createDtfFileServer, mockDtfDataset } from "../dist/index.js";
import { DTF_DEFAULT_PORT } from "../dist/types.js";

const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 20;

export function createDtfServer(options = {}) {
  const dataset = options.dataset ?? mockDtfDataset;
  const listenPort = Number(options.port ?? process.env.DTF_PORT ?? DTF_DEFAULT_PORT);
  const host = options.host ?? process.env.DTF_HOST ?? "0.0.0.0";
  const bridgeEnabled = options.bridge !== false;
  const httpPort = Number(options.httpPort ?? process.env.DTF_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  const httpHost = options.httpHost ?? process.env.DTF_HTTP_HOST ?? host;
  const socket = dgram.createSocket("udp4");
  const subscribers = new Set();
  const localPeer = {
    ...dataset.localPeer,
    name: options.peerName ?? process.env.DTF_PEER_NAME ?? dataset.localPeer.name,
    listenPort
  };
  const files = dataset.files.map(({ peerIds, ...file }) => file);
  const apiFiles = dataset.files.map((file) => ({
    fileId: file.fileId,
    fileSize: file.fileSize,
    chunkSize: file.chunkSize,
    name: file.name,
    mediaType: file.mediaType,
    tags: file.tags,
    peers: file.peerIds
      .map((peerId) => dataset.peers.find((peer) => peer.peerId === peerId))
      .filter((peer) => peer !== undefined)
  }));
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

  const bridge = bridgeEnabled ? createBridge({ dataset, files: apiFiles, localPeer }) : undefined;

  return {
    socket,
    fileServer,
    httpServer: bridge?.httpServer,
    wsServer: bridge?.wsServer,
    host,
    port: listenPort,
    httpHost,
    httpPort,
    start() {
      return new Promise((resolve) => {
        socket.bind(listenPort, host, () => {
          socket.setBroadcast(true);
          if (!bridge) {
            resolve(socket.address());
            return;
          }

          bridge.httpServer.listen(httpPort, httpHost, () => {
            bridge.broadcast({
              type: "server-status",
              status: "online",
              udp: socket.address(),
              http: bridge.httpServer.address()
            });
            resolve(socket.address());
          });
        });
      });
    },
    close() {
      fileServer.dispose();
      return new Promise((resolve) => {
        bridge?.wsServer.close();
        const closeUdp = () => socket.close(resolve);
        if (bridge) {
          bridge.httpServer.close(closeUdp);
        } else {
          closeUdp();
        }
      });
    }
  };
}

export async function startDtfServer(options = {}) {
  const server = createDtfServer(options);
  const address = await server.start();
  return { server, address };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, address } = await startDtfServer();
  console.log(`DTF mock UDP server listening on ${address.address}:${address.port}`);
  if (server.httpServer) {
    const httpAddress = server.httpServer.address();
    console.log(`DTF bridge listening on http://${httpAddress.address}:${httpAddress.port}`);
  }
  console.log("Use this machine's local WiFi IP from other devices on the same network.");
}

function createBridge({ dataset, files, localPeer }) {
  const sockets = new Set();
  const httpServer = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (!request.url || request.method !== "GET") {
      sendJson(response, 405, { error: "method-not-allowed" });
      return;
    }

    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        peer: localPeer,
        fileCount: files.length,
        peerCount: dataset.peers.length
      });
      return;
    }

    if (url.pathname === "/api/peers") {
      sendJson(response, 200, {
        localPeer,
        peers: dataset.peers
      });
      return;
    }

    if (url.pathname === "/api/files") {
      const page = positiveInt(url.searchParams.get("page"), 1);
      const pageSize = Math.min(positiveInt(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
      const pageCount = Math.max(1, Math.ceil(files.length / pageSize));
      const currentPage = Math.min(page, pageCount);
      const start = (currentPage - 1) * pageSize;
      sendJson(response, 200, {
        page: currentPage,
        pageSize,
        pageCount,
        total: files.length,
        records: files.slice(start, start + pageSize)
      });
      return;
    }

    const fileMatch = /^\/api\/files\/([0-9a-f]{64})$/i.exec(url.pathname);
    if (fileMatch) {
      const file = files.find((record) => record.fileId === fileMatch[1].toLowerCase());
      if (!file) {
        sendJson(response, 404, { error: "file-not-found" });
        return;
      }

      sendJson(response, 200, file);
      return;
    }

    sendJson(response, 404, { error: "not-found" });
  });
  const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });

  wsServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.send(
      JSON.stringify({
        type: "server-status",
        status: "online",
        peer: localPeer,
        fileCount: files.length,
        peerCount: dataset.peers.length
      })
    );
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    httpServer,
    wsServer,
    broadcast(message) {
      const body = JSON.stringify(message);
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(body);
        }
      }
    }
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
