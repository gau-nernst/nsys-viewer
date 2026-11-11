const GZIP_MAGIC = [0x1f, 0x8b];

export function isGzip(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  return bytes.length === 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/** Returns the buffer unchanged, or its gunzipped bytes when it starts with the gzip magic. */
export async function maybeGunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isGzip(buffer)) return buffer;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress .gz files; gunzip the file first.");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
