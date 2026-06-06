import {
  createDtfPacket,
  decodeDtfPacket,
  dtfQueryKindToCode,
  encodeDtfPacket,
  wireErrorCodeToDtfCode
} from "./codec.js";
import { crc32 } from "./checksum.js";
import { bigintToHex64, hex64ToBigint, randomRequestId } from "./ids.js";
import {
  DTF_DEFAULT_MAX_DATAGRAM,
  DTF_DEFAULT_PORT,
  DTF_FIND_FILES_RETRY_MS,
  DTF_GET_RANGE_IDLE_MS,
  DTF_HELLO_RETRY_MS,
  DtfCompletedRange,
  DtfDatagram,
  DtfDatagramTransport,
  DtfDiscoverFilesOptions,
  DtfDiscoverFilesResponse,
  DtfDiscoveredFileRecord,
  DtfDiscoveryAddressResult,
  DtfDownloadProgress,
  DtfErrorCode,
  DtfFileRecord,
  DtfFindFilesOptions,
  DtfFindFilesResponse,
  DtfHelloOptions,
  DtfMessageType,
  DtfPacket,
  DtfPeer,
  DtfProtocolClientOptions,
  DtfProtocolDownloadOptions,
  DtfProtocolRangeRequest,
  DtfSession,
  DtfWireErrorCode
} from "./types.js";

type PacketListener<TAddress> = (packet: DtfPacket, address: TAddress) => void;
type FindFilesPacket = Extract<DtfPacket, { type: DtfMessageType.FindFiles }>;
type FilesPacket = Extract<DtfPacket, { type: DtfMessageType.Files }>;
type ErrorPacket = Extract<DtfPacket, { type: DtfMessageType.Error }>;

const EMPTY_REQUEST_ID = "0000000000000000";

export class DtfProtocolError extends Error {
  readonly code: DtfErrorCode;

  constructor(code: DtfErrorCode, message: string) {
    super(message);
    this.name = "DtfProtocolError";
    this.code = code;
  }
}

export class DtfProtocolClient<TAddress = unknown> {
  readonly localPeer: DtfPeer;

  private readonly transport: DtfDatagramTransport<TAddress>;
  private readonly requestIdFactory: () => bigint;
  private readonly addressEquals: (left: TAddress, right: TAddress) => boolean;
  private readonly helloRetryMs: number;
  private readonly findFilesRetryMs: number;
  private readonly getRangeIdleMs: number;
  private readonly maxRangeRepairRounds: number;
  private readonly listeners = new Set<PacketListener<TAddress>>();
  private readonly unsubscribe: () => void;

  constructor(options: DtfProtocolClientOptions<TAddress>) {
    this.localPeer = options.localPeer;
    this.transport = options.transport;
    this.requestIdFactory = options.requestIdFactory ?? randomRequestId;
    this.addressEquals = options.addressEquals ?? Object.is;
    this.helloRetryMs = options.helloRetryMs ?? DTF_HELLO_RETRY_MS;
    this.findFilesRetryMs = options.findFilesRetryMs ?? DTF_FIND_FILES_RETRY_MS;
    this.getRangeIdleMs = options.getRangeIdleMs ?? DTF_GET_RANGE_IDLE_MS;
    this.maxRangeRepairRounds = options.maxRangeRepairRounds ?? 8;
    this.unsubscribe = this.transport.subscribe((datagram) => this.receive(datagram));
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  async hello(address: TAddress, options: DtfHelloOptions = {}): Promise<DtfSession> {
    const requestId = this.requestIdFactory();
    const packet = createDtfPacket(
      {
        type: DtfMessageType.Hello,
        requestId,
        sessionId: options.sessionId ?? 0n,
        senderId: this.localPeer.peerId
      },
      {
        listenPort: options.listenPort ?? this.localPeer.listenPort ?? DTF_DEFAULT_PORT,
        name: options.name ?? this.localPeer.name
      }
    );
    const attempts = options.attempts ?? 3;

    const ack = await this.sendWithRetries(
      address,
      packet,
      attempts,
      this.helloRetryMs,
      (candidate, source) =>
        this.addressEquals(source, address) &&
        candidate.type === DtfMessageType.HelloAck &&
        candidate.requestId === requestId,
      options.signal
    );

    if (ack.type !== DtfMessageType.HelloAck) {
      throw new DtfProtocolError("malformed-message", "Expected HELLO_ACK response");
    }

    return {
      sessionId: bigintToHex64(ack.sessionId),
      peer: {
        peerId: ack.senderId,
        name: ack.payload.name,
        listenPort: ack.payload.listenPort
      }
    };
  }

  async findFiles(address: TAddress, options: DtfFindFilesOptions = {}): Promise<DtfFindFilesResponse> {
    const requestId = this.requestIdFactory();
    const packet = createDtfPacket(
      {
        type: DtfMessageType.FindFiles,
        requestId,
        sessionId: normalizeSessionId(options.sessionId ?? 0n),
        senderId: this.localPeer.peerId
      },
      {
        queryKind: dtfQueryKindToCode(options.queryKind),
        maxResults: options.maxResults ?? 0,
        query: options.query ?? ""
      }
    ) as FindFilesPacket;
    const attempts = options.attempts ?? 2;

    const files = await this.sendWithRetries(
      address,
      packet,
      attempts,
      this.findFilesRetryMs,
      (candidate, source) =>
        this.addressEquals(source, address) &&
        candidate.type === DtfMessageType.Files &&
        candidate.requestId === requestId,
      options.signal
    );

    if (files.type !== DtfMessageType.Files) {
      throw new DtfProtocolError("malformed-message", "Expected FILES response");
    }

    const peer = {
      peerId: files.senderId,
      name: "",
      listenPort: DTF_DEFAULT_PORT
    };

    return {
      requestId: bigintToHex64(files.requestId),
      totalMatches: files.payload.totalMatches,
      records: files.payload.records.map((record) => ({ ...record, tags: [...record.tags], peers: [peer] }))
    };
  }

  async discoverFiles(
    addresses: readonly TAddress[],
    options: DtfDiscoverFilesOptions<TAddress> = {}
  ): Promise<DtfDiscoverFilesResponse<TAddress>> {
    if (addresses.length === 0) {
      return {
        requestId: EMPTY_REQUEST_ID,
        totalMatches: 0,
        records: [],
        addressResults: []
      };
    }

    const addressResults = await Promise.all(
      addresses.map(async (address) => {
        const result = await this.discoverFilesAtAddress(address, options);
        options.onAddressResult?.(result);
        return result;
      })
    );
    const successes = addressResults.filter(isDiscoverySuccess);

    if (successes.length === 0) {
      const firstFailure = addressResults.find((result) => !result.ok);
      throw new DtfProtocolError(
        firstFailure?.errorCode ?? "timeout",
        firstFailure?.message ?? "DTF discovery failed for all addresses"
      );
    }

    const records = mergeDiscoveredFileRecords(successes.flatMap((result) => result.records));

    return {
      requestId: successes[0].requestId,
      totalMatches: records.length,
      records,
      addressResults
    };
  }

  async getRange(address: TAddress, request: DtfProtocolRangeRequest): Promise<DtfCompletedRange> {
    const assembler = new RangeAssembler(request.fromOffset, request.toOffset);
    let missing = assembler.missing();
    let lastRequestId = 0n;

    for (let round = 0; missing.length > 0 && round < this.maxRangeRepairRounds; round += 1) {
      const repairs = missing;

      for (const repair of repairs) {
        this.throwIfAborted(request.signal);
        lastRequestId = await this.requestSubrange(address, request, repair, assembler);
      }

      missing = assembler.missing();
    }

    if (missing.length > 0) {
      throw new DtfProtocolError(
        "timeout",
        `Range incomplete after ${this.maxRangeRepairRounds} repair rounds for ${request.fileId}`
      );
    }

    return {
      requestId: lastRequestId,
      data: assembler.data(),
      missing
    };
  }

  async downloadFile(
    address: TAddress,
    record: Omit<DtfFileRecord, "peers">,
    options: DtfProtocolDownloadOptions
  ): Promise<Uint8Array> {
    const chunkSize = options.chunkSize ?? record.chunkSize;
    const target = new Uint8Array(record.fileSize);
    let receivedBytes = 0;

    for (let fromOffset = 0; fromOffset < record.fileSize; fromOffset += chunkSize) {
      const toOffset = Math.min(fromOffset + chunkSize, record.fileSize);
      const range = await this.getRange(address, {
        fileId: record.fileId,
        fromOffset: BigInt(fromOffset),
        toOffset: BigInt(toOffset),
        sessionId: options.sessionId,
        maxDatagram: options.maxDatagram,
        signal: options.signal
      });

      target.set(range.data, fromOffset);
      receivedBytes += range.data.byteLength;
      options.onProgress?.({
        fileId: record.fileId,
        receivedBytes,
        totalBytes: record.fileSize,
        completed: receivedBytes === record.fileSize
      });
    }

    return target;
  }

  async cancel(address: TAddress, cancelledRequestId: bigint | string, sessionId: bigint | string, fileId: string): Promise<void> {
    const packet = createDtfPacket(
      {
        type: DtfMessageType.Cancel,
        requestId: this.requestIdFactory(),
        sessionId: normalizeSessionId(sessionId),
        senderId: this.localPeer.peerId
      },
      {
        cancelledRequestId: normalizeSessionId(cancelledRequestId),
        fileId
      }
    );
    await this.send(address, packet);
  }

  private async discoverFilesAtAddress(
    address: TAddress,
    options: DtfDiscoverFilesOptions<TAddress>
  ): Promise<DtfDiscoveryAddressResult<TAddress>> {
    const requestId = this.requestIdFactory();
    const packet = createDtfPacket(
      {
        type: DtfMessageType.FindFiles,
        requestId,
        sessionId: normalizeSessionId(options.sessionId ?? 0n),
        senderId: this.localPeer.peerId
      },
      {
        queryKind: dtfQueryKindToCode(options.queryKind),
        maxResults: options.maxResults ?? 0,
        query: options.query ?? ""
      }
    ) as FindFilesPacket;
    const attempts = options.attempts ?? 2;
    const responseTimeoutMs = options.responseTimeoutMs ?? this.findFilesRetryMs;
    const acceptAddress = options.acceptAddress ?? ((source: TAddress, discoveryAddress: TAddress) =>
      this.addressEquals(source, discoveryAddress));
    const responses: Array<{ packet: FilesPacket; sourceAddress: TAddress }> = [];
    const errors: DtfProtocolError[] = [];
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < attempts && responses.length === 0; attempt += 1) {
      this.throwIfAborted(options.signal);

      try {
        await this.collectFilesResponses(address, packet, responseTimeoutMs, acceptAddress, options.signal, responses, errors);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        break;
      }
    }

    if (responses.length === 0) {
      const error = lastError ?? errors[0] ?? new DtfProtocolError("timeout", "DTF discovery request timed out");

      return {
        ok: false,
        address,
        errorCode: isDtfProtocolError(error) ? error.code : "temporarily-unavailable",
        message: error.message
      };
    }

    const records = mergeDiscoveredFileRecords(
      responses.flatMap(({ packet: files, sourceAddress }) => recordsFromFilesPacket(files, sourceAddress, address))
    );

    return {
      ok: true,
      address,
      requestId: bigintToHex64(requestId),
      totalMatches: records.length,
      responseCount: responses.length,
      responderAddresses: uniqueAddresses(
        responses.map((response) => response.sourceAddress),
        this.addressEquals
      ),
      records
    };
  }

  private async requestSubrange(
    address: TAddress,
    request: DtfProtocolRangeRequest,
    repair: { fromOffset: bigint; toOffset: bigint },
    assembler: RangeAssembler
  ): Promise<bigint> {
    const requestId = this.requestIdFactory();
    const sessionId = normalizeSessionId(request.sessionId);
    const packet = createDtfPacket(
      {
        type: DtfMessageType.GetRange,
        requestId,
        sessionId,
        senderId: this.localPeer.peerId
      },
      {
        fileId: request.fileId,
        fromOffset: repair.fromOffset,
        toOffset: repair.toOffset,
        maxDatagram: request.maxDatagram ?? DTF_DEFAULT_MAX_DATAGRAM
      }
    );

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this.listeners.delete(listener);
        request.signal?.removeEventListener("abort", abort);
      };
      const finish = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const resetTimer = () => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(finish, this.getRangeIdleMs);
      };
      const abort = () => {
        void this.cancel(address, requestId, sessionId, request.fileId);
        fail(new DtfProtocolError("cancelled", "Range request cancelled"));
      };
      const listener: PacketListener<TAddress> = (candidate, source) => {
        if (!this.addressEquals(source, address) || candidate.requestId !== requestId) {
          return;
        }

        if (candidate.type === DtfMessageType.Error) {
          fail(
            new DtfProtocolError(
              wireErrorCodeToDtfCode(candidate.payload.errorCode as DtfWireErrorCode) as DtfErrorCode,
              candidate.payload.detail || `DTF error ${candidate.payload.errorCode}`
            )
          );
          return;
        }

        if (candidate.type === DtfMessageType.RangeDone) {
          finish();
          return;
        }

        if (candidate.type !== DtfMessageType.RangeData) {
          return;
        }

        if (candidate.payload.fileId !== request.fileId || crc32(candidate.payload.data) !== candidate.payload.dataCrc32) {
          resetTimer();
          return;
        }

        assembler.accept(candidate.payload.dataOffset, candidate.payload.data);
        resetTimer();

        if (assembler.covers(repair.fromOffset, repair.toOffset)) {
          finish();
        }
      };

      this.listeners.add(listener);
      request.signal?.addEventListener("abort", abort, { once: true });
      resetTimer();
      void this.send(address, packet).catch(fail);
    });

    return requestId;
  }

  private async sendWithRetries(
    address: TAddress,
    packet: DtfPacket,
    attempts: number,
    timeoutMs: number,
    predicate: (packet: DtfPacket, address: TAddress) => boolean,
    signal: AbortSignal | undefined
  ): Promise<DtfPacket> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.throwIfAborted(signal);
      const response = this.waitForPacket(predicate, timeoutMs, signal, packet.requestId);
      await this.send(address, packet);

      try {
        return await response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new DtfProtocolError("timeout", "DTF request timed out");
  }

  private collectFilesResponses(
    address: TAddress,
    packet: FindFilesPacket,
    timeoutMs: number,
    acceptAddress: (sourceAddress: TAddress, discoveryAddress: TAddress) => boolean,
    signal: AbortSignal | undefined,
    responses: Array<{ packet: FilesPacket; sourceAddress: TAddress }>,
    errors: DtfProtocolError[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this.listeners.delete(listener);
        signal?.removeEventListener("abort", abort);
      };
      const finish = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const abort = () => {
        fail(new DtfProtocolError("cancelled", "DTF discovery request cancelled"));
      };
      const listener: PacketListener<TAddress> = (candidate, sourceAddress) => {
        if (candidate.requestId !== packet.requestId || !acceptAddress(sourceAddress, address)) {
          return;
        }

        if (candidate.type === DtfMessageType.Files) {
          responses.push({ packet: candidate, sourceAddress });
          return;
        }

        if (candidate.type === DtfMessageType.Error) {
          errors.push(errorFromPacket(candidate));
        }
      };

      timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.listeners.add(listener);
      void this.send(address, packet).catch(fail);
    });
  }

  private waitForPacket(
    predicate: (packet: DtfPacket, address: TAddress) => boolean,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    requestId: bigint
  ): Promise<DtfPacket> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this.listeners.delete(listener);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new DtfProtocolError("cancelled", "DTF request cancelled"));
      };
      const listener: PacketListener<TAddress> = (packet, address) => {
        if (predicate(packet, address)) {
          cleanup();
          resolve(packet);
        } else if (packet.type === DtfMessageType.Error && packet.requestId === requestId) {
          cleanup();
          reject(
            new DtfProtocolError(
              wireErrorCodeToDtfCode(packet.payload.errorCode as DtfWireErrorCode) as DtfErrorCode,
              packet.payload.detail || `DTF error ${packet.payload.errorCode}`
            )
          );
        }
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new DtfProtocolError("timeout", "DTF request timed out"));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.listeners.add(listener);
    });
  }

  private async send(address: TAddress, packet: DtfPacket): Promise<void> {
    await this.transport.send(encodeDtfPacket(packet), address);
  }

  private receive(datagram: DtfDatagram<TAddress>): void {
    const packet = decodeDtfPacket(datagram.bytes);

    if (!packet) {
      return;
    }

    for (const listener of [...this.listeners]) {
      listener(packet, datagram.address);
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new DtfProtocolError("cancelled", "DTF request cancelled");
    }
  }
}

export function createDtfProtocolClient<TAddress>(
  options: DtfProtocolClientOptions<TAddress>
): DtfProtocolClient<TAddress> {
  return new DtfProtocolClient(options);
}

export function isDtfProtocolError(error: unknown, code?: DtfErrorCode): error is DtfProtocolError {
  return error instanceof DtfProtocolError && (!code || error.code === code);
}

function errorFromPacket(packet: ErrorPacket): DtfProtocolError {
  return new DtfProtocolError(
    wireErrorCodeToDtfCode(packet.payload.errorCode as DtfWireErrorCode) as DtfErrorCode,
    packet.payload.detail || `DTF error ${packet.payload.errorCode}`
  );
}

function isDiscoverySuccess<TAddress>(
  result: DtfDiscoveryAddressResult<TAddress>
): result is Extract<DtfDiscoveryAddressResult<TAddress>, { ok: true }> {
  return result.ok;
}

function recordsFromFilesPacket<TAddress>(
  files: FilesPacket,
  sourceAddress: TAddress,
  discoveryAddress: TAddress
): Array<DtfDiscoveredFileRecord<TAddress>> {
  const peer = {
    peerId: files.senderId,
    name: "",
    listenPort: DTF_DEFAULT_PORT,
    address: sourceAddress,
    discoveryAddress
  };

  return files.payload.records.map((record) => ({
    ...record,
    tags: [...record.tags],
    peers: [peer]
  }));
}

function mergeDiscoveredFileRecords<TAddress>(
  records: Array<DtfDiscoveredFileRecord<TAddress>>
): Array<DtfDiscoveredFileRecord<TAddress>> {
  const merged = new Map<string, DtfDiscoveredFileRecord<TAddress>>();

  for (const record of records) {
    const existing = merged.get(record.fileId);

    if (!existing) {
      merged.set(record.fileId, {
        ...record,
        tags: [...record.tags],
        peers: [...record.peers]
      });
      continue;
    }

    existing.tags = uniqueStrings([...existing.tags, ...record.tags]);

    for (const peer of record.peers) {
      if (!existing.peers.some((candidate) => candidate.peerId === peer.peerId)) {
        existing.peers.push(peer);
      }
    }
  }

  return [...merged.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueAddresses<TAddress>(
  addresses: TAddress[],
  addressEquals: (left: TAddress, right: TAddress) => boolean
): TAddress[] {
  const unique: TAddress[] = [];

  for (const address of addresses) {
    if (!unique.some((candidate) => addressEquals(candidate, address))) {
      unique.push(address);
    }
  }

  return unique;
}

function normalizeSessionId(value: bigint | string): bigint {
  return typeof value === "bigint" ? value : hex64ToBigint(value, "session_id");
}

class RangeAssembler {
  private readonly buffer: Uint8Array;
  private readonly intervals: Array<{ start: number; end: number }> = [];

  constructor(
    private readonly fromOffset: bigint,
    private readonly toOffset: bigint
  ) {
    const length = toOffset - fromOffset;

    if (length < 0n || length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DtfProtocolError("invalid-range", "Range length must fit in a JavaScript Uint8Array");
    }

    this.buffer = new Uint8Array(Number(length));
  }

  accept(dataOffset: bigint, data: Uint8Array): void {
    if (data.byteLength === 0) {
      return;
    }

    const startOffset = dataOffset - this.fromOffset;
    const endOffset = startOffset + BigInt(data.byteLength);

    if (startOffset < 0n || endOffset > BigInt(this.buffer.byteLength)) {
      return;
    }

    const start = Number(startOffset);
    const end = Number(endOffset);
    this.buffer.set(data, start);
    this.addInterval(start, end);
  }

  covers(fromOffset: bigint, toOffset: bigint): boolean {
    const start = Number(fromOffset - this.fromOffset);
    const end = Number(toOffset - this.fromOffset);
    return this.intervals.some((interval) => interval.start <= start && interval.end >= end);
  }

  missing(): Array<{ fromOffset: bigint; toOffset: bigint }> {
    const missing: Array<{ fromOffset: bigint; toOffset: bigint }> = [];
    let cursor = 0;

    for (const interval of this.intervals) {
      if (cursor < interval.start) {
        missing.push({
          fromOffset: this.fromOffset + BigInt(cursor),
          toOffset: this.fromOffset + BigInt(interval.start)
        });
      }

      cursor = Math.max(cursor, interval.end);
    }

    if (cursor < this.buffer.byteLength) {
      missing.push({
        fromOffset: this.fromOffset + BigInt(cursor),
        toOffset: this.fromOffset + BigInt(this.buffer.byteLength)
      });
    }

    return missing;
  }

  data(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  private addInterval(start: number, end: number): void {
    this.intervals.push({ start, end });
    this.intervals.sort((left, right) => left.start - right.start);

    const merged: Array<{ start: number; end: number }> = [];

    for (const interval of this.intervals) {
      const previous = merged.at(-1);

      if (previous && interval.start <= previous.end) {
        previous.end = Math.max(previous.end, interval.end);
      } else {
        merged.push({ ...interval });
      }
    }

    this.intervals.splice(0, this.intervals.length, ...merged);
  }
}
