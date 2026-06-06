import dgram from "node:dgram";
import assert from "node:assert/strict";
import {
  DTF_DEFAULT_MAX_DATAGRAM,
  MessageType,
  QueryKind,
  createRequestId,
  decodeDatagram,
  decodeFiles,
  decodeRangeData,
  decodeRangeDone,
  encodeDatagram
} from "./protocol.js";
import { startDtfServer } from "./server.js";

const CLIENT_PEER_ID = "22222222222222222222222222222222";

const serverRun = await startDtfServer({ host: "127.0.0.1", port: 0 });
const client = dgram.createSocket("udp4");

try {
  await bind(client);
  const target = serverRun.address;

  const filesResponse = await roundTrip(client, target, {
    type: MessageType.FIND_FILES,
    payload: Buffer.concat([Buffer.from([QueryKind.all]), u16(10), u16(0)])
  });
  assert.equal(filesResponse.type, MessageType.FILES);
  const files = decodeFiles(filesResponse.payload);
  assert.equal(files.records.length, 3);

  const helloResponse = await roundTrip(client, target, {
    type: MessageType.HELLO,
    payload: Buffer.concat([u16(client.address().port), stringBytes("Smoke Client")])
  });
  assert.equal(helloResponse.type, MessageType.HELLO_ACK);
  assert.notEqual(helloResponse.sessionId, 0n);

  const firstFile = files.records[0];
  const rangeRequestId = createRequestId();
  const rangeRequest = encodeDatagram({
    type: MessageType.GET_RANGE,
    requestId: rangeRequestId,
    sessionId: helloResponse.sessionId,
    senderId: CLIENT_PEER_ID,
    payload: Buffer.concat([
      Buffer.from(firstFile.fileId, "hex"),
      u64(0),
      u64(128),
      u16(DTF_DEFAULT_MAX_DATAGRAM)
    ])
  });

  client.send(rangeRequest, target.port, target.address);
  const rangeMessages = await collectRange(client, rangeRequestId);
  const dataMessage = rangeMessages.find((message) => message.type === MessageType.RANGE_DATA);
  const doneMessage = rangeMessages.find((message) => message.type === MessageType.RANGE_DONE);
  assert.ok(dataMessage);
  assert.ok(doneMessage);
  assert.equal(decodeRangeData(dataMessage.payload).data.byteLength, 128);
  assert.equal(decodeRangeDone(doneMessage.payload).sentBytes, 128);

  console.log("DTF UDP server smoke test passed");
} finally {
  client.close();
  await serverRun.server.close();
}

function bind(socket) {
  return new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
}

function roundTrip(socket, target, { type, payload }) {
  const requestId = createRequestId();
  const packet = encodeDatagram({
    type,
    requestId,
    senderId: CLIENT_PEER_ID,
    payload
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for response to ${type}`));
    }, 1000);

    function onMessage(datagram) {
      const message = decodeDatagram(datagram);
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
      const message = decodeDatagram(datagram);
      if (!message || message.requestId !== requestId) {
        return;
      }

      messages.push(message);

      if (message.type === MessageType.RANGE_DONE) {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        resolve(messages);
      }
    }

    socket.on("message", onMessage);
  });
}

function stringBytes(value) {
  const bytes = Buffer.from(new TextEncoder().encode(value));
  return Buffer.concat([u16(bytes.byteLength), bytes]);
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}
