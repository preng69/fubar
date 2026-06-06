import dgram from "node:dgram";
import assert from "node:assert/strict";
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
import { startDtfServer } from "./server.js";

const CLIENT_PEER_ID = "22222222222222222222222222222222";

const serverRun = await startDtfServer({ host: "127.0.0.1", port: 0, httpHost: "127.0.0.1", httpPort: 0 });
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
  assert.equal(filesResponse.payload.records.length, 3);

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
  const rangeRequestId = randomRequestId();
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
        toOffset: 128n,
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
  assert.equal(dataMessage.payload.data.byteLength, 128);
  assert.equal(doneMessage.payload.sentBytes, 128n);

  console.log("DTF UDP server smoke test passed");
} finally {
  client.close();
  await serverRun.server.close();
}

function bind(socket) {
  return new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
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
