import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { isGzip, maybeGunzip } from "../src/decompress.ts";

const sqliteHeader = new TextEncoder().encode("SQLite format 3\0rest of the file");

test("passes plain SQLite bytes through", async () => {
  const buffer = sqliteHeader.slice().buffer;
  assert.equal(isGzip(buffer), false);
  assert.equal(await maybeGunzip(buffer), buffer);
});

test("gunzips a gzipped file", async () => {
  const gz = gzipSync(sqliteHeader);
  const buffer = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
  assert.equal(isGzip(buffer), true);
  assert.deepEqual(new Uint8Array(await maybeGunzip(buffer)), sqliteHeader);
});
