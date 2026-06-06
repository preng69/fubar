export const DTF_DEFAULT_PORT = 4747;
export const DTF_VERSION = 1;

export type HexPeerId = string;
export type HexFileId = string;

export type DtfQueryKind = "all" | "name" | "fileId" | "tag";

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
  | "unknown-session"
  | "file-not-found"
  | "invalid-range"
  | "range-too-large"
  | "unsupported-query"
  | "cancelled";

export class DtfMockError extends Error {
  readonly code: DtfErrorCode;

  constructor(code: DtfErrorCode, message: string) {
    super(message);
    this.name = "DtfMockError";
    this.code = code;
  }
}
