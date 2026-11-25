export interface KernelEvent {
  startMs: number;
  endMs: number;
  deviceId: number;
  streamId: number;
  nameId: number;
  overlapLane?: number;
}

export interface Stage {
  deviceId: number;
  pid: number | null;
  kernelCount: number;
  streamIds: number[];
  // CUDA graph side stream id → the stream its graphs launch on (see graphstreams.ts).
  graphSideOf: Record<number, number>;
}

export interface TraceData {
  schemaVersion: string;
  durationMs: number;
  stages: Stage[];
  names: Record<number, string>;
  kernels: KernelEvent[];
}

export type WorkerResponse =
  | { type: "loaded"; trace: TraceData }
  | { type: "error"; message: string };
