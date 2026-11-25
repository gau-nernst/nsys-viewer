import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { GRAPH_SIDE_STREAMS_SQL } from "./graphstreams";
import type { KernelEvent, Stage, TraceData, WorkerResponse } from "./types";

function scalar(db: Database, sql: string): unknown {
  const result = db.exec(sql);
  return result[0]?.values[0]?.[0];
}

function readTrace(db: Database): TraceData {
  const required = [
    "CUPTI_ACTIVITY_KIND_KERNEL",
    "StringIds",
    "TARGET_INFO_CUDA_CONTEXT_INFO",
  ];
  const tables = new Set(
    db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values.map(
      (row) => String(row[0]),
    ) ?? [],
  );
  const missing = required.filter((table) => !tables.has(table));
  if (missing.length) throw new Error(`Missing Nsight tables: ${missing.join(", ")}`);

  const startNs = Number(scalar(db, "SELECT MIN(start) FROM CUPTI_ACTIVITY_KIND_KERNEL"));
  const endNs = Number(scalar(db, "SELECT MAX(end) FROM CUPTI_ACTIVITY_KIND_KERNEL"));
  if (!Number.isFinite(startNs) || !Number.isFinite(endNs) || endNs <= startNs) {
    throw new Error("This export has no GPU kernel interval to display.");
  }

  const names: Record<number, string> = {};
  const nameQuery = db.prepare(`
    SELECT DISTINCT k.demangledName, s.value
    FROM CUPTI_ACTIVITY_KIND_KERNEL AS k
    JOIN StringIds AS s ON s.id = k.demangledName
  `);
  try {
    while (nameQuery.step()) {
      const [id, value] = nameQuery.get();
      const name = String(value);
      names[Number(id)] = name;
    }
  } finally {
    nameQuery.free();
  }

  const pidByDevice = new Map<number, number>();
  const contexts = db.prepare(
    "SELECT DISTINCT deviceId, processId FROM TARGET_INFO_CUDA_CONTEXT_INFO",
  );
  try {
    while (contexts.step()) {
      const [deviceId, pid] = contexts.get();
      pidByDevice.set(Number(deviceId), Number(pid));
    }
  } finally {
    contexts.free();
  }

  const counts = new Map<number, number>();
  const streams = new Map<number, Set<number>>();
  const kernels: KernelEvent[] = [];
  const query = db.prepare(`
    SELECT start, end, deviceId, streamId, demangledName
    FROM CUPTI_ACTIVITY_KIND_KERNEL
    ORDER BY start
  `);
  try {
    while (query.step()) {
      const [start, end, deviceId, streamId, nameId] = query.get();
      const device = Number(deviceId);
      const id = Number(nameId);
      kernels.push({
        startMs: (Number(start) - startNs) / 1e6,
        endMs: (Number(end) - startNs) / 1e6,
        deviceId: device,
        streamId: Number(streamId),
        nameId: id,
      });
      counts.set(device, (counts.get(device) ?? 0) + 1);
      if (!streams.has(device)) streams.set(device, new Set());
      streams.get(device)?.add(Number(streamId));
    }
  } finally {
    query.free();
  }

  // Older exports have no graphId column; their side streams stay unfolded.
  const graphSideOf = new Map<number, Record<number, number>>();
  const kernelColumns = db.exec("PRAGMA table_info(CUPTI_ACTIVITY_KIND_KERNEL)")[0]?.values ?? [];
  if (kernelColumns.some((row) => row[1] === "graphId")) {
    for (const [deviceId, side, launch] of db.exec(GRAPH_SIDE_STREAMS_SQL)[0]?.values ?? []) {
      if (!graphSideOf.has(Number(deviceId))) graphSideOf.set(Number(deviceId), {});
      graphSideOf.get(Number(deviceId))![Number(side)] = Number(launch);
    }
  }
  const stages: Stage[] = [...counts.entries()]
    .map(([deviceId, kernelCount]) => ({
      deviceId,
      pid: pidByDevice.get(deviceId) ?? null,
      kernelCount,
      streamIds: [...(streams.get(deviceId) ?? [])].sort((a, b) => a - b),
      graphSideOf: graphSideOf.get(deviceId) ?? {},
    }))
    .sort((a, b) => a.deviceId - b.deviceId);

  let schemaVersion = "unknown";
  if (tables.has("META_DATA_EXPORT")) {
    const value = scalar(
      db,
      "SELECT value FROM META_DATA_EXPORT WHERE name = 'EXPORT_SCHEMA_VERSION'",
    );
    if (value != null) schemaVersion = String(value);
  }

  return {
    schemaVersion,
    durationMs: (endNs - startNs) / 1e6,
    stages,
    names,
    kernels,
  };
}

self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const db = new SQL.Database(new Uint8Array(event.data.buffer));
    try {
      const trace = readTrace(db);
      self.postMessage({ type: "loaded", trace } satisfies WorkerResponse);
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: "error", message } satisfies WorkerResponse);
  }
};
