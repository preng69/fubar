import dgram from "node:dgram";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { decodeDtfPacket } from "../dist/codec.js";
import { createDtfClient, createDtfProtocolResponder } from "../dist/index.js";
import { DTF_DEFAULT_PORT, DtfMessageType } from "../dist/types.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_UPLOADS_DIR = path.join(packageRoot, "files", "uploads");
const DEFAULT_DOWNLOADS_DIR = path.join(packageRoot, "files", "downloads");
const DEFAULT_WEB_DIST_DIR = path.join(packageRoot, "web-dist");
const DOWNLOAD_CLIENT_PEER_ID = "22222222222222222222222222222222";
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 20;

export function createDtfServer(options = {}) {
  const listenPort = Number(options.port ?? process.env.DTF_PORT ?? DTF_DEFAULT_PORT);
  const host = options.host ?? process.env.DTF_HOST ?? "0.0.0.0";
  const peerName = options.peerName ?? process.env.DTF_PEER_NAME ?? randomAdultPeerName();
  const dataset =
    options.dataset ??
    loadDatasetFromUploadsSync({
      uploadsDir: options.uploadsDir,
      downloadsDir: options.downloadsDir,
      peerId: options.peerId ?? process.env.DTF_PEER_ID,
      peerName,
      listenPort,
      chunkSize: options.chunkSize
    });
  const httpPort = Number(options.httpPort ?? process.env.DTF_HTTP_PORT ?? DEFAULT_HTTP_PORT);
  const httpHost = options.httpHost ?? process.env.DTF_HTTP_HOST ?? host;
  const socket = dgram.createSocket("udp4");
  const subscribers = new Set();
  const logger = createServerLogger();
  const localPeer = {
    ...dataset.localPeer,
    name: peerName,
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
      logDatagram(logger, "TX", bytes, address);
      socket.send(Buffer.from(bytes), address.port, address.address);
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    }
  };
  const dtf = createDtfProtocolResponder({
    localPeer,
    transport,
    files,
    contents: dataset.contents,
    sessionIdFactory: options.sessionIdFactory ?? sessionIdFromUuid,
    maxRangeLength: options.maxRangeLength,
    defaultMaxDatagram: options.defaultMaxDatagram
  });

  socket.on("message", (bytes, address) => {
    logDatagram(logger, "RX", bytes, address);
    for (const subscriber of subscribers) {
      subscriber({ bytes, address });
    }
  });

  const httpApp = createHttpApp({ dataset, files: apiFiles, localPeer, webDistDir: options.webDistDir, logger });
  logger.write(`DTF peer listening on ${host}:${listenPort}`);

  return {
    socket,
    dtf,
    httpServer: httpApp.httpServer,
    wsServer: httpApp.wsServer,
    uploadsDir: dataset.uploadsDir,
    downloadsDir: dataset.downloadsDir,
    host,
    port: listenPort,
    httpHost,
    httpPort,
    start() {
      return new Promise((resolve, reject) => {
        const onUdpError = (error) => {
          socket.off("listening", onUdpListening);
          reject(error);
        };
        const onUdpListening = () => {
          socket.off("error", onUdpError);
        };

        socket.once("error", onUdpError);
        socket.once("listening", onUdpListening);
        socket.bind(listenPort, host, () => {
          try {
            socket.off("error", onUdpError);
            socket.setBroadcast(true);
          } catch (error) {
            reject(error);
            return;
          }

          const onHttpError = (error) => {
            httpApp.httpServer.off("listening", onHttpListening);
            reject(error);
          };
          const onHttpListening = () => {
            httpApp.httpServer.off("error", onHttpError);
          };

          httpApp.httpServer.once("error", onHttpError);
          httpApp.httpServer.once("listening", onHttpListening);
          httpApp.httpServer.listen(httpPort, httpHost, () => {
            httpApp.httpServer.off("error", onHttpError);
            httpApp.broadcast({
              type: "server-status",
              status: "online",
              udp: socket.address(),
              http: httpApp.httpServer.address()
            });
            resolve(socket.address());
          });
        });
      });
    },
    close() {
      dtf.dispose();
      return new Promise((resolve) => {
        httpApp.wsServer.close();
        const closeUdp = () => socket.close(resolve);
        httpApp.httpServer.close(closeUdp);
      });
    }
  };
}

export async function startDtfServer(options = {}) {
  const server = createDtfServer(options);
  const address = await server.start();
  return { server, address };
}

export async function downloadFromDtfServer(options = {}) {
  const target = parseAddress(options.address ?? process.env.DTF_DISCOVERY_ADDRESS ?? `127.0.0.1:${DTF_DEFAULT_PORT}`);
  const query = options.query ?? process.env.DTF_QUERY ?? "";
  const socket = dgram.createSocket("udp4");
  const transport = createUdpClientTransport(socket);
  const client = createDtfClient({
    localPeer: {
      peerId: normalizePeerId(options.peerId ?? process.env.DTF_CLIENT_PEER_ID ?? DOWNLOAD_CLIENT_PEER_ID),
      name: options.peerName ?? process.env.DTF_CLIENT_PEER_NAME ?? "DTF Folder Client",
      listenPort: 0
    },
    transport,
    discoveryAddresses: [target],
    addressEquals,
    discoveryResponseTimeoutMs: options.discoveryResponseTimeoutMs ?? 500,
    acceptDiscoveryResponse() {
      return true;
    }
  });

  try {
    await bindUdpClient(socket);
    socket.setBroadcast(true);

    const available = await client.findAvailableFiles({
      queryKind: query ? "name" : "all",
      query,
      maxResults: options.maxResults
    });
    const records = options.all ? available.records : available.records.slice(0, 1);
    const downloads = [];

    for (const record of records) {
      const bytes = await client.downloadFile(record, {
        maxParallelRequests: options.maxParallelRequests,
        verifyIntegrity: options.verifyIntegrity ?? true
      });
      const path = await saveDownloadedFile(record, bytes, { downloadsDir: options.downloadsDir });
      downloads.push({ record, path, bytes });
    }

    return { target, available, downloads };
  } finally {
    client.dispose();
    socket.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);

  if (command === "download") {
    const result = await downloadFromDtfServer(parseDownloadCliOptions(args));

    if (result.downloads.length === 0) {
      console.log(`No files matched at ${result.target.address}:${result.target.port}`);
    }

    for (const download of result.downloads) {
      console.log(`Downloaded ${download.record.name} (${download.bytes.byteLength} bytes) to ${download.path}`);
    }
  } else {
    const { server, address } = await startDtfServer();
    console.log(`DTF UDP server listening on ${address.address}:${address.port}`);
    console.log(`Serving uploads from ${server.uploadsDir}`);
    console.log(`Saving downloads to ${server.downloadsDir}`);
    const httpAddress = server.httpServer.address();
    console.log(`DTF app listening on http://${httpAddress.address}:${httpAddress.port}`);
    console.log("Use this machine's local WiFi IP from other devices on the same network.");
  }
}

function createHttpApp({ dataset, files, localPeer, webDistDir, logger }) {
  const sockets = new Set();
  const staticRoot = path.resolve(webDistDir ?? process.env.DTF_WEB_DIST_DIR ?? DEFAULT_WEB_DIST_DIR);
  const broadcast = (message) => {
    const body = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(body);
      }
    }
  };

  const httpServer = http.createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (!request.url) {
      sendJson(response, 405, { error: "method-not-allowed" });
      return;
    }

    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/api/download" && request.method === "POST") {
      void handleDownloadRequest({ request, response, dataset, logger });
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method-not-allowed" });
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        peer: localPeer,
        fileCount: files.length,
        peerCount: dataset.peers.length,
        uploadsDir: dataset.uploadsDir,
        downloadsDir: dataset.downloadsDir
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

    if (url.pathname === "/api/uploads") {
      sendJson(response, 200, {
        uploadsDir: dataset.uploadsDir,
        records: collectUploadFilesSync(dataset.uploadsDir).map((filePath) => ({
          name: path.relative(dataset.uploadsDir, filePath).split(path.sep).join("/"),
          path: filePath
        }))
      });
      return;
    }

    if (url.pathname === "/api/discover") {
      void handleDiscoverRequest({ url, response, localPeer, logger });
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

    void serveStaticApp({ url, response, staticRoot });
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
        peerCount: dataset.peers.length,
        uploadsDir: dataset.uploadsDir,
        downloadsDir: dataset.downloadsDir
      })
    );
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    httpServer,
    wsServer,
    broadcast
  };
}

async function serveStaticApp({ url, response, staticRoot }) {
  if (!existsSync(staticRoot)) {
    sendJson(response, 404, {
      error: "frontend-not-built",
      message: "Run npm run frontend:build before starting the app server."
    });
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = safeStaticPath(staticRoot, requestedPath);
  const candidatePath = filePath && existsSync(filePath) ? filePath : path.join(staticRoot, "index.html");

  try {
    const bytes = await readFile(candidatePath);
    response.writeHead(200, { "content-type": mediaTypeForPath(candidatePath) });
    response.end(bytes);
  } catch {
    sendJson(response, 404, { error: "not-found" });
  }
}

function safeStaticPath(staticRoot, requestPath) {
  const cleanPath = requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(staticRoot, cleanPath);
  const relative = path.relative(staticRoot, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return filePath;
}

async function handleDownloadRequest({ request, response, dataset, logger }) {
  try {
    const body = await readJsonBody(request);
    const record = body.file;

    if (!record?.fileId || !Array.isArray(record.peers) || record.peers.length === 0) {
      sendJson(response, 400, { error: "invalid-file-record" });
      return;
    }

    const socket = dgram.createSocket("udp4");
    const transport = createUdpClientTransport(socket, logger);
    const client = createDtfClient({
      localPeer: {
        peerId: DOWNLOAD_CLIENT_PEER_ID,
        name: "DTF Web Downloader",
        listenPort: 0
      },
      transport,
      discoveryAddresses: record.peers.map((peer) => peer.address).filter(Boolean),
      addressEquals,
      acceptDiscoveryResponse() {
        return true;
      }
    });

    try {
      await bindUdpClient(socket);
      socket.setBroadcast(true);
      logger.write(`Downloading ${record.name}...`);

      const chunksByPeer = new Map();
      const bytes = await client.downloadFile(record, {
        verifyIntegrity: true,
        onProgress(progress) {
          if (!progress.peer || !progress.chunk) {
            return;
          }

          const existing = chunksByPeer.get(progress.peer.peerId);
          if (existing) {
            existing.chunks += 1;
            return;
          }

          chunksByPeer.set(progress.peer.peerId, {
            name: progress.peer.name,
            chunks: 1
          });
        }
      });
      const path = await saveCompletedUpload(record, bytes, {
        downloadsDir: dataset.downloadsDir,
        uploadsDir: dataset.uploadsDir
      });
      logger.write(`Downloaded ${record.name} (${bytes.byteLength} bytes) to ${path}`);
      if (record.peers.length > 1 && chunksByPeer.size > 0) {
        const summary = [...chunksByPeer.values()]
          .map((peer) => `${peer.name} ${peer.chunks} chunk${peer.chunks === 1 ? "" : "s"}`)
          .join(", ");
        logger.write(`Chunk distribution for ${record.name}: ${summary}`);
      }

      sendJson(response, 200, {
        ok: true,
        fileId: record.fileId,
        name: record.name,
        bytes: bytes.byteLength,
        path
      });
    } finally {
      client.dispose();
      socket.close();
    }
  } catch (error) {
    logger.write(`Download failed: ${error instanceof Error ? error.message : "Download failed"}`);
    sendJson(response, 502, {
      error: "download-failed",
      message: error instanceof Error ? error.message : "Download failed"
    });
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function handleDiscoverRequest({ url, response, localPeer, logger }) {
  const page = positiveInt(url.searchParams.get("page"), 1);
  const pageSize = Math.min(positiveInt(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const discoveryAddresses = url.searchParams.has("address")
    ? [parseAddress(url.searchParams.get("address"))]
    : discoverBroadcastAddresses();
  const socket = dgram.createSocket("udp4");
  const transport = createUdpClientTransport(socket, logger);
  const client = createDtfClient({
    localPeer: {
      peerId: DOWNLOAD_CLIENT_PEER_ID,
      name: "DTF Web Discovery",
      listenPort: 0
    },
    transport,
    discoveryAddresses,
    addressEquals,
    discoveryResponseTimeoutMs: positiveInt(url.searchParams.get("timeoutMs"), 500),
    acceptDiscoveryResponse() {
      return true;
    }
  });

  try {
    await bindUdpClient(socket);
    socket.setBroadcast(true);
    logger.write(`Finding peers via broadcast ${formatAddresses(discoveryAddresses)}`);

    const discovered = await client.findAvailableFiles({
      queryKind: "all",
      maxResults: 200
    });
    const records = discovered.records
      .map((record) => ({
        ...record,
        peers: record.peers.filter((peer) => peer.peerId !== localPeer.peerId)
      }))
      .filter((record) => record.peers.length > 0);
    const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
    const currentPage = Math.min(page, pageCount);
    const start = (currentPage - 1) * pageSize;

    sendJson(response, 200, {
      page: currentPage,
      pageSize,
      pageCount,
      total: records.length,
      records: records.slice(start, start + pageSize)
    });
    logger.write(`Found ${records.length} remote file(s)`);
  } catch (error) {
    logger.write(`Peer discovery failed: ${error instanceof Error ? error.message : "Discovery failed"}`);
    sendJson(response, 502, {
      error: "discovery-failed",
      message: error instanceof Error ? error.message : "Discovery failed"
    });
  } finally {
    client.dispose();
    socket.close();
  }
}

export function discoverBroadcastAddresses(options = {}) {
  const port = positiveInt(options.port, DTF_DEFAULT_PORT);
  const interfaces = options.interfaces ?? os.networkInterfaces();
  const addresses = [];
  const seen = new Set();

  for (const details of Object.values(interfaces)) {
    for (const detail of details ?? []) {
      const broadcast = broadcastAddressForInterface(detail);

      if (!broadcast || seen.has(broadcast)) {
        continue;
      }

      seen.add(broadcast);
      addresses.push({ address: broadcast, port });
    }
  }

  return addresses.length > 0 ? addresses : [{ address: "255.255.255.255", port }];
}

function broadcastAddressForInterface(detail) {
  const family = detail.family === "IPv4" || detail.family === 4;

  if (!family || detail.internal || !detail.address || !detail.netmask) {
    return undefined;
  }

  const address = ipv4ToUint(detail.address);
  const netmask = ipv4ToUint(detail.netmask);

  if (address === undefined || netmask === undefined) {
    return undefined;
  }

  const broadcast = uintToIpv4(((address & netmask) | (~netmask >>> 0)) >>> 0);

  if (broadcast === detail.address || broadcast === "0.0.0.0" || broadcast === "255.255.255.255") {
    return undefined;
  }

  return broadcast;
}

function ipv4ToUint(value) {
  const parts = String(value).split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return undefined;
    }

    const value = Number(part);

    if (value < 0 || value > 255) {
      return undefined;
    }

    result = ((result << 8) | value) >>> 0;
  }

  return result;
}

function uintToIpv4(value) {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function formatAddresses(addresses) {
  return addresses.map((address) => `${address.address}:${address.port}`).join(", ");
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function loadDatasetFromUploadsSync(options = {}) {
  const { uploadsDir, downloadsDir } = ensureDtfFoldersSync(options);
  const localPeer = {
    peerId: normalizePeerId(options.peerId ?? process.env.DTF_PEER_ID ?? peerIdFromComputerName()),
    name: options.peerName ?? process.env.DTF_PEER_NAME ?? "DTF Folder Server",
    listenPort: options.listenPort
  };
  const files = [];
  const contents = {};

  for (const filePath of collectUploadFilesSync(uploadsDir)) {
    const bytes = new Uint8Array(readFileSync(filePath));
    const fileId = createHash("sha256").update(bytes).digest("hex");
    const name = path.relative(uploadsDir, filePath).split(path.sep).join("/");

    files.push({
      fileId,
      fileSize: bytes.byteLength,
      chunkSize: positiveInt(options.chunkSize, DEFAULT_CHUNK_SIZE),
      name,
      mediaType: mediaTypeForPath(filePath),
      tags: tagsForPath(name),
      peerIds: [localPeer.peerId]
    });
    contents[fileId] = bytes;
  }

  return { localPeer, peers: [localPeer], files, contents, uploadsDir, downloadsDir };
}

function ensureDtfFoldersSync(options = {}) {
  const uploadsDir = path.resolve(options.uploadsDir ?? process.env.DTF_UPLOADS_DIR ?? DEFAULT_UPLOADS_DIR);
  const downloadsDir = path.resolve(options.downloadsDir ?? process.env.DTF_DOWNLOADS_DIR ?? DEFAULT_DOWNLOADS_DIR);

  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });

  return { uploadsDir, downloadsDir };
}

async function saveDownloadedFile(file, bytes, options = {}) {
  const downloadsDir = path.resolve(options.downloadsDir ?? process.env.DTF_DOWNLOADS_DIR ?? DEFAULT_DOWNLOADS_DIR);

  await mkdir(downloadsDir, { recursive: true });

  const outputPath = downloadPathForFile(downloadsDir, file);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  return outputPath;
}

async function saveCompletedUpload(file, bytes, options = {}) {
  const downloadsDir = path.resolve(options.downloadsDir ?? process.env.DTF_DOWNLOADS_DIR ?? DEFAULT_DOWNLOADS_DIR);
  const uploadsDir = path.resolve(options.uploadsDir ?? process.env.DTF_UPLOADS_DIR ?? DEFAULT_UPLOADS_DIR);

  await mkdir(downloadsDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });

  const temporaryPath = downloadPathForFile(downloadsDir, file);
  const finalPath = downloadPathForFile(uploadsDir, file);

  await mkdir(path.dirname(temporaryPath), { recursive: true });
  await mkdir(path.dirname(finalPath), { recursive: true });
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, finalPath);

  return finalPath;
}

function downloadPathForFile(downloadsDir, file) {
  const safeParts = String(file.name || `${file.fileId}.bin`)
    .split(/[\\/]+/)
    .map((part) => sanitizePathPart(part))
    .filter(Boolean);
  const parts = safeParts.length > 0 ? safeParts : [`${file.fileId}.bin`];
  const filename = parts.pop();
  const parsed = path.parse(filename);
  const base = sanitizePathPart(parsed.name || "download");
  const extension = /^\.[a-zA-Z0-9]+$/.test(parsed.ext) ? parsed.ext : "";
  const outputPath = path.resolve(downloadsDir, ...parts, `${base}${extension}`);
  const relative = path.relative(downloadsDir, outputPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.join(downloadsDir, `${base}${extension}`);
  }

  return outputPath;
}

function collectUploadFilesSync(rootDir) {
  const files = [];

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectUploadFilesSync(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function mediaTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mediaTypes = {
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".zip": "application/zip"
  };

  return mediaTypes[extension] ?? "application/octet-stream";
}

function tagsForPath(relativeName) {
  const extension = path.posix.extname(relativeName).slice(1).toLowerCase();
  const directoryTags = path.posix
    .dirname(relativeName)
    .split("/")
    .filter((part) => part && part !== ".");

  return [...new Set(["upload", ...directoryTags, extension].filter(Boolean))];
}

function createUdpClientTransport(socket, logger = { write() {} }) {
  const subscribers = new Set();

  socket.on("message", (bytes, address) => {
    logDatagram(logger, "RX", bytes, address);
    for (const subscriber of subscribers) {
      subscriber({ bytes: new Uint8Array(bytes), address });
    }
  });

  return {
    send(bytes, address) {
      logDatagram(logger, "TX", bytes, address);
      socket.send(Buffer.from(bytes), address.port, address.address);
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    }
  };
}

function bindUdpClient(socket) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off("error", onError);
      resolve();
    };

    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(0, "0.0.0.0");
  });
}

function parseAddress(value) {
  const rawValue = String(value);
  const separatorIndex = rawValue.lastIndexOf(":");

  if (separatorIndex <= 0) {
    return { address: rawValue || "127.0.0.1", port: DTF_DEFAULT_PORT };
  }

  return {
    address: rawValue.slice(0, separatorIndex) || "127.0.0.1",
    port: positiveInt(rawValue.slice(separatorIndex + 1), DTF_DEFAULT_PORT)
  };
}

function addressEquals(left, right) {
  return left.address === right.address && left.port === right.port;
}

function parseDownloadCliOptions(argv) {
  const options = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--all") {
      options.all = true;
    } else if (arg === "--downloads-dir") {
      options.downloadsDir = argv[++index];
    } else if (arg === "--max-results") {
      options.maxResults = Number(argv[++index]);
    } else if (arg === "--no-verify") {
      options.verifyIntegrity = false;
    } else {
      positional.push(arg);
    }
  }

  options.address = positional[0];
  options.query = positional[1];

  return options;
}

function sanitizePathPart(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "download";
}

function normalizePeerId(value) {
  const normalized = String(value).trim().toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error("DTF peer id must be 32 hexadecimal characters");
  }

  return normalized;
}

function peerIdFromComputerName() {
  const computerName = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? process.env.USERNAME ?? "dtf-peer";
  return createHash("sha256").update(computerName).digest("hex").slice(0, 32);
}

function sessionIdFromUuid() {
  const hex = randomUUID().replace(/-/g, "").slice(0, 16);
  const sessionId = BigInt(`0x${hex}`);
  return sessionId === 0n ? 1n : sessionId;
}

function randomAdultPeerName() {
  const firstNames = [
    "Amber",
    "Anastasia",
    "Aria",
    "Aurora",
    "Bella",
    "Bianca",
    "Carmen",
    "Dante",
    "Diamond",
    "Electra",
    "Jade",
    "Jasmine",
    "Lola",
    "Lucia",
    "Max",
    "Raven",
    "Rocco",
    "Ruby",
    "Sasha",
    "Scarlett",
    "Sienna",
    "Stella",
    "Valentina",
    "Viktor",
    "Violet"
  ];
  const lastNames = [
    "Blaze",
    "Dare",
    "Devine",
    "Fever",
    "Foxx",
    "Lust",
    "Moreau",
    "Nights",
    "Nova",
    "Raine",
    "Ryder",
    "Sinclair",
    "Sinz",
    "Starr",
    "Steele",
    "Stone",
    "Storm",
    "Valentine",
    "Velvet",
    "Vixen",
    "Wilde",
    "X"
  ];

  return `${randomChoice(firstNames)} ${randomChoice(lastNames)}`;
}

function randomChoice(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createServerLogger() {
  return {
    write(line) {
      console.log(line);
    }
  };
}

function logDatagram(logger, direction, bytes, address) {
  const packet = decodeDtfPacket(bytes);

  if (!packet) {
    logger.write(`${direction} INVALID ${address.address}:${address.port}`);
    return;
  }

  logger.write(
    `${direction} ${messageTypeName(packet.type)} ${address.address}:${address.port} ` +
      `request_id=${packet.requestId.toString(16).padStart(16, "0")} ` +
      `session_id=${packet.sessionId.toString(16).padStart(16, "0")}${messageLogDetail(packet)}`
  );
}

function messageTypeName(type) {
  return DtfMessageType[type] ?? `UNKNOWN_0x${type.toString(16).padStart(2, "0")}`;
}

function messageLogDetail(packet) {
  const payload = packet.payload;

  if (packet.type === DtfMessageType.GetRange) {
    return ` range=${payload.fromOffset}:${payload.toOffset} file_id=${shortId(payload.fileId)}`;
  }

  if (packet.type === DtfMessageType.RangeData) {
    return ` offset=${payload.dataOffset} len=${payload.data.byteLength} file_id=${shortId(payload.fileId)}`;
  }

  if (packet.type === DtfMessageType.RangeDone) {
    return ` sent=${payload.sentBytes} file_id=${shortId(payload.fileId)}`;
  }

  if (packet.type === DtfMessageType.Files) {
    return ` records=${payload.records.length} total=${payload.totalMatches}`;
  }

  if (packet.type === DtfMessageType.FindFiles) {
    return ` query_kind=${payload.queryKind} max_results=${payload.maxResults}`;
  }

  if (packet.type === DtfMessageType.Error) {
    return ` error=${payload.errorCode} detail=${payload.detail}`;
  }

  return "";
}

function shortId(value) {
  return String(value).slice(0, 16);
}
