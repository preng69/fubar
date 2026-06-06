import { bytesToHex } from "./checksum.js";

export function hexToBytes(hex: string, expectedBytes: number, label = "hex value"): Uint8Array {
  if (!isHexOfByteLength(hex, expectedBytes)) {
    throw new Error(`${label} must be ${expectedBytes * 2} lowercase hexadecimal characters`);
  }

  const bytes = new Uint8Array(expectedBytes);

  for (let index = 0; index < expectedBytes; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

export function isHexOfByteLength(hex: string, expectedBytes: number): boolean {
  return new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`).test(hex);
}

export function peerIdToBytes(peerId: string): Uint8Array {
  return hexToBytes(peerId, 16, "peer_id");
}

export function fileIdToBytes(fileId: string): Uint8Array {
  return hexToBytes(fileId, 32, "file_id");
}

export function bytesToPeerId(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) {
    throw new Error("peer_id must be 16 bytes");
  }

  return bytesToHex(bytes);
}

export function bytesToFileId(bytes: Uint8Array): string {
  if (bytes.byteLength !== 32) {
    throw new Error("file_id must be 32 bytes");
  }

  return bytesToHex(bytes);
}

export function randomPeerId(): string {
  return bytesToHex(randomBytes(16));
}

export function randomRequestId(): bigint {
  return randomU64();
}

export function randomSessionId(): bigint {
  let value = 0n;

  while (value === 0n) {
    value = randomU64();
  }

  return value;
}

export function bigintToHex64(value: bigint): string {
  assertU64(value, "u64");
  return value.toString(16).padStart(16, "0");
}

export function hex64ToBigint(value: string, label = "u64"): bigint {
  if (!/^[0-9a-f]{1,16}$/.test(value)) {
    throw new Error(`${label} must be 1 to 16 lowercase hexadecimal characters`);
  }

  return BigInt(`0x${value}`);
}

export function assertU64(value: bigint, label: string): void {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`${label} must fit in an unsigned 64-bit integer`);
  }
}

function randomU64(): bigint {
  const bytes = randomBytes(8);
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value;
}

function randomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi?.getRandomValues) {
    throw new Error("crypto.getRandomValues is not available in this runtime");
  }

  const bytes = new Uint8Array(length);
  cryptoApi.getRandomValues(bytes);
  return bytes;
}
