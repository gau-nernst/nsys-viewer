import assert from "node:assert/strict";
import test from "node:test";
import initSqlJs from "sql.js";
import { GRAPH_SIDE_STREAMS_SQL } from "../src/graphstreams.ts";

const SQL = await initSqlJs();

// Kernels as [streamId, graphId, deviceId = 0]; returns sorted [deviceId, side, launch] rows.
function sides(kernels) {
  const db = new SQL.Database();
  db.run("CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (deviceId INTEGER, streamId INTEGER, graphId INTEGER)");
  for (const [streamId, graphId, deviceId = 0] of kernels) {
    db.run("INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (?, ?, ?)", [deviceId, streamId, graphId]);
  }
  const rows = db.exec(GRAPH_SIDE_STREAMS_SQL)[0]?.values ?? [];
  db.close();
  return rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

test("per-graph side streams fold onto the stream the graphs launch on", () => {
  assert.deepEqual(sides([[7, null], [7, 1], [7, 1], [100, 1], [7, 2], [7, 2], [101, 2], [101, 2]]),
    [[0, 100, 7], [0, 101, 7]]);
});

test("a graph forking onto several side streams folds all of them", () => {
  assert.deepEqual(sides([[7, null], [7, 1], [7, 1], [100, 1], [101, 1]]), [[0, 100, 7], [0, 101, 7]]);
});

test("a stream with eager kernels is the launch stream even if a branch runs more", () => {
  assert.deepEqual(sides([[7, null], [7, 1], [100, 1], [100, 1], [100, 1]]), [[0, 100, 7]]);
});

test("streams with eager kernels, or shared by graphs of two launch streams, stay", () => {
  assert.deepEqual(sides([
    [7, null], [8, null], [7, 1], [7, 1], [50, 1], [50, null],
    [7, 2], [7, 2], [60, 2], [8, 3], [8, 3], [60, 3],
  ]), []);
});

test("devices are handled separately", () => {
  assert.deepEqual(sides([[7, 1, 0], [7, 1, 0], [9, 1, 0], [7, 1, 1], [7, 1, 1]]), [[0, 9, 7]]);
});
