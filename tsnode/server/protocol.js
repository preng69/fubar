export const DTF_MAGIC = "DTF1";
export const DTF_VERSION = 1;
export const DTF_HEADER_LENGTH = 44;
export const DTF_DEFAULT_PORT = 4747;
export const DTF_DEFAULT_MAX_DATAGRAM = 1200;

export const MessageType = Object.freeze({
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  FIND_FILES: 0x10,
  FILES: 0x11,
  GET_RANGE: 0x20,
  RANGE_DATA: 0x21,
  RANGE_DONE: 0x22,
  CANCEL: 0x30,
  ERROR: 0x40
});

export const QueryKind = Object.freeze({
  all: 0,
  name: 1,
  fileId: 2,
  tag: 3
});

export const ErrorCode = Object.freeze({
  malformedMessage: 1,
  unsupportedVersion: 2,
  unknownSession: 3,
  fileNotFound: 4,
  invalidRange: 5,
  rangeTooLarge: 6,
  temporarilyUnavailable: 7,
  unsupportedQuery: 8
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function decodeDatagram(datagram) {
  if (datagram.byteLength < DTF_HEADER_LENGTH) {
    return undefined;
  }

  if (datagram.subarray(0, 4).toString("ascii") !== DTF_MAGIC) {
    return undefined;
  }

  const version = datagram.readUInt8(4);
  const type = datagram.readUInt8(5);
  const flags = datagram.readUInt16BE(6);
  const headerLength = datagram.readUInt16BE(8);
  const payloadLength = datagram.readUInt16BE(10);

  if (version !== DTF_VERSION || headerLength < DTF_HEADER_LENGTH) {
    return undefined;
  }

  if (datagram.byteLength !== headerLength + payloadLength) {
    return undefined;
  }

  return {
    version,
    type,
    flags,
    requestId: datagram.readBigUInt64BE(12),
    sessionId: datagram.readBigUInt64BE(20),
    senderId: datagram.subarray(28, 44).toString("hex"),
    payload: datagram.subarray(headerLength)
  };
}

export function encodeDatagram({ type, requestId, sessionId = 0n, senderId, payload = Buffer.alloc(0), flags = 0 }) {
  const header = Buffer.alloc(DTF_HEADER_LENGTH);
  header.write(DTF_MAGIC, 0, "ascii");
  header.writeUInt8(DTF_VERSION, 4);
  header.writeUInt8(type, 5);
  header.writeUInt16BE(flags, 6);
  header.writeUInt16BE(DTF_HEADER_LENGTH, 8);
  header.writeUInt16BE(payload.byteLength, 10);
  header.writeBigUInt64BE(toU64(requestId), 12);
  header.writeBigUInt64BE(toU64(sessionId), 20);
  hexToBytes(senderId, 16).copy(header, 28);
  return Buffer.concat([header, payload]);
}

export function decodeHello(payload) {
  const reader = createReader(payload);
  return {
    listenPort: reader.u16(),
    name: reader.string()
  };
}

export function encodeHelloAck({ listenPort, name }) {
  return concatParts([u16(listenPort), stringBytes(name)]);
}

export function decodeFindFiles(payload) {
  const reader = createReader(payload);
  const queryKindValue = reader.u8();
  const queryKind = Object.entries(QueryKind).find(([, value]) => value === queryKindValue)?.[0];
  return {
    queryKind,
    maxResults: reader.u16(),
    query: reader.string()
  };
}

export function encodeFiles({ totalMatches, records }) {
  return concatParts([
    u32(totalMatches),
    u16(records.length),
    ...records.map((record) =>
      concatParts([
        hexToBytes(record.fileId, 32),
        u64(record.fileSize),
        u32(record.chunkSize),
        stringBytes(record.name),
        stringBytes(record.mediaType),
        u16(record.tags.length),
        ...record.tags.map(stringBytes)
      ])
    )
  ]);
}

export function decodeGetRange(payload) {
  const reader = createReader(payload);
  return {
    fileId: reader.bytes(32).toString("hex"),
    fromOffset: Number(reader.u64()),
    toOffset: Number(reader.u64()),
    maxDatagram: reader.u16()
  };
}

export function encodeRangeData({ fileId, requestedFrom, requestedTo, dataOffset, data }) {
  return concatParts([
    hexToBytes(fileId, 32),
    u64(requestedFrom),
    u64(requestedTo),
    u64(dataOffset),
    u16(data.byteLength),
    u32(crc32(data)),
    Buffer.from(data)
  ]);
}

export function encodeRangeDone({ fileId, requestedFrom, requestedTo, sentBytes }) {
  return concatParts([
    hexToBytes(fileId, 32),
    u64(requestedFrom),
    u64(requestedTo),
    u64(sentBytes)
  ]);
}

export function decodeCancel(payload) {
  const reader = createReader(payload);
  return {
    cancelledRequestId: reader.u64(),
    fileId: reader.bytes(32).toString("hex")
  };
}

export function encodeError({ errorCode, detail }) {
  return concatParts([u16(errorCode), stringBytes(detail)]);
}

export function decodeFiles(payload) {
  const reader = createReader(payload);
  const totalMatches = reader.u32();
  const recordCount = reader.u16();
  const records = [];

  for (let index = 0; index < recordCount; index += 1) {
    const fileId = reader.bytes(32).toString("hex");
    const fileSize = Number(reader.u64());
    const chunkSize = reader.u32();
    const name = reader.string();
    const mediaType = reader.string();
    const tagCount = reader.u16();
    const tags = [];

    for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
      tags.push(reader.string());
    }

    records.push({ fileId, fileSize, chunkSize, name, mediaType, tags });
  }

  return { totalMatches, records };
}

export function decodeRangeData(payload) {
  const reader = createReader(payload);
  const fileId = reader.bytes(32).toString("hex");
  const requestedFrom = Number(reader.u64());
  const requestedTo = Number(reader.u64());
  const dataOffset = Number(reader.u64());
  const dataLength = reader.u16();
  const dataCrc32 = reader.u32();
  const data = reader.bytes(dataLength);
  return { fileId, requestedFrom, requestedTo, dataOffset, dataCrc32, data };
}

export function decodeRangeDone(payload) {
  const reader = createReader(payload);
  return {
    fileId: reader.bytes(32).toString("hex"),
    requestedFrom: Number(reader.u64()),
    requestedTo: Number(reader.u64()),
    sentBytes: Number(reader.u64())
  };
}

export function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function createRequestId() {
  return BigInt.asUintN(64, BigInt(Date.now()) << 20n ^ BigInt(Math.floor(Math.random() * 0xfffff)));
}

function createReader(buffer) {
  let offset = 0;

  function take(length) {
    if (offset + length > buffer.byteLength) {
      throw new Error("Payload ended unexpectedly");
    }

    const value = buffer.subarray(offset, offset + length);
    offset += length;
    return value;
  }

  return {
    u8() {
      return take(1).readUInt8(0);
    },
    u16() {
      return take(2).readUInt16BE(0);
    },
    u32() {
      return take(4).readUInt32BE(0);
    },
    u64() {
      return take(8).readBigUInt64BE(0);
    },
    bytes(length) {
      return take(length);
    },
    string() {
      const length = this.u16();
      return textDecoder.decode(take(length));
    }
  };
}

function concatParts(parts) {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function stringBytes(value) {
  const bytes = Buffer.from(textEncoder.encode(value ?? ""));
  return concatParts([u16(bytes.byteLength), bytes]);
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(toU64(value));
  return buffer;
}

function toU64(value) {
  if (typeof value === "bigint") {
    return BigInt.asUintN(64, value);
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid u64 value: ${value}`);
  }

  return BigInt(value);
}

function hexToBytes(value, byteLength) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length !== byteLength * 2) {
    throw new Error(`Expected ${byteLength} bytes as hex`);
  }

  return Buffer.from(value, "hex");
}
