export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi?.subtle) {
    throw new Error("Web Crypto subtle digest is not available in this runtime");
  }

  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await cryptoApi.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
