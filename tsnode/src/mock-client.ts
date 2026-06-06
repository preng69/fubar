import { mockDtfDataset } from "./mock-data.js";
import {
  DTF_DEFAULT_PORT,
  DtfDownloadOptions,
  DtfErrorCode,
  DtfFileRecord,
  DtfFindFilesRequest,
  DtfFindFilesResponse,
  DtfHelloRequest,
  DtfMockDataset,
  DtfMockError,
  DtfPeer,
  DtfRangeData,
  DtfRangeRequest,
  DtfSession,
  HexFileId
} from "./types.js";

export interface DtfMockClientOptions {
  dataset?: DtfMockDataset;
}

export class DtfMockClient {
  readonly localPeer: DtfPeer;

  private readonly peersById: Map<string, DtfPeer>;
  private readonly filesById: Map<string, DtfFileRecord>;
  private readonly contentsByFileId: Map<string, Uint8Array>;
  private readonly sessionsById = new Map<string, DtfSession>();
  private readonly cancelledRequestIds = new Set<string>();
  private requestCounter = 0;
  private sessionCounter = 0;

  constructor(options: DtfMockClientOptions = {}) {
    const dataset = options.dataset ?? mockDtfDataset;
    this.localPeer = dataset.localPeer;
    this.peersById = new Map(dataset.peers.map((peer) => [peer.peerId, peer]));
    this.contentsByFileId = new Map(Object.entries(dataset.contents));
    this.filesById = new Map(
      dataset.files.map((file) => [
        file.fileId,
        {
          ...file,
          peers: file.peerIds
            .map((peerId) => this.peersById.get(peerId))
            .filter((peer): peer is DtfPeer => peer !== undefined)
        }
      ])
    );
  }

  listPeers(): DtfPeer[] {
    return [...this.peersById.values()].map((peer) => ({ ...peer }));
  }

  async findFiles(request: DtfFindFilesRequest = {}): Promise<DtfFindFilesResponse> {
    const queryKind = request.queryKind ?? "all";
    const query = request.query?.trim() ?? "";
    const normalizedQuery = query.toLowerCase();
    const allRecords = [...this.filesById.values()];

    const matches = allRecords.filter((record) => {
      if (queryKind === "all") {
        return true;
      }

      if (queryKind === "name") {
        return record.name.toLowerCase().includes(normalizedQuery);
      }

      if (queryKind === "fileId") {
        return record.fileId === normalizedQuery;
      }

      if (queryKind === "tag") {
        return record.tags.some((tag) => tag.toLowerCase() === normalizedQuery);
      }

      return false;
    });

    const maxResults = request.maxResults && request.maxResults > 0 ? request.maxResults : matches.length;
    const records = matches.slice(0, maxResults).map(cloneFileRecord);

    return {
      requestId: this.nextRequestId(),
      totalMatches: matches.length,
      records
    };
  }

  async hello(request: DtfHelloRequest): Promise<DtfSession> {
    const peer = this.peersById.get(request.peerId);

    if (!peer) {
      throw new DtfMockError("unknown-session", `Unknown peer: ${request.peerId}`);
    }

    const session: DtfSession = {
      sessionId: this.nextSessionId(),
      peer: {
        ...peer,
        listenPort: request.listenPort ?? peer.listenPort ?? DTF_DEFAULT_PORT
      }
    };

    this.sessionsById.set(session.sessionId, session);
    return cloneSession(session);
  }

  async getRange(request: DtfRangeRequest): Promise<DtfRangeData> {
    this.throwIfAborted(request.signal);
    this.assertKnownSession(request.sessionId);

    const record = this.filesById.get(request.fileId);
    const content = this.contentsByFileId.get(request.fileId);

    if (!record || !content) {
      throw new DtfMockError("file-not-found", `Unknown file: ${request.fileId}`);
    }

    validateRange(request.fileId, record.fileSize, request.fromOffset, request.toOffset);

    const requestId = this.nextRequestId();
    const data = content.slice(request.fromOffset, request.toOffset);

    if (this.cancelledRequestIds.has(requestId)) {
      throw new DtfMockError("cancelled", `Request cancelled: ${requestId}`);
    }

    return {
      requestId,
      fileId: request.fileId,
      requestedFrom: request.fromOffset,
      requestedTo: request.toOffset,
      dataOffset: request.fromOffset,
      dataCrc32: crc32(data),
      data
    };
  }

  async downloadFile(fileId: HexFileId, options: DtfDownloadOptions = {}): Promise<Uint8Array> {
    const record = this.filesById.get(fileId);

    if (!record) {
      throw new DtfMockError("file-not-found", `Unknown file: ${fileId}`);
    }

    const chunkSize = options.chunkSize ?? record.chunkSize;
    const target = new Uint8Array(record.fileSize);
    let receivedBytes = 0;

    for (let fromOffset = 0; fromOffset < record.fileSize; fromOffset += chunkSize) {
      this.throwIfAborted(options.signal);

      const toOffset = Math.min(fromOffset + chunkSize, record.fileSize);
      const range = await this.getRange({
        fileId,
        fromOffset,
        toOffset,
        sessionId: options.sessionId,
        signal: options.signal
      });

      target.set(range.data, range.dataOffset);
      receivedBytes += range.data.byteLength;
      options.onProgress?.({
        fileId,
        receivedBytes,
        totalBytes: record.fileSize,
        completed: receivedBytes === record.fileSize
      });
    }

    return target;
  }

  cancel(requestId: string): void {
    this.cancelledRequestIds.add(requestId);
  }

  getFile(fileId: HexFileId): DtfFileRecord | undefined {
    const record = this.filesById.get(fileId);
    return record ? cloneFileRecord(record) : undefined;
  }

  private assertKnownSession(sessionId: string | undefined): void {
    if (sessionId && !this.sessionsById.has(sessionId)) {
      throw new DtfMockError("unknown-session", `Unknown session: ${sessionId}`);
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new DtfMockError("cancelled", "Request cancelled");
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return this.requestCounter.toString().padStart(16, "0");
  }

  private nextSessionId(): string {
    this.sessionCounter += 1;
    return `mock-session-${this.sessionCounter.toString().padStart(4, "0")}`;
  }
}

function cloneSession(session: DtfSession): DtfSession {
  return {
    sessionId: session.sessionId,
    peer: { ...session.peer }
  };
}

function cloneFileRecord(record: DtfFileRecord): DtfFileRecord {
  return {
    ...record,
    tags: [...record.tags],
    peers: record.peers.map((peer) => ({ ...peer }))
  };
}

function validateRange(fileId: HexFileId, fileSize: number, fromOffset: number, toOffset: number): void {
  if (!Number.isSafeInteger(fromOffset) || !Number.isSafeInteger(toOffset)) {
    throw new DtfMockError("invalid-range", `Range offsets must be safe integers for ${fileId}`);
  }

  if (fromOffset < 0 || toOffset <= fromOffset || toOffset > fileSize) {
    throw new DtfMockError(
      "invalid-range",
      `Invalid range for ${fileId}: [${fromOffset}, ${toOffset}) outside file size ${fileSize}`
    );
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export function createDtfMockClient(options?: DtfMockClientOptions): DtfMockClient {
  return new DtfMockClient(options);
}

export function isDtfMockError(error: unknown, code?: DtfErrorCode): error is DtfMockError {
  return error instanceof DtfMockError && (!code || error.code === code);
}
