import dgram from "node:dgram";
import { pathToFileURL } from "node:url";
import { mockDtfDataset } from "../dist/mock-data.js";
import {
  DTF_DEFAULT_MAX_DATAGRAM,
  DTF_DEFAULT_PORT,
  DTF_HEADER_LENGTH,
  ErrorCode,
  MessageType,
  QueryKind,
  decodeCancel,
  decodeDatagram,
  decodeFindFiles,
  decodeGetRange,
  decodeHello,
  encodeDatagram,
  encodeError,
  encodeFiles,
  encodeHelloAck,
  encodeRangeData,
  encodeRangeDone
} from "./protocol.js";

const RANGE_DATA_FIXED_PAYLOAD_LENGTH = 32 + 8 + 8 + 8 + 2 + 4;

export function createDtfServer(options = {}) {
  const dataset = options.dataset ?? mockDtfDataset;
  const peerId = options.peerId ?? dataset.localPeer.peerId;
  const peerName = options.peerName ?? process.env.DTF_PEER_NAME ?? "DTF Mock Server";
  const listenPort = Number(options.port ?? process.env.DTF_PORT ?? DTF_DEFAULT_PORT);
  const host = options.host ?? process.env.DTF_HOST ?? "0.0.0.0";
  const socket = dgram.createSocket("udp4");
  const sessions = new Map();
  const cancelledRequestIds = new Set();
  let sessionCounter = 1n;

  const peersById = new Map(dataset.peers.map((peer) => [peer.peerId, peer]));
  const contentsByFileId = new Map(Object.entries(dataset.contents));
  const files = dataset.files.map((file) => ({
    ...file,
    peers: file.peerIds.map((id) => peersById.get(id)).filter(Boolean)
  }));
  const filesById = new Map(files.map((file) => [file.fileId, file]));

  function send(remote, packet) {
    socket.send(packet, remote.port, remote.address);
  }

  function respond(remote, message, type, payload, sessionId = message.sessionId) {
    send(
      remote,
      encodeDatagram({
        type,
        requestId: message.requestId,
        sessionId,
        senderId: peerId,
        payload
      })
    );
  }

  function respondError(remote, message, errorCode, detail) {
    respond(remote, message, MessageType.ERROR, encodeError({ errorCode, detail }));
  }

  function handleHello(remote, message) {
    const request = decodeHello(message.payload);
    const sessionId = sessionCounter;
    sessionCounter += 1n;
    sessions.set(sessionKey(message.senderId, sessionId), {
      remotePeerId: message.senderId,
      remoteName: request.name,
      remoteListenPort: request.listenPort,
      remoteAddress: remote.address
    });

    respond(
      remote,
      message,
      MessageType.HELLO_ACK,
      encodeHelloAck({ listenPort, name: peerName }),
      sessionId
    );
  }

  function handleFindFiles(remote, message) {
    const request = decodeFindFiles(message.payload);

    if (!request.queryKind) {
      respondError(remote, message, ErrorCode.unsupportedQuery, "Unsupported query kind");
      return;
    }

    const matches = findFiles(files, request);
    const maxResults = request.maxResults > 0 ? request.maxResults : matches.length;
    const records = matches.slice(0, maxResults);
    respond(remote, message, MessageType.FILES, encodeFiles({ totalMatches: matches.length, records }));
  }

  function handleGetRange(remote, message) {
    if (message.sessionId === 0n || !sessions.has(sessionKey(message.senderId, message.sessionId))) {
      respondError(remote, message, ErrorCode.unknownSession, "Unknown session");
      return;
    }

    const request = decodeGetRange(message.payload);
    const file = filesById.get(request.fileId);
    const content = contentsByFileId.get(request.fileId);

    if (!file || !content) {
      respondError(remote, message, ErrorCode.fileNotFound, `Unknown file: ${request.fileId}`);
      return;
    }

    if (!isValidRange(file.fileSize, request.fromOffset, request.toOffset)) {
      respondError(remote, message, ErrorCode.invalidRange, "Invalid byte range");
      return;
    }

    const maxDatagram = request.maxDatagram > 0 ? request.maxDatagram : DTF_DEFAULT_MAX_DATAGRAM;
    const maxDataBytes = maxDatagram - DTF_HEADER_LENGTH - RANGE_DATA_FIXED_PAYLOAD_LENGTH;

    if (maxDataBytes <= 0) {
      respondError(remote, message, ErrorCode.rangeTooLarge, "max_datagram is too small");
      return;
    }

    let sentBytes = 0;

    for (let offset = request.fromOffset; offset < request.toOffset; offset += maxDataBytes) {
      if (cancelledRequestIds.has(message.requestId.toString())) {
        return;
      }

      const end = Math.min(offset + maxDataBytes, request.toOffset);
      const data = content.subarray(offset, end);
      respond(
        remote,
        message,
        MessageType.RANGE_DATA,
        encodeRangeData({
          fileId: request.fileId,
          requestedFrom: request.fromOffset,
          requestedTo: request.toOffset,
          dataOffset: offset,
          data
        })
      );
      sentBytes += data.byteLength;
    }

    respond(
      remote,
      message,
      MessageType.RANGE_DONE,
      encodeRangeDone({
        fileId: request.fileId,
        requestedFrom: request.fromOffset,
        requestedTo: request.toOffset,
        sentBytes
      })
    );
  }

  function handleCancel(message) {
    const request = decodeCancel(message.payload);
    cancelledRequestIds.add(request.cancelledRequestId.toString());
  }

  socket.on("message", (datagram, remote) => {
    const message = decodeDatagram(datagram);

    if (!message) {
      return;
    }

    try {
      switch (message.type) {
        case MessageType.HELLO:
          handleHello(remote, message);
          break;
        case MessageType.FIND_FILES:
          handleFindFiles(remote, message);
          break;
        case MessageType.GET_RANGE:
          handleGetRange(remote, message);
          break;
        case MessageType.CANCEL:
          handleCancel(message);
          break;
        default:
          break;
      }
    } catch (error) {
      respondError(remote, message, ErrorCode.malformedMessage, error instanceof Error ? error.message : "Malformed message");
    }
  });

  return {
    socket,
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
      return new Promise((resolve) => socket.close(resolve));
    }
  };
}

export async function startDtfServer(options = {}) {
  const server = createDtfServer(options);
  const address = await server.start();
  return { server, address };
}

function findFiles(files, request) {
  const query = request.query.trim().toLowerCase();

  if (request.queryKind === "all") {
    return files;
  }

  if (request.queryKind === "name") {
    return files.filter((file) => file.name.toLowerCase().includes(query));
  }

  if (request.queryKind === "fileId") {
    return files.filter((file) => file.fileId === query);
  }

  if (request.queryKind === "tag") {
    return files.filter((file) => file.tags.some((tag) => tag.toLowerCase() === query));
  }

  return [];
}

function isValidRange(fileSize, fromOffset, toOffset) {
  return (
    Number.isSafeInteger(fromOffset) &&
    Number.isSafeInteger(toOffset) &&
    fromOffset >= 0 &&
    toOffset > fromOffset &&
    toOffset <= fileSize
  );
}

function sessionKey(peerId, sessionId) {
  return `${peerId}:${sessionId.toString()}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { address } = await startDtfServer();
  console.log(`DTF mock UDP server listening on ${address.address}:${address.port}`);
  console.log("Use this machine's local WiFi IP from other devices on the same network.");
}
