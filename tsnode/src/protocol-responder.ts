import {
  createDtfPacket,
  decodeDtfPacket,
  dtfQueryCodeToKind,
  encodeDtfPacket,
  createRangeDataPayload
} from "./codec.js";
import { randomSessionId } from "./ids.js";
import {
  DTF_DEFAULT_MAX_DATAGRAM,
  DTF_DEFAULT_RANGE_DATA_BYTES,
  DTF_HEADER_LENGTH,
  DtfDatagram,
  DtfDatagramTransport,
  DtfFileRecord,
  DtfMessageType,
  DtfPacket,
  DtfPeer,
  DtfProtocolResponderOptions,
  DtfQueryKindCode,
  DtfWireErrorCode
} from "./types.js";

const RANGE_DATA_PAYLOAD_OVERHEAD = 32 + 8 + 8 + 8 + 2 + 4;

export class DtfProtocolResponder<TAddress = unknown> {
  readonly localPeer: DtfPeer;

  private readonly transport: DtfDatagramTransport<TAddress>;
  private readonly filesById: Map<string, Omit<DtfFileRecord, "peers">>;
  private readonly contentsByFileId: Map<string, Uint8Array>;
  private readonly sessionIdFactory: () => bigint;
  private readonly maxRangeLength: number;
  private readonly defaultMaxDatagram: number;
  private readonly sessions = new Map<bigint, string>();
  private readonly cancelledRequestIds = new Set<bigint>();
  private readonly unsubscribe: () => void;

  constructor(options: DtfProtocolResponderOptions<TAddress>) {
    this.localPeer = options.localPeer;
    this.transport = options.transport;
    this.filesById = new Map(options.files.map((file) => [file.fileId, cloneRecord(file)]));
    this.contentsByFileId =
      options.contents instanceof Map ? new Map(options.contents) : new Map(Object.entries(options.contents));
    this.sessionIdFactory = options.sessionIdFactory ?? randomSessionId;
    this.maxRangeLength = options.maxRangeLength ?? 256 * 1024;
    this.defaultMaxDatagram = options.defaultMaxDatagram ?? DTF_DEFAULT_MAX_DATAGRAM;
    this.unsubscribe = this.transport.subscribe((datagram) => void this.receive(datagram));
  }

  dispose(): void {
    this.unsubscribe();
    this.sessions.clear();
    this.cancelledRequestIds.clear();
  }

  private async receive(datagram: DtfDatagram<TAddress>): Promise<void> {
    const packet = decodeDtfPacket(datagram.bytes);

    if (!packet) {
      return;
    }

    switch (packet.type) {
      case DtfMessageType.Hello:
        await this.handleHello(packet, datagram.address);
        break;
      case DtfMessageType.FindFiles:
        await this.handleFindFiles(packet, datagram.address);
        break;
      case DtfMessageType.GetRange:
        await this.handleGetRange(packet, datagram.address);
        break;
      case DtfMessageType.Cancel:
        this.cancelledRequestIds.add(packet.payload.cancelledRequestId);
        break;
    }
  }

  private async handleHello(packet: Extract<DtfPacket, { type: DtfMessageType.Hello }>, address: TAddress): Promise<void> {
    const sessionId = packet.sessionId !== 0n && this.sessions.has(packet.sessionId) ? packet.sessionId : this.sessionIdFactory();
    this.sessions.set(sessionId, packet.senderId);
    await this.send(
      address,
      createDtfPacket(
        {
          type: DtfMessageType.HelloAck,
          requestId: packet.requestId,
          sessionId,
          senderId: this.localPeer.peerId
        },
        {
          listenPort: this.localPeer.listenPort,
          name: this.localPeer.name
        }
      )
    );
  }

  private async handleFindFiles(
    packet: Extract<DtfPacket, { type: DtfMessageType.FindFiles }>,
    address: TAddress
  ): Promise<void> {
    const queryKind = packet.payload.queryKind;

    if (!Object.values(DtfQueryKindCode).includes(queryKind)) {
      await this.sendError(address, packet, DtfWireErrorCode.UnsupportedQuery, "Unsupported query kind");
      return;
    }

    const query = packet.payload.query.trim();
    const normalizedQuery = query.toLowerCase();
    const matches = [...this.filesById.values()].filter((record) => {
      const kind = dtfQueryCodeToKind(queryKind);

      if (kind === "all") {
        return true;
      }

      if (kind === "name") {
        return record.name.toLowerCase().includes(normalizedQuery);
      }

      if (kind === "fileId") {
        return record.fileId === normalizedQuery;
      }

      return record.tags.some((tag) => tag.toLowerCase() === normalizedQuery);
    });
    const maxResults = packet.payload.maxResults > 0 ? packet.payload.maxResults : matches.length;
    const records = matches.slice(0, maxResults).map(cloneRecord);

    await this.send(
      address,
      createDtfPacket(
        {
          type: DtfMessageType.Files,
          requestId: packet.requestId,
          sessionId: packet.sessionId,
          senderId: this.localPeer.peerId
        },
        {
          totalMatches: matches.length,
          records
        }
      )
    );
  }

  private async handleGetRange(
    packet: Extract<DtfPacket, { type: DtfMessageType.GetRange }>,
    address: TAddress
  ): Promise<void> {
    if (!this.sessions.has(packet.sessionId)) {
      await this.sendError(address, packet, DtfWireErrorCode.UnknownSession, "Unknown session");
      return;
    }

    const record = this.filesById.get(packet.payload.fileId);
    const content = this.contentsByFileId.get(packet.payload.fileId);

    if (!record || !content) {
      await this.sendError(address, packet, DtfWireErrorCode.FileNotFound, "File not found");
      return;
    }

    if (packet.payload.fromOffset >= packet.payload.toOffset || packet.payload.toOffset > BigInt(record.fileSize)) {
      await this.sendError(address, packet, DtfWireErrorCode.InvalidRange, "Invalid range");
      return;
    }

    const requestedLength = packet.payload.toOffset - packet.payload.fromOffset;

    if (requestedLength > BigInt(this.maxRangeLength)) {
      await this.sendError(address, packet, DtfWireErrorCode.RangeTooLarge, "Requested range is too large");
      return;
    }

    const maxDatagram = packet.payload.maxDatagram > 0 ? packet.payload.maxDatagram : this.defaultMaxDatagram;
    const maxDataBytes = Math.max(1, Math.min(DTF_DEFAULT_RANGE_DATA_BYTES, maxDatagram - DTF_HEADER_LENGTH - RANGE_DATA_PAYLOAD_OVERHEAD));
    let sentBytes = 0n;

    for (let offset = packet.payload.fromOffset; offset < packet.payload.toOffset; offset += BigInt(maxDataBytes)) {
      if (this.cancelledRequestIds.has(packet.requestId)) {
        break;
      }

      const end = offset + BigInt(Math.min(maxDataBytes, Number(packet.payload.toOffset - offset)));
      const data = content.slice(Number(offset), Number(end));
      sentBytes += BigInt(data.byteLength);
      await this.send(
        address,
        createDtfPacket(
          {
            type: DtfMessageType.RangeData,
            requestId: packet.requestId,
            sessionId: packet.sessionId,
            senderId: this.localPeer.peerId
          },
          createRangeDataPayload({
            fileId: packet.payload.fileId,
            requestedFrom: packet.payload.fromOffset,
            requestedTo: packet.payload.toOffset,
            dataOffset: offset,
            data
          })
        )
      );
    }

    await this.send(
      address,
      createDtfPacket(
        {
          type: DtfMessageType.RangeDone,
          requestId: packet.requestId,
          sessionId: packet.sessionId,
          senderId: this.localPeer.peerId
        },
        {
          fileId: packet.payload.fileId,
          requestedFrom: packet.payload.fromOffset,
          requestedTo: packet.payload.toOffset,
          sentBytes
        }
      )
    );
  }

  private async sendError(
    address: TAddress,
    request: DtfPacket,
    errorCode: DtfWireErrorCode,
    detail: string
  ): Promise<void> {
    await this.send(
      address,
      createDtfPacket(
        {
          type: DtfMessageType.Error,
          requestId: request.requestId,
          sessionId: request.sessionId,
          senderId: this.localPeer.peerId
        },
        {
          errorCode,
          detail
        }
      )
    );
  }

  private async send(address: TAddress, packet: DtfPacket): Promise<void> {
    await this.transport.send(encodeDtfPacket(packet), address);
  }
}

export function createDtfProtocolResponder<TAddress>(
  options: DtfProtocolResponderOptions<TAddress>
): DtfProtocolResponder<TAddress> {
  return new DtfProtocolResponder(options);
}

function cloneRecord(record: Omit<DtfFileRecord, "peers">): Omit<DtfFileRecord, "peers"> {
  return {
    ...record,
    tags: [...record.tags]
  };
}
