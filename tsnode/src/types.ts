export const DTF_DEFAULT_PORT = 4747;
export const DTF_VERSION = 1;
export const DTF_HEADER_LENGTH = 44;
export const DTF_MAGIC = "DTF1";
export const DTF_DEFAULT_MAX_DATAGRAM = 1200;
export const DTF_DEFAULT_RANGE_DATA_BYTES = 1024;
export const DTF_HELLO_RETRY_MS = 500;
export const DTF_FIND_FILES_RETRY_MS = 500;
export const DTF_GET_RANGE_IDLE_MS = 1000;
export const DTF_COMPLETED_REQUEST_TTL_MS = 60_000;

export type HexPeerId = string;
export type HexFileId = string;
export type HexRequestId = string;
export type HexSessionId = string;

export type DtfQueryKind = "all" | "name" | "fileId" | "tag";

export enum DtfMessageType {
  Hello = 0x01,
  HelloAck = 0x02,
  FindFiles = 0x10,
  Files = 0x11,
  GetRange = 0x20,
  RangeData = 0x21,
  RangeDone = 0x22,
  Cancel = 0x30,
  Error = 0x40
}

export enum DtfQueryKindCode {
  All = 0,
  Name = 1,
  FileId = 2,
  Tag = 3
}

export enum DtfWireErrorCode {
  MalformedMessage = 1,
  UnsupportedVersion = 2,
  UnknownSession = 3,
  FileNotFound = 4,
  InvalidRange = 5,
  RangeTooLarge = 6,
  TemporarilyUnavailable = 7,
  UnsupportedQuery = 8
}

export interface DtfPeer {
  peerId: HexPeerId;
  name: string;
  listenPort: number;
}

export interface DtfSession {
  sessionId: string;
  peer: DtfPeer;
}

export interface DtfFileRecord {
  fileId: HexFileId;
  fileSize: number;
  chunkSize: number;
  name: string;
  mediaType: string;
  tags: string[];
  peers: DtfPeer[];
}

export interface DtfFindFilesRequest {
  queryKind?: DtfQueryKind;
  query?: string;
  maxResults?: number;
}

export interface DtfFindFilesResponse {
  requestId: string;
  totalMatches: number;
  records: DtfFileRecord[];
}

export interface DtfDiscoveredPeer<TAddress = unknown> extends DtfPeer {
  address: TAddress;
  discoveryAddress: TAddress;
}

export interface DtfDiscoveredFileRecord<TAddress = unknown> extends Omit<DtfFileRecord, "peers"> {
  peers: Array<DtfDiscoveredPeer<TAddress>>;
}

export type DtfDiscoveryAddressResult<TAddress = unknown> =
  | {
      ok: true;
      address: TAddress;
      requestId: string;
      totalMatches: number;
      responseCount: number;
      responderAddresses: TAddress[];
      records: Array<DtfDiscoveredFileRecord<TAddress>>;
    }
  | {
      ok: false;
      address: TAddress;
      errorCode: DtfErrorCode;
      message: string;
    };

export interface DtfDiscoverFilesResponse<TAddress = unknown> extends Omit<DtfFindFilesResponse, "records"> {
  records: Array<DtfDiscoveredFileRecord<TAddress>>;
  addressResults: Array<DtfDiscoveryAddressResult<TAddress>>;
}

export type DtfAvailablePeer<TAddress = unknown> = DtfDiscoveredPeer<TAddress>;

export type DtfAvailableFile<TAddress = unknown> = DtfDiscoveredFileRecord<TAddress>;

export interface DtfAvailableFilesResponse<TAddress = unknown> {
  totalMatches: number;
  records: Array<DtfAvailableFile<TAddress>>;
}

export interface DtfHelloRequest {
  peerId: HexPeerId;
  name?: string;
  listenPort?: number;
}

export interface DtfRangeRequest {
  fileId: HexFileId;
  fromOffset: number;
  toOffset: number;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface DtfRangeData {
  requestId: string;
  fileId: HexFileId;
  requestedFrom: number;
  requestedTo: number;
  dataOffset: number;
  dataCrc32: number;
  data: Uint8Array;
}

export interface DtfPacketHeader {
  type: DtfMessageType;
  flags: number;
  headerLength: number;
  payloadLength: number;
  requestId: bigint;
  sessionId: bigint;
  senderId: HexPeerId;
}

export interface DtfHelloPayload {
  listenPort: number;
  name: string;
}

export interface DtfFindFilesPayload {
  queryKind: DtfQueryKindCode;
  maxResults: number;
  query: string;
}

export interface DtfFilesPayload {
  totalMatches: number;
  records: Array<Omit<DtfFileRecord, "peers">>;
}

export interface DtfGetRangePayload {
  fileId: HexFileId;
  fromOffset: bigint;
  toOffset: bigint;
  maxDatagram: number;
}

export interface DtfRangeDataPayload {
  fileId: HexFileId;
  requestedFrom: bigint;
  requestedTo: bigint;
  dataOffset: bigint;
  dataCrc32: number;
  data: Uint8Array;
}

export interface DtfRangeDonePayload {
  fileId: HexFileId;
  requestedFrom: bigint;
  requestedTo: bigint;
  sentBytes: bigint;
}

export interface DtfCancelPayload {
  cancelledRequestId: bigint;
  fileId: HexFileId;
}

export interface DtfErrorPayload {
  errorCode: DtfWireErrorCode;
  detail: string;
}

export type DtfPacket =
  | (DtfPacketHeader & { type: DtfMessageType.Hello; payload: DtfHelloPayload })
  | (DtfPacketHeader & { type: DtfMessageType.HelloAck; payload: DtfHelloPayload })
  | (DtfPacketHeader & { type: DtfMessageType.FindFiles; payload: DtfFindFilesPayload })
  | (DtfPacketHeader & { type: DtfMessageType.Files; payload: DtfFilesPayload })
  | (DtfPacketHeader & { type: DtfMessageType.GetRange; payload: DtfGetRangePayload })
  | (DtfPacketHeader & { type: DtfMessageType.RangeData; payload: DtfRangeDataPayload })
  | (DtfPacketHeader & { type: DtfMessageType.RangeDone; payload: DtfRangeDonePayload })
  | (DtfPacketHeader & { type: DtfMessageType.Cancel; payload: DtfCancelPayload })
  | (DtfPacketHeader & { type: DtfMessageType.Error; payload: DtfErrorPayload });

export interface DtfDatagram<TAddress = unknown> {
  bytes: Uint8Array;
  address: TAddress;
}

export interface DtfDatagramTransport<TAddress = unknown> {
  send(bytes: Uint8Array, address: TAddress): void | Promise<void>;
  subscribe(handler: (datagram: DtfDatagram<TAddress>) => void): () => void;
}

export interface DtfProtocolClientOptions<TAddress = unknown> {
  localPeer: DtfPeer;
  transport: DtfDatagramTransport<TAddress>;
  requestIdFactory?: () => bigint;
  addressEquals?: (left: TAddress, right: TAddress) => boolean;
  helloRetryMs?: number;
  findFilesRetryMs?: number;
  getRangeIdleMs?: number;
  completedRequestTtlMs?: number;
  maxRangeRepairRounds?: number;
}

export interface DtfClientOptions<TAddress = unknown> {
  localPeer: DtfPeer;
  transport: DtfDatagramTransport<TAddress>;
  discoveryAddresses: readonly TAddress[];
  requestIdFactory?: () => bigint;
  addressEquals?: (left: TAddress, right: TAddress) => boolean;
  peerConnectRetryMs?: number;
  discoveryRetryMs?: number;
  rangeIdleMs?: number;
  maxRangeRepairRounds?: number;
  acceptDiscoveryResponse?: (sourceAddress: TAddress, discoveryAddress: TAddress) => boolean;
  discoveryResponseTimeoutMs?: number;
}

export interface DtfProtocolResponderOptions<TAddress = unknown> {
  localPeer: DtfPeer;
  transport: DtfDatagramTransport<TAddress>;
  files: Array<Omit<DtfFileRecord, "peers">>;
  contents: Record<HexFileId, Uint8Array> | Map<HexFileId, Uint8Array>;
  sessionIdFactory?: () => bigint;
  maxRangeLength?: number;
  defaultMaxDatagram?: number;
}

export interface DtfFileServerOptions<TAddress = unknown> {
  localPeer: DtfPeer;
  transport: DtfDatagramTransport<TAddress>;
  files: Array<Omit<DtfFileRecord, "peers">>;
  contents: Record<HexFileId, Uint8Array> | Map<HexFileId, Uint8Array>;
  sessionIdFactory?: () => bigint;
  maxRangeLength?: number;
  defaultMaxDatagram?: number;
}

export interface DtfHelloOptions {
  name?: string;
  listenPort?: number;
  sessionId?: bigint;
  attempts?: number;
  signal?: AbortSignal;
}

export interface DtfFindFilesOptions extends DtfFindFilesRequest {
  sessionId?: bigint;
  attempts?: number;
  signal?: AbortSignal;
}

export interface DtfDiscoverFilesOptions<TAddress = unknown> extends DtfFindFilesOptions {
  responseTimeoutMs?: number;
  acceptAddress?: (sourceAddress: TAddress, discoveryAddress: TAddress) => boolean;
  onAddressResult?: (result: DtfDiscoveryAddressResult<TAddress>) => void;
}

export interface DtfFindAvailableFilesOptions extends DtfFindFilesRequest {
  signal?: AbortSignal;
}

export interface DtfProtocolRangeRequest {
  fileId: HexFileId;
  fromOffset: bigint;
  toOffset: bigint;
  sessionId: bigint | string;
  maxDatagram?: number;
  signal?: AbortSignal;
}

export interface DtfProtocolDownloadOptions {
  sessionId: bigint | string;
  chunkSize?: number;
  maxDatagram?: number;
  signal?: AbortSignal;
  onProgress?: (progress: DtfDownloadProgress) => void;
}

export interface DtfDownloadAvailableFileOptions {
  chunkSize?: number;
  maxDatagram?: number;
  maxParallelRequests?: number;
  verifyIntegrity?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: DtfDownloadProgress) => void;
}

export interface DtfCompletedRange {
  requestId: bigint;
  data: Uint8Array;
  missing: Array<{ fromOffset: bigint; toOffset: bigint }>;
}

export interface DtfDownloadProgress {
  fileId: HexFileId;
  receivedBytes: number;
  totalBytes: number;
  completed: boolean;
}

export interface DtfDownloadOptions {
  chunkSize?: number;
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: DtfDownloadProgress) => void;
}

export interface DtfMockDataset {
  localPeer: DtfPeer;
  peers: DtfPeer[];
  files: Array<Omit<DtfFileRecord, "peers"> & { peerIds: HexPeerId[] }>;
  contents: Record<HexFileId, Uint8Array>;
}

export type DtfErrorCode =
  | "malformed-message"
  | "unsupported-version"
  | "unknown-session"
  | "file-not-found"
  | "invalid-range"
  | "range-too-large"
  | "temporarily-unavailable"
  | "unsupported-query"
  | "cancelled"
  | "timeout"
  | "crc-mismatch"
  | "integrity-check-failed";

export class DtfMockError extends Error {
  readonly code: DtfErrorCode;

  constructor(code: DtfErrorCode, message: string) {
    super(message);
    this.name = "DtfMockError";
    this.code = code;
  }
}
