import { crc32 } from "./checksum.js";
import { bytesToFileId, bytesToPeerId, fileIdToBytes, peerIdToBytes, assertU64 } from "./ids.js";
import {
  DTF_HEADER_LENGTH,
  DTF_MAGIC,
  DTF_VERSION,
  DtfFileRecord,
  DtfMessageType,
  DtfPacket,
  DtfPacketHeader,
  DtfQueryKindCode,
  DtfWireErrorCode
} from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const knownMessageTypes = new Set<number>(Object.values(DtfMessageType).filter((value) => typeof value === "number"));

export function encodeDtfPacket(packet: DtfPacket): Uint8Array {
  const payload = encodePayload(packet);

  if (payload.byteLength > 0xffff) {
    throw new Error(`DTF payload is too large: ${payload.byteLength} bytes`);
  }

  const bytes = new Uint8Array(DTF_HEADER_LENGTH + payload.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(textEncoder.encode(DTF_MAGIC), 0);
  view.setUint8(4, DTF_VERSION);
  view.setUint8(5, packet.type);
  view.setUint16(6, packet.flags, false);
  view.setUint16(8, DTF_HEADER_LENGTH, false);
  view.setUint16(10, payload.byteLength, false);
  setU64(view, 12, packet.requestId);
  setU64(view, 20, packet.sessionId);
  bytes.set(peerIdToBytes(packet.senderId), 28);
  bytes.set(payload, DTF_HEADER_LENGTH);
  return bytes;
}

export function decodeDtfPacket(bytes: Uint8Array): DtfPacket | undefined {
  if (bytes.byteLength < DTF_HEADER_LENGTH) {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = textDecoder.decode(bytes.slice(0, 4));

  if (magic !== DTF_MAGIC || view.getUint8(4) !== DTF_VERSION) {
    return undefined;
  }

  const type = view.getUint8(5);

  if (!knownMessageTypes.has(type)) {
    return undefined;
  }

  const headerLength = view.getUint16(8, false);
  const payloadLength = view.getUint16(10, false);

  if (headerLength < DTF_HEADER_LENGTH || bytes.byteLength !== headerLength + payloadLength) {
    return undefined;
  }

  try {
    const header: DtfPacketHeader = {
      type,
      flags: view.getUint16(6, false),
      headerLength,
      payloadLength,
      requestId: getU64(view, 12),
      sessionId: getU64(view, 20),
      senderId: bytesToPeerId(bytes.slice(28, 44))
    };
    const payloadBytes = bytes.slice(headerLength);
    return decodePayload(header, payloadBytes);
  } catch {
    return undefined;
  }
}

export function createDtfPacket(
  header: Pick<DtfPacketHeader, "type" | "requestId" | "sessionId" | "senderId"> &
    Partial<Pick<DtfPacketHeader, "flags">>,
  payload: DtfPacket["payload"]
): DtfPacket {
  const payloadLength = encodedPayloadLength(header.type, payload);
  return {
    ...header,
    flags: header.flags ?? 0,
    headerLength: DTF_HEADER_LENGTH,
    payloadLength,
    payload
  } as DtfPacket;
}

export function dtfQueryKindToCode(kind: string | undefined): DtfQueryKindCode {
  if (!kind || kind === "all") {
    return DtfQueryKindCode.All;
  }

  if (kind === "name") {
    return DtfQueryKindCode.Name;
  }

  if (kind === "fileId") {
    return DtfQueryKindCode.FileId;
  }

  if (kind === "tag") {
    return DtfQueryKindCode.Tag;
  }

  throw new Error(`Unsupported query kind: ${kind}`);
}

export function dtfQueryCodeToKind(code: DtfQueryKindCode): "all" | "name" | "fileId" | "tag" {
  switch (code) {
    case DtfQueryKindCode.All:
      return "all";
    case DtfQueryKindCode.Name:
      return "name";
    case DtfQueryKindCode.FileId:
      return "fileId";
    case DtfQueryKindCode.Tag:
      return "tag";
  }
}

export function wireErrorCodeToDtfCode(code: DtfWireErrorCode): string {
  switch (code) {
    case DtfWireErrorCode.MalformedMessage:
      return "malformed-message";
    case DtfWireErrorCode.UnsupportedVersion:
      return "unsupported-version";
    case DtfWireErrorCode.UnknownSession:
      return "unknown-session";
    case DtfWireErrorCode.FileNotFound:
      return "file-not-found";
    case DtfWireErrorCode.InvalidRange:
      return "invalid-range";
    case DtfWireErrorCode.RangeTooLarge:
      return "range-too-large";
    case DtfWireErrorCode.TemporarilyUnavailable:
      return "temporarily-unavailable";
    case DtfWireErrorCode.UnsupportedQuery:
      return "unsupported-query";
  }
}

export function createRangeDataPayload(input: {
  fileId: string;
  requestedFrom: bigint;
  requestedTo: bigint;
  dataOffset: bigint;
  data: Uint8Array;
}) {
  return {
    ...input,
    dataCrc32: crc32(input.data)
  };
}

function encodePayload(packet: DtfPacket): Uint8Array {
  const writer = new DtfWriter();

  switch (packet.type) {
    case DtfMessageType.Hello:
    case DtfMessageType.HelloAck:
      writer.u16(packet.payload.listenPort);
      writer.string(packet.payload.name);
      break;
    case DtfMessageType.FindFiles:
      writer.u8(packet.payload.queryKind);
      writer.u16(packet.payload.maxResults);
      writer.string(packet.payload.query);
      break;
    case DtfMessageType.Files:
      writer.u32(packet.payload.totalMatches);
      writer.u16(packet.payload.records.length);
      for (const record of packet.payload.records) {
        writeFileRecord(writer, record);
      }
      break;
    case DtfMessageType.GetRange:
      writer.bytes(fileIdToBytes(packet.payload.fileId));
      writer.u64(packet.payload.fromOffset);
      writer.u64(packet.payload.toOffset);
      writer.u16(packet.payload.maxDatagram);
      break;
    case DtfMessageType.RangeData:
      writer.bytes(fileIdToBytes(packet.payload.fileId));
      writer.u64(packet.payload.requestedFrom);
      writer.u64(packet.payload.requestedTo);
      writer.u64(packet.payload.dataOffset);
      writer.u16(packet.payload.data.byteLength);
      writer.u32(packet.payload.dataCrc32);
      writer.bytes(packet.payload.data);
      break;
    case DtfMessageType.RangeDone:
      writer.bytes(fileIdToBytes(packet.payload.fileId));
      writer.u64(packet.payload.requestedFrom);
      writer.u64(packet.payload.requestedTo);
      writer.u64(packet.payload.sentBytes);
      break;
    case DtfMessageType.Cancel:
      writer.u64(packet.payload.cancelledRequestId);
      writer.bytes(fileIdToBytes(packet.payload.fileId));
      break;
    case DtfMessageType.Error:
      writer.u16(packet.payload.errorCode);
      writer.string(packet.payload.detail);
      break;
  }

  return writer.toBytes();
}

function encodedPayloadLength(type: DtfMessageType, payload: DtfPacket["payload"]): number {
  return encodePayload({ type, flags: 0, headerLength: DTF_HEADER_LENGTH, payloadLength: 0, requestId: 0n, sessionId: 0n, senderId: "00000000000000000000000000000000", payload } as DtfPacket).byteLength;
}

function decodePayload(header: DtfPacketHeader, bytes: Uint8Array): DtfPacket | undefined {
  const reader = new DtfReader(bytes);
  let payload: DtfPacket["payload"];

  switch (header.type) {
    case DtfMessageType.Hello:
    case DtfMessageType.HelloAck:
      payload = {
        listenPort: reader.u16(),
        name: reader.string()
      };
      break;
    case DtfMessageType.FindFiles:
      payload = {
        queryKind: reader.u8(),
        maxResults: reader.u16(),
        query: reader.string()
      };
      break;
    case DtfMessageType.Files: {
      const totalMatches = reader.u32();
      const recordCount = reader.u16();
      const records: Array<Omit<DtfFileRecord, "peers">> = [];

      for (let index = 0; index < recordCount; index += 1) {
        records.push(readFileRecord(reader));
      }

      payload = { totalMatches, records };
      break;
    }
    case DtfMessageType.GetRange:
      payload = {
        fileId: bytesToFileId(reader.bytes(32)),
        fromOffset: reader.u64(),
        toOffset: reader.u64(),
        maxDatagram: reader.u16()
      };
      break;
    case DtfMessageType.RangeData: {
      const fileId = bytesToFileId(reader.bytes(32));
      const requestedFrom = reader.u64();
      const requestedTo = reader.u64();
      const dataOffset = reader.u64();
      const dataLen = reader.u16();
      const dataCrc32 = reader.u32();
      const data = reader.bytes(dataLen);
      payload = { fileId, requestedFrom, requestedTo, dataOffset, dataCrc32, data };
      break;
    }
    case DtfMessageType.RangeDone:
      payload = {
        fileId: bytesToFileId(reader.bytes(32)),
        requestedFrom: reader.u64(),
        requestedTo: reader.u64(),
        sentBytes: reader.u64()
      };
      break;
    case DtfMessageType.Cancel:
      payload = {
        cancelledRequestId: reader.u64(),
        fileId: bytesToFileId(reader.bytes(32))
      };
      break;
    case DtfMessageType.Error:
      payload = {
        errorCode: reader.u16(),
        detail: reader.string()
      };
      break;
  }

  if (!reader.done()) {
    return undefined;
  }

  return { ...header, payload } as DtfPacket;
}

function writeFileRecord(writer: DtfWriter, record: Omit<DtfFileRecord, "peers">): void {
  writer.bytes(fileIdToBytes(record.fileId));
  writer.u64(BigInt(record.fileSize));
  writer.u32(record.chunkSize);
  writer.string(record.name);
  writer.string(record.mediaType);
  writer.u16(record.tags.length);

  for (const tag of record.tags) {
    writer.string(tag);
  }
}

function readFileRecord(reader: DtfReader): Omit<DtfFileRecord, "peers"> {
  const fileId = bytesToFileId(reader.bytes(32));
  const fileSize = Number(reader.u64());
  const chunkSize = reader.u32();
  const name = reader.string();
  const mediaType = reader.string();
  const tagCount = reader.u16();
  const tags: string[] = [];

  for (let index = 0; index < tagCount; index += 1) {
    tags.push(reader.string());
  }

  return { fileId, fileSize, chunkSize, name, mediaType, tags };
}

function getU64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, false);
}

function setU64(view: DataView, offset: number, value: bigint): void {
  assertU64(value, "u64 field");
  view.setBigUint64(offset, value, false);
}

class DtfWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  u8(value: number): void {
    this.fixed(1, (view) => view.setUint8(0, value));
  }

  u16(value: number): void {
    this.fixed(2, (view) => view.setUint16(0, value, false));
  }

  u32(value: number): void {
    this.fixed(4, (view) => view.setUint32(0, value, false));
  }

  u64(value: bigint): void {
    this.fixed(8, (view) => setU64(view, 0, value));
  }

  string(value: string): void {
    const bytes = textEncoder.encode(value);

    if (bytes.byteLength > 0xffff) {
      throw new Error(`DTF string is too long: ${bytes.byteLength} bytes`);
    }

    this.u16(bytes.byteLength);
    this.bytes(bytes);
  }

  bytes(value: Uint8Array): void {
    const copy = new Uint8Array(value);
    this.chunks.push(copy);
    this.length += copy.byteLength;
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.length);
    let offset = 0;

    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  }

  private fixed(length: number, write: (view: DataView) => void): void {
    const bytes = new Uint8Array(length);
    write(new DataView(bytes.buffer));
    this.bytes(bytes);
  }
}

class DtfReader {
  private offset = 0;

  constructor(private readonly source: Uint8Array) {}

  u8(): number {
    this.require(1);
    const value = this.source[this.offset];
    this.offset += 1;
    return value;
  }

  u16(): number {
    return this.fixed(2, (view) => view.getUint16(0, false));
  }

  u32(): number {
    return this.fixed(4, (view) => view.getUint32(0, false));
  }

  u64(): bigint {
    return this.fixed(8, (view) => view.getBigUint64(0, false));
  }

  string(): string {
    return textDecoder.decode(this.bytes(this.u16()));
  }

  bytes(length: number): Uint8Array {
    this.require(length);
    const bytes = this.source.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  done(): boolean {
    return this.offset === this.source.byteLength;
  }

  private fixed<T>(length: number, read: (view: DataView) => T): T {
    const bytes = this.bytes(length);
    return read(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  private require(length: number): void {
    if (this.offset + length > this.source.byteLength) {
      throw new Error("DTF payload ended early");
    }
  }
}
