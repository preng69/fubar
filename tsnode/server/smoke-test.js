import dgram from "node:dgram";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDtfPacket,
  decodeDtfPacket,
  encodeDtfPacket
} from "../dist/codec.js";
import { randomRequestId } from "../dist/ids.js";
import {
  DTF_DEFAULT_MAX_DATAGRAM,
  DtfMessageType,
  DtfQueryKindCode
} from "../dist/types.js";
import { downloadFromDtfServer, startDtfServer } from "./server.js";

const CLIENT_PEER_ID = "22222222222222222222222222222222";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dtf-folders-"));
const uploadsDir = path.join(tempRoot, "uploads");
const downloadsDir = path.join(tempRoot, "downloads");
const firstUploadBytes = new TextEncoder().encode("Folder-backed DTF smoke upload.\n".repeat(8));

await mkdir(uploadsDir, { recursive: true });
await mkdir(path.join(uploadsDir, "docs"), { recursive: true });
await writeFile(path.join(uploadsDir, "docs", "folder-handbook.txt"), firstUploadBytes);
await writeFile(path.join(uploadsDir, "tiny-index.json"), new TextEncoder().encode('{"from":"uploads"}\n'));

const serverRun = await startDtfServer({
  host: "127.0.0.1",
  port: 0,
  httpHost: "127.0.0.1",
  httpPort: 0,
  uploadsDir,
  downloadsDir
});
const client = dgram.createSocket("udp4");

try {
  await bind(client);
  const target = serverRun.address;

  const filesResponse = await roundTrip(client, target, {
    type: DtfMessageType.FindFiles,
    payload: {
      queryKind: DtfQueryKindCode.All,
      maxResults: 10,
      query: ""
    }
  });
  assert.equal(filesResponse.type, DtfMessageType.Files);
  assert.equal(filesResponse.payload.records.length, 2);

  const helloResponse = await roundTrip(client, target, {
    type: DtfMessageType.Hello,
    payload: {
      listenPort: client.address().port,
      name: "Smoke Client"
    }
  });
  assert.equal(helloResponse.type, DtfMessageType.HelloAck);
  assert.notEqual(helloResponse.sessionId, 0n);

  const firstFile = filesResponse.payload.records[0];
  assert.equal(firstFile.name, "docs/folder-handbook.txt");
  const rangeRequestId = randomRequestId();
  const rangeLength = BigInt(firstUploadBytes.byteLength);
  const rangeRequest = encodeDtfPacket(
    createDtfPacket(
      {
        type: DtfMessageType.GetRange,
        requestId: rangeRequestId,
        sessionId: helloResponse.sessionId,
        senderId: CLIENT_PEER_ID
      },
      {
        fileId: firstFile.fileId,
        fromOffset: 0n,
        toOffset: rangeLength,
        maxDatagram: DTF_DEFAULT_MAX_DATAGRAM
      }
    )
  );

  client.send(rangeRequest, target.port, target.address);
  const rangeMessages = await collectRange(client, rangeRequestId);
  const dataMessage = rangeMessages.find((message) => message.type === DtfMessageType.RangeData);
  const doneMessage = rangeMessages.find((message) => message.type === DtfMessageType.RangeDone);
  assert.ok(dataMessage);
  assert.ok(doneMessage);
  assert.equal(dataMessage.payload.data.byteLength, firstUploadBytes.byteLength);
  assert.equal(doneMessage.payload.sentBytes, rangeLength);

  const downloadResult = await downloadFromDtfServer({
    address: `${target.address}:${target.port}`,
    query: "folder-handbook",
    downloadsDir
  });
  assert.equal(downloadResult.downloads.length, 1);
  assert.deepEqual(await readFile(downloadResult.downloads[0].path), Buffer.from(firstUploadBytes));

  console.log("DTF UDP server smoke test passed");
} finally {
  client.close();
  await serverRun.server.close();
  await rm(tempRoot, { recursive: true, force: true });
}

function bind(socket) {
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
    socket.bind(0, "127.0.0.1");
  });
}

function roundTrip(socket, target, { type, payload }) {
  const requestId = randomRequestId();
  const packet = encodeDtfPacket(
    createDtfPacket(
      {
        type,
        requestId,
        sessionId: 0n,
        senderId: CLIENT_PEER_ID
      },
      payload
    )
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for response to ${type}`));
    }, 1000);

    function onMessage(datagram) {
      const message = decodeDtfPacket(datagram);
      if (!message || message.requestId !== requestId) {
        return;
      }

      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    }

    socket.on("message", onMessage);
    socket.send(packet, target.port, target.address);
  });
}

function collectRange(socket, requestId) {
  const messages = [];

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for range data"));
    }, 1000);

    function onMessage(datagram) {
      const message = decodeDtfPacket(datagram);
      if (!message || message.requestId !== requestId) {
        return;
      }

      messages.push(message);

      if (message.type === DtfMessageType.RangeDone) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(messages);
      }
    }

    socket.on("message", onMessage);
  });
}
