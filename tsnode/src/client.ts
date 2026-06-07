import { sha256Hex } from "./checksum.js";
import { DtfProtocolClient, DtfProtocolError } from "./protocol-client.js";
import {
  DtfAvailableFile,
  DtfAvailableFilesResponse,
  DtfClientOptions,
  DtfCompletedRange,
  DtfDownloadAvailableFileOptions,
  DtfDownloadProgress,
  DtfFindAvailableFilesOptions,
  DtfPeer
} from "./types.js";

interface PeerSession<TAddress> {
  address: TAddress;
  sessionId: string;
  peer: DtfPeer;
}

interface ByteRange {
  fromOffset: number;
  toOffset: number;
}

interface PeerCompletedRange<TAddress> {
  completed: DtfCompletedRange;
  peer: DtfPeer;
  address: TAddress;
}

const DEFAULT_PARALLEL_REQUESTS_PER_PEER = 10;
const MIN_OVERRIDDEN_PARALLEL_REQUESTS = 5;

export class DtfClient<TAddress = unknown> {
  readonly localPeer: DtfPeer;

  private readonly protocol: DtfProtocolClient<TAddress>;
  private readonly discoveryAddresses: readonly TAddress[];
  private readonly acceptDiscoveryResponse: ((sourceAddress: TAddress, discoveryAddress: TAddress) => boolean) | undefined;
  private readonly discoveryResponseTimeoutMs: number | undefined;

  constructor(options: DtfClientOptions<TAddress>) {
    this.localPeer = options.localPeer;
    this.discoveryAddresses = options.discoveryAddresses;
    this.acceptDiscoveryResponse = options.acceptDiscoveryResponse;
    this.discoveryResponseTimeoutMs = options.discoveryResponseTimeoutMs;
    this.protocol = new DtfProtocolClient({
      localPeer: options.localPeer,
      transport: options.transport,
      requestIdFactory: options.requestIdFactory,
      addressEquals: options.addressEquals,
      helloRetryMs: options.peerConnectRetryMs,
      findFilesRetryMs: options.discoveryRetryMs,
      getRangeIdleMs: options.rangeIdleMs,
      maxRangeRepairRounds: options.maxRangeRepairRounds
    });
  }

  dispose(): void {
    this.protocol.dispose();
  }

  async findAvailableFiles(options: DtfFindAvailableFilesOptions = {}): Promise<DtfAvailableFilesResponse<TAddress>> {
    const discovered = await this.protocol.discoverFiles(this.discoveryAddresses, {
      queryKind: options.queryKind,
      query: options.query,
      maxResults: options.maxResults,
      signal: options.signal,
      responseTimeoutMs: this.discoveryResponseTimeoutMs,
      acceptAddress: this.acceptDiscoveryResponse
    });

    return {
      totalMatches: discovered.totalMatches,
      records: discovered.records
    };
  }

  async downloadFile(
    file: DtfAvailableFile<TAddress>,
    options: DtfDownloadAvailableFileOptions = {}
  ): Promise<Uint8Array> {
    this.throwIfAborted(options.signal);

    const sessions = await this.connectToAvailablePeers(file, options.signal);

    if (sessions.length === 0) {
      throw new DtfProtocolError("temporarily-unavailable", `No accessible peers for ${file.fileId}`);
    }

    const chunkSize = options.chunkSize ?? file.chunkSize;
    const ranges = splitRanges(file.fileSize, chunkSize);
    const target = new Uint8Array(file.fileSize);
    const maxParallelRequests = resolveMaxParallelRequests(sessions.length, options.maxParallelRequests);
    let completedRanges = 0;
    let nextRangeIndex = 0;

    const workers = Array.from({ length: maxParallelRequests }, async (_unused, workerIndex) => {
      while (nextRangeIndex < ranges.length) {
        this.throwIfAborted(options.signal);

        const range = ranges[nextRangeIndex];
        nextRangeIndex += 1;
        const { completed, peer } = await this.downloadRangeFromAnyPeer(file, range, sessions, workerIndex, options);
        target.set(completed.data, range.fromOffset);
        completedRanges += 1;
        options.onProgress?.({
          fileId: file.fileId,
          receivedBytes: Math.min(completedRanges * chunkSize, file.fileSize),
          totalBytes: file.fileSize,
          completed: completedRanges === ranges.length,
          peer,
          chunk: range
        });
      }
    });

    await Promise.all(workers);

    if (options.verifyIntegrity) {
      const digest = await sha256Hex(target);

      if (digest !== file.fileId) {
        throw new DtfProtocolError("integrity-check-failed", `Downloaded bytes do not match ${file.fileId}`);
      }
    }

    return target;
  }

  private async connectToAvailablePeers(
    file: DtfAvailableFile<TAddress>,
    signal: AbortSignal | undefined
  ): Promise<Array<PeerSession<TAddress>>> {
    const attempts = await Promise.allSettled(
      file.peers.map(async (peer) => {
        this.throwIfAborted(signal);
        const session = await this.protocol.hello(peer.address, { signal });

        return {
          address: peer.address,
          sessionId: session.sessionId,
          peer: session.peer
        };
      })
    );

    return attempts.flatMap((attempt) => (attempt.status === "fulfilled" ? [attempt.value] : []));
  }

  private async downloadRangeFromAnyPeer(
    file: DtfAvailableFile<TAddress>,
    range: ByteRange,
    sessions: Array<PeerSession<TAddress>>,
    workerIndex: number,
    options: DtfDownloadAvailableFileOptions
  ): Promise<PeerCompletedRange<TAddress>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < sessions.length; attempt += 1) {
      const session = sessions[(workerIndex + attempt) % sessions.length];

      try {
        const completed = await this.protocol.getRange(session.address, {
          fileId: file.fileId,
          fromOffset: BigInt(range.fromOffset),
          toOffset: BigInt(range.toOffset),
          sessionId: session.sessionId,
          maxDatagram: options.maxDatagram,
          signal: options.signal
        });

        return {
          completed,
          peer: session.peer,
          address: session.address
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new DtfProtocolError("temporarily-unavailable", `No peer returned range for ${file.fileId}`);
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new DtfProtocolError("cancelled", "DTF request cancelled");
    }
  }
}

export function createDtfClient<TAddress>(options: DtfClientOptions<TAddress>): DtfClient<TAddress> {
  return new DtfClient(options);
}

function splitRanges(fileSize: number, chunkSize: number): ByteRange[] {
  const ranges: ByteRange[] = [];

  for (let fromOffset = 0; fromOffset < fileSize; fromOffset += chunkSize) {
    ranges.push({
      fromOffset,
      toOffset: Math.min(fromOffset + chunkSize, fileSize)
    });
  }

  return ranges;
}

function resolveMaxParallelRequests(peerCount: number, requested: number | undefined): number {
  if (requested === undefined) {
    return Math.max(1, peerCount * DEFAULT_PARALLEL_REQUESTS_PER_PEER);
  }

  if (!Number.isFinite(requested)) {
    return MIN_OVERRIDDEN_PARALLEL_REQUESTS;
  }

  return Math.max(MIN_OVERRIDDEN_PARALLEL_REQUESTS, Math.floor(requested));
}
