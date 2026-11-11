import { FileDragDepth, isFileDrag } from "./filedrop";
import "./style.css";
import type { KernelEvent, Stage, TraceData, WorkerResponse } from "./types";
import { overlapDuration, summarizeKernels, type KernelSummary, type TimeSpan } from "./breakdown";
import { maybeGunzip } from "./decompress";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-title">nsys-viewer</div>
      </div>
      <div class="top-actions">
        <span class="local-note">Local file · no upload</span>
        <button id="theme-toggle" class="button button-subtle" type="button"></button>
        <button id="open-button" class="button" type="button">Open trace…</button>
        <input id="file-input" type="file" accept=".sqlite,.db,.sqlite3,.gz" hidden />
      </div>
    </header>

    <main>
      <section id="empty-state" class="empty-state" aria-label="Open a trace">
        <h1>Open a trace</h1>
        <p>Drop an Nsight Systems SQLite export anywhere on the page, or choose a file.</p>
        <button id="drop-button" class="button" type="button">Choose SQLite file…</button>
        <small>The database is read in this browser tab.</small>
      </section>

      <section id="workspace" class="workspace hidden" aria-label="Trace timeline">
        <div class="workspace-heading">
          <div class="trace-heading">
            <strong id="file-title" tabindex="0" title="Double-click to rename">—</strong>
            <input id="title-input" class="title-input hidden" aria-label="Trace title" maxlength="200" />
            <button id="rename-title" class="button button-subtle" type="button">Rename</button>
            <button id="reset-title" class="button button-subtle hidden" type="button" title="Use the original filename">Reset title</button>
            <span id="trace-summary">—</span>
          </div>
          <div class="trace-stats"><span><strong id="kernel-count">—</strong> kernels</span><span><strong id="device-count">—</strong> GPUs</span><span><strong id="trace-span">—</strong> span</span></div>
        </div>

        <div class="viewer-card">
          <div class="toolbar">
            <div class="toolbar-group">
              <span class="toolbar-label">Timeline</span>
              <button id="zoom-out" class="icon-button" type="button" title="Zoom out">−</button>
              <button id="zoom-in" class="icon-button" type="button" title="Zoom in">+</button>
              <button id="fit-view" class="button button-subtle" type="button">Fit</button>
              <span id="view-range" class="view-range">—</span>
              <span id="selection-summary" class="selection-summary hidden">
                <strong id="selection-duration">—</strong>
                <span id="selection-bounds">—</span>
                <button id="clear-selection" type="button" aria-label="Clear time selection" title="Clear time selection">×</button>
              </span>
            </div>
            <div class="toolbar-group toolbar-right">
              <label class="workspace-picker">Workspace <select id="workspace-select" aria-label="Workspace"></select></label>
              <button id="new-workspace" class="button button-subtle" type="button" title="Create an empty workspace">New</button>
              <label class="search-box"><span aria-hidden="true">⌕</span><input id="kernel-search" type="search" placeholder="Find kernel" aria-label="Find kernel" /></label>
            </div>
          </div>

          <div class="timeline-head">
            <div class="stage-column-head">DEVICES</div>
            <canvas id="axis-canvas" class="axis-canvas" aria-label="Time axis"></canvas>
          </div>
          <div id="stage-rows" class="stage-rows"></div>
          <div class="timeline-footer">Drag to measure · drag either edge to adjust · click elsewhere on the timeline or press Esc to clear · Shift+drag or horizontal scroll to pan · pinch or +/− to zoom</div>
        </div>

        <div class="inspector-card">
          <div class="inspector-title">Kernel details</div>
          <div id="inspector-content" class="inspector-empty">Click any kernel bar to see its name, duration, device, and stream.</div>
        </div>

        <section class="breakdown-card" aria-label="Kernel breakdown">
          <div class="breakdown-heading">
            <strong id="breakdown-title">Kernel breakdown · full trace</strong>
            <label>Device <select id="breakdown-device" aria-label="Breakdown device"></select></label>
          </div>
          <p id="breakdown-note" class="breakdown-note"></p>
          <div class="breakdown-scroll">
            <table class="breakdown-table">
              <thead><tr>
                <th><button type="button" data-sort="name">Kernel <span></span></button></th>
                <th><button type="button" data-sort="count">Calls <span></span></button></th>
                <th><button type="button" data-sort="gpuMs">GPU time <span></span></button></th>
                <th class="span-column hidden"><button type="button" data-sort="spanShare">Span % <span></span></button></th>
                <th><button type="button" data-sort="gpuShare">GPU share <span></span></button></th>
                <th><button type="button" data-sort="avgMs">Avg <span></span></button></th>
                <th><button type="button" data-sort="wallMs">Wall coverage <span></span></button></th>
                <th><button type="button" data-sort="wallShare">Wall % <span></span></button></th>
              </tr></thead>
              <tbody id="breakdown-rows"></tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
    <div id="drop-overlay" class="drop-overlay hidden" aria-hidden="true"><span>Drop to open the trace</span></div>
    <div id="toast" class="toast hidden" role="status"></div>
    <div id="tooltip" class="tooltip hidden" role="tooltip"></div>
    <div id="stream-menu" class="stream-menu hidden" role="menu"></div>
  </div>
`;

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

const fileInput = element<HTMLInputElement>("#file-input");
const emptyState = element<HTMLElement>("#empty-state");
const dropOverlay = element<HTMLElement>("#drop-overlay");
const fileDrag = new FileDragDepth();
const workspace = element<HTMLElement>("#workspace");
const rows = element<HTMLDivElement>("#stage-rows");
const axis = element<HTMLCanvasElement>("#axis-canvas");
const tooltip = element<HTMLDivElement>("#tooltip");
const streamMenu = element<HTMLDivElement>("#stream-menu");
const workspaceSelect = element<HTMLSelectElement>("#workspace-select");
const toast = element<HTMLDivElement>("#toast");
const inspector = element<HTMLDivElement>("#inspector-content");
const search = element<HTMLInputElement>("#kernel-search");
const themeToggle = element<HTMLButtonElement>("#theme-toggle");
const selectionSummary = element<HTMLSpanElement>("#selection-summary");
const breakdownDevice = element<HTMLSelectElement>("#breakdown-device");
const breakdownRows = element<HTMLTableSectionElement>("#breakdown-rows");
const fileTitle = element<HTMLElement>("#file-title");
const titleInput = element<HTMLInputElement>("#title-input");
const renameTitle = element<HTMLButtonElement>("#rename-title");
const resetTitle = element<HTMLButtonElement>("#reset-title");

let trace: TraceData | null = null;
let fileKey = "";
let fileName = "";
let pendingFile: { key: string; name: string } | null = null;
let traceTitle = "";
let stageOrder: number[] = [];
let stageLabels: Record<number, string> = {};
interface KernelLane {
  events: KernelEvent[];
  prefixMaxEnd: number[];
  activeEnds: number[];
}
interface StreamLayout {
  deviceId: number;
  id: number;
  key: string;
  top: number;
  laneCount: number;
  collapsed: boolean;
  height: number;
  chipWidth: number;
}
const LANE_HEIGHT = 24;
const COLLAPSED_HEIGHT = 14;
const TRACK_GAP = 4;
// A panel is one timeline canvas, i.e. one device row: keyed by device id in
// the default view, or `ws:<workspace id>:<device id>` for a workspace's row
// of that device. Workspaces hold streams copied from any device.
interface StreamRef {
  deviceId: number;
  streamId: number;
}
interface Workspace {
  id: string;
  name: string;
  tracks: StreamRef[];
}
let kernelsByStream = new Map<number, Map<number, KernelLane>>();
let layoutsByPanel = new Map<string, StreamLayout[]>();
// Collapsed tracks, keyed `${panel}|${deviceId}:${streamId}` so a stream can be
// collapsed in its device row but expanded in a workspace.
let collapsedStreams = new Set<string>();
// Collapsed tracks and workspaces live in memory only (not saved to
// localStorage); they reset when a trace is loaded.
let workspaces: Workspace[] = [];
// null is the default per-device view.
let currentWorkspace: string | null = null;
// Track selection for bulk actions; it lives within one panel.
let streamSelection: { panel: string; keys: Set<string>; anchor: string } | null = null;
// Drop position while dragging a workspace track (drawn as a line).
let trackDrop: { panel: string; key: string; after: boolean } | null = null;
let kernelColors = new Map<number, string>();
let viewStartMs = 0;
let viewEndMs = 1;
let selected: KernelEvent | null = null;
let hovered: KernelEvent | null = null;
let selection: TimeSpan | null = null;
let drawPending = false;
let zoomTarget: { start: number; end: number } | null = null;
let zoomAnimating = false;
let toastTimer = 0;
let breakdownCache = new Map<string, { rows: KernelSummary[]; totalGpuMs: number }>();
let breakdownPending = false;
let breakdownSort: "name" | "count" | "gpuMs" | "gpuShare" | "avgMs" |
  "wallMs" | "wallShare" | "spanShare" = "gpuMs";
let breakdownDescending = true;

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
let themeOverride: "light" | "dark" | null = null;
try {
  const saved = localStorage.getItem("nsys-viewer:theme");
  if (saved === "light" || saved === "dark") themeOverride = saved;
} catch {
  // The viewer remains usable when local storage is unavailable.
}

function isDarkTheme(): boolean {
  return themeOverride ? themeOverride === "dark" : systemDark.matches;
}

function applyTheme(): void {
  const dark = isDarkTheme();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeToggle.textContent = dark ? "☀ Light mode" : "☾ Dark mode";
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", dark ? "#22252a" : "#edf0f3");
  refreshKernelColors();
}

themeToggle.addEventListener("click", () => {
  themeOverride = isDarkTheme() ? "light" : "dark";
  try {
    localStorage.setItem("nsys-viewer:theme", themeOverride);
  } catch {
    // The theme still changes for this page when local storage is unavailable.
  }
  applyTheme();
});
const darkKernelPalette = [
  "#426f96", "#3f796f", "#715f96",
  "#876251", "#627d5b", "#865c75",
];
const lightKernelPalette = [
  "#3a658a", "#346f66", "#66558a",
  "#7b5848", "#577150", "#795269",
];
const darkCanvas = {
  axis: "#252a2f", background: "#171b1f", track: "#252b30",
  alternate: "#20262b", grid: "#394148", text: "#aab4bd",
  edge: "#15191d", hover: "#f4dfb0", selected: "#f0c779",
  rangeFill: "#d5b26b24", rangeEdge: "#e7c277", chip: "#252b30e6",
  chipSelected: "#d5b26b", chipSelectedText: "#17191c", trackSelected: "#d5b26b1f",
};
const lightCanvas = {
  axis: "#f0f2f5", background: "#fff", track: "#edf1f4",
  alternate: "#f5f7f9", grid: "#cbd3da", text: "#4d5b67",
  edge: "#fff", hover: "#644812", selected: "#875714",
  rangeFill: "#ad854124", rangeEdge: "#9b6b1f", chip: "#edf1f4e6",
  chipSelected: "#9b6b1f", chipSelectedText: "#fff", trackSelected: "#9b6b1f1a",
};

function canvasColors() {
  return isDarkTheme() ? darkCanvas : lightCanvas;
}

function colorForName(name: string): string {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  }
  const palette = isDarkTheme() ? darkKernelPalette : lightKernelPalette;
  return palette[(hash >>> 0) % palette.length];
}

function refreshKernelColors(): void {
  if (!trace) return;
  kernelColors = new Map(Object.entries(trace.names).map(
    ([id, name]) => [Number(id), colorForName(name)],
  ));
  requestDraw();
}
systemDark.addEventListener("change", () => {
  if (!themeOverride) applyTheme();
});
applyTheme();

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  if (event.data.type === "error") {
    announce(event.data.message, true);
    element<HTMLButtonElement>("#open-button").disabled = false;
    return;
  }
  loadTrace(event.data.trace);
};
worker.onerror = () => {
  announce("The browser could not start the SQLite parser.", true);
  element<HTMLButtonElement>("#open-button").disabled = false;
};

function announce(message: string, isError = false): void {
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.classList.toggle("error", isError);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 5500);
}

function formatTime(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)} s`;
  if (ms >= 1) return `${ms.toFixed(2)} ms`;
  return `${(ms * 1000).toFixed(1)} µs`;
}

function shortName(name: string): string {
  return name.length > 96 ? `${name.slice(0, 93)}…` : name;
}

function currentLayoutKey(): string {
  return `nsys-viewer:layout:${fileKey}`;
}

function saveLayout(): void {
  if (!trace) return;
  try {
    localStorage.setItem(
      currentLayoutKey(),
      JSON.stringify({
        order: stageOrder,
        labels: stageLabels,
      }),
    );
  } catch {
    // The viewer remains usable when local storage is unavailable.
  }
}

function restoreLayout(devices: number[]): void {
  stageOrder = [...devices];
  stageLabels = Object.fromEntries(devices.map((id) => [id, `GPU ${id}`]));
  collapsedStreams = new Set();
  workspaces = [];
  currentWorkspace = null;
  streamSelection = null;
  try {
    const saved = localStorage.getItem(currentLayoutKey())
      ?? localStorage.getItem(`nsys-sqlite-viewer:layout:${fileKey}`);
    if (!saved) return;
    const layout: unknown = JSON.parse(saved);
    if (typeof layout !== "object" || layout === null) return;
    const data = layout as { order?: unknown; labels?: unknown };
    if (Array.isArray(data.order)) {
      const retained = data.order.filter(
        (id): id is number => typeof id === "number" && devices.includes(id),
      );
      stageOrder = [...new Set(retained), ...devices.filter((id) => !retained.includes(id))];
    }
    if (typeof data.labels === "object" && data.labels !== null) {
      for (const id of devices) {
        const value = (data.labels as Record<string, unknown>)[id];
        if (typeof value === "string" && value.trim()) {
          stageLabels[id] = value.trim();
        }
      }
    }
  } catch {
    // Invalid saved state is ignored.
  }
}

function applyTraceTitle(): void {
  fileTitle.textContent = traceTitle;
  fileTitle.title = `${fileName} · Double-click to rename`;
  document.title = `${traceTitle} · nsys-viewer`;
  resetTitle.classList.toggle("hidden", traceTitle === fileName);
}

function finishTitleEdit(save: boolean): void {
  if (save) {
    traceTitle = titleInput.value.trim() || fileName;
    try {
      const key = `nsys-viewer:title:${fileKey}`;
      if (traceTitle === fileName) localStorage.removeItem(key);
      else localStorage.setItem(key, traceTitle);
    } catch {
      // Renaming still works in this tab when storage is unavailable.
    }
    applyTraceTitle();
  }
  titleInput.classList.add("hidden");
  fileTitle.classList.remove("hidden");
  renameTitle.classList.remove("hidden");
}

function startTitleEdit(): void {
  titleInput.value = traceTitle;
  fileTitle.classList.add("hidden");
  renameTitle.classList.add("hidden");
  titleInput.classList.remove("hidden");
  titleInput.focus();
  titleInput.select();
}

renameTitle.addEventListener("click", startTitleEdit);
fileTitle.addEventListener("dblclick", startTitleEdit);
fileTitle.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === "F2") startTitleEdit();
});
titleInput.addEventListener("blur", () => {
  if (!titleInput.classList.contains("hidden")) finishTitleEdit(true);
});
titleInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== "Escape") return;
  event.stopPropagation();
  event.preventDefault();
  finishTitleEdit(event.key === "Enter");
  renameTitle.focus();
});
resetTitle.addEventListener("click", () => {
  titleInput.value = fileName;
  finishTitleEdit(true);
});

async function openFile(file: File): Promise<void> {
  if (!/\.(sqlite|sqlite3|db)(\.gz)?$/i.test(file.name)) {
    announce("Choose an Nsight SQLite export (.sqlite, .sqlite3, or .db, optionally gzipped).", true);
    return;
  }
  if (element<HTMLButtonElement>("#open-button").disabled) {
    announce("Still opening the previous trace; try again when it has loaded.", true);
    return;
  }
  // Workspaces live only in memory, so replacing the trace would lose them.
  if (workspaces.length && !window.confirm(
    `Open ${file.name}? The current trace's workspaces will be discarded.`)) return;
  element<HTMLButtonElement>("#open-button").disabled = true;
  announce(`Opening ${file.name} locally…`);
  pendingFile = { key: `${file.name}:${file.size}`, name: file.name };
  try {
    const buffer = await maybeGunzip(await file.arrayBuffer());
    worker.postMessage({ buffer }, [buffer]);
  } catch (error) {
    announce(error instanceof Error ? error.message : String(error), true);
    element<HTMLButtonElement>("#open-button").disabled = false;
  }
}

function loadTrace(data: TraceData): void {
  if (pendingFile) {
    fileKey = pendingFile.key;
    // The default title names the trace, not its compression.
    fileName = pendingFile.name.replace(/\.gz$/i, "");
    pendingFile = null;
  }
  traceTitle = fileName;
  try {
    traceTitle = localStorage.getItem(`nsys-viewer:title:${fileKey}`)?.trim() || fileName;
  } catch {
    // Fall back to the filename when storage is unavailable.
  }
  finishTitleEdit(false);
  applyTraceTitle();
  trace = data;
  hideStreamMenu();
  trackDrop = null;
  zoomTarget = null;
  hovered = null;
  selected = null;
  tooltip.classList.add("hidden");
  setSelection(null);
  kernelsByStream = new Map(data.stages.map((stage) => [
    stage.deviceId,
    new Map(stage.streamIds.map((id) => [id, {
      events: [], prefixMaxEnd: [], activeEnds: [],
    }])),
  ]));
  layoutsByPanel = new Map();
  kernelColors = new Map();
  for (const kernel of data.kernels) {
    const lane = kernelsByStream.get(kernel.deviceId)?.get(kernel.streamId);
    if (!lane) continue;
    let overlapLane = lane.activeEnds.findIndex((end) => end <= kernel.startMs);
    if (overlapLane < 0) overlapLane = lane.activeEnds.length;
    lane.activeEnds[overlapLane] = kernel.endMs;
    kernel.overlapLane = overlapLane;
    lane.events.push(kernel);
    lane.prefixMaxEnd.push(Math.max(
      kernel.endMs,
      lane.prefixMaxEnd.at(-1) ?? -Infinity,
    ));
  }
  refreshKernelColors();
  restoreLayout(data.stages.map((stage) => stage.deviceId));
  computeLayouts();
  viewStartMs = 0;
  viewEndMs = data.durationMs;
  selected = null;
  inspector.textContent = "Click any kernel bar to see its name, duration, device, and stream.";
  inspector.className = "inspector-empty";
  emptyState.classList.add("hidden");
  workspace.classList.remove("hidden");
  element<HTMLElement>("#trace-summary").textContent =
    `Nsight SQLite schema ${data.schemaVersion} · parsed entirely in this browser`;
  element<HTMLElement>("#kernel-count").textContent = data.kernels.length.toLocaleString();
  element<HTMLElement>("#device-count").textContent = String(data.stages.length);
  element<HTMLElement>("#trace-span").textContent = formatTime(data.durationMs);
  element<HTMLButtonElement>("#open-button").disabled = false;
  breakdownCache = new Map();
  breakdownSort = "gpuMs";
  breakdownDescending = true;
  breakdownDevice.replaceChildren(new Option("All GPUs", "all"));
  for (const stage of data.stages) {
    breakdownDevice.add(new Option(`GPU ${stage.deviceId}`, String(stage.deviceId)));
  }
  renderRows();
  renderBreakdown();
  requestDraw();
  window.clearTimeout(toastTimer);
  toast.classList.add("hidden");
}

function streamKey(deviceId: number, streamId: number): string {
  return `${deviceId}:${streamId}`;
}

function buildLayouts(panel: string,
  streams: StreamRef[]): StreamLayout[] {
  let top = 4;
  return streams.map(({ deviceId, streamId }) => {
    const laneCount = kernelsByStream.get(deviceId)?.get(streamId)?.activeEnds.length ?? 1;
    const key = streamKey(deviceId, streamId);
    const collapsed = collapsedStreams.has(`${panel}|${key}`);
    const height = collapsed ? COLLAPSED_HEIGHT : laneCount * LANE_HEIGHT + 2;
    const layout = { deviceId, id: streamId, key, top, laneCount, collapsed, height, chipWidth: 0 };
    top += height + TRACK_GAP;
    return layout;
  });
}

function computeLayouts(): void {
  if (!trace) return;
  layoutsByPanel = new Map();
  for (const stage of trace.stages) {
    const streams = stage.streamIds.map((streamId) => ({ deviceId: stage.deviceId, streamId }));
    layoutsByPanel.set(String(stage.deviceId), buildLayouts(String(stage.deviceId), streams));
  }
  // A workspace has one row per device; within it, tracks keep ws.tracks
  // order, which the user can change by dragging.
  for (const ws of workspaces) {
    for (const stage of trace.stages) {
      const tracks = ws.tracks.filter((item) => item.deviceId === stage.deviceId);
      if (!tracks.length) continue;
      const panel = workspacePanel(ws.id, stage.deviceId);
      layoutsByPanel.set(panel, buildLayouts(panel, tracks));
    }
  }
}

function panelContentHeight(panel: string): number {
  const last = layoutsByPanel.get(panel)?.at(-1);
  return last ? last.top + last.height + 6 : 38;
}

function relayout(): void {
  computeLayouts();
  renderRows();
}

function setCollapsed(panel: string, keys: string[], collapse: boolean): void {
  for (const key of keys) {
    if (collapse) collapsedStreams.add(`${panel}|${key}`);
    else collapsedStreams.delete(`${panel}|${key}`);
  }
  relayout();
}

function workspacePanel(id: string, deviceId: number): string {
  return `ws:${id}:${deviceId}`;
}

function isWorkspacePanel(panel: string): boolean {
  return panel.startsWith("ws:");
}

function panelWorkspace(panel: string): Workspace | undefined {
  if (!isWorkspacePanel(panel)) return undefined;
  const id = panel.split(":")[1];
  return workspaces.find((item) => item.id === id);
}

function createWorkspace(): Workspace {
  const taken = new Set(workspaces.map((ws) => ws.name));
  let index = workspaces.length + 1;
  while (taken.has(`Workspace ${index}`)) index++;
  const ws = { id: Math.random().toString(36).slice(2, 10), name: `Workspace ${index}`, tracks: [] };
  workspaces.push(ws);
  return ws;
}

function switchWorkspace(id: string | null): void {
  currentWorkspace = id;
  streamSelection = null;
  hideStreamMenu();
  tooltip.classList.add("hidden");
  hovered = null;
  renderRows();
}

function copyToWorkspace(streams: StreamRef[], target: string | null): void {
  const ws = workspaces.find((item) => item.id === target) ?? createWorkspace();
  const existing = new Set(ws.tracks.map((item) => streamKey(item.deviceId, item.streamId)));
  let added = 0;
  for (const item of streams) {
    const key = streamKey(item.deviceId, item.streamId);
    if (existing.has(key) || !kernelsByStream.get(item.deviceId)?.has(item.streamId)) continue;
    existing.add(key);
    ws.tracks.push(item);
    added++;
  }
  relayout();
  announce(added
    ? `Copied ${added} stream${added === 1 ? "" : "s"} to ${ws.name}`
    : `Already in ${ws.name}`);
}

// Where a dragged track would land: before/after a track of the same device,
// picked by the pointer's panel-space y. Tracks never cross device groups.
function trackDropAt(panel: string, deviceId: number, y: number):
  { key: string; after: boolean } | null {
  const group = (layoutsByPanel.get(panel) ?? []).filter((layout) => layout.deviceId === deviceId);
  for (const layout of group) {
    if (y < layout.top + layout.height / 2) return { key: layout.key, after: false };
  }
  const last = group.at(-1);
  return last ? { key: last.key, after: true } : null;
}

function moveWorkspaceTracks(panel: string, draggedKey: string,
  drop: { key: string; after: boolean }): void {
  const ws = panelWorkspace(panel);
  if (!ws) return;
  const keyOf = (item: StreamRef) => streamKey(item.deviceId, item.streamId);
  const dragged = ws.tracks.find((item) => keyOf(item) === draggedKey);
  if (!dragged) return;
  // Dragging a selected track moves every selected track on that device.
  const selectedKeys = isStreamSelected(panel, draggedKey) ? streamSelection?.keys : null;
  const moving = ws.tracks.filter((item) => item.deviceId === dragged.deviceId &&
    (selectedKeys ? selectedKeys.has(keyOf(item)) : keyOf(item) === draggedKey));
  const movingKeys = new Set(moving.map(keyOf));
  if (movingKeys.has(drop.key)) return;
  const rest = ws.tracks.filter((item) => !movingKeys.has(keyOf(item)));
  const index = rest.findIndex((item) => keyOf(item) === drop.key);
  if (index < 0) return;
  rest.splice(drop.after ? index + 1 : index, 0, ...moving);
  ws.tracks = rest;
  relayout();
}

function removeFromWorkspace(id: string, keys: Set<string>): void {
  const ws = workspaces.find((item) => item.id === id);
  if (!ws) return;
  ws.tracks = ws.tracks.filter((item) => !keys.has(streamKey(item.deviceId, item.streamId)));
  for (const item of [...collapsedStreams]) {
    const [panel, key] = item.split("|");
    if (panel.startsWith(`ws:${id}:`) && keys.has(key)) collapsedStreams.delete(item);
  }
  streamSelection = null;
  relayout();
}

function deleteWorkspace(id: string): void {
  const ws = workspaces.find((item) => item.id === id);
  if (!ws || !window.confirm(`Delete workspace "${ws.name}"?`)) return;
  workspaces = workspaces.filter((item) => item !== ws);
  const prefix = `ws:${id}:`;
  for (const key of [...collapsedStreams]) {
    if (key.startsWith(prefix)) collapsedStreams.delete(key);
  }
  if (currentWorkspace === id) currentWorkspace = null;
  streamSelection = null;
  relayout();
}

function renderWorkspacePicker(): void {
  workspaceSelect.replaceChildren(
    new Option("Default (all GPUs)", ""),
    ...workspaces.map((ws) => new Option(`${ws.name} · ${ws.tracks.length}`, ws.id)),
  );
  workspaceSelect.value = currentWorkspace ?? "";
}

function isStreamSelected(panel: string, key: string): boolean {
  return streamSelection?.panel === panel && streamSelection.keys.has(key);
}

// Click selects one track, Shift+click extends from the last clicked track
// (in track order), Cmd/Ctrl+click toggles one track.
function selectStream(panel: string, key: string, event: MouseEvent): void {
  const order = layoutsByPanel.get(panel)?.map((layout) => layout.key) ?? [];
  const current = streamSelection?.panel === panel ? streamSelection : null;
  if (event.shiftKey && current) {
    const from = order.indexOf(current.anchor);
    const to = order.indexOf(key);
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    streamSelection = { panel, keys: new Set(range), anchor: current.anchor };
  } else if ((event.metaKey || event.ctrlKey) && current) {
    const keys = new Set(current.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    streamSelection = keys.size ? { panel, keys, anchor: key } : null;
  } else {
    streamSelection = { panel, keys: new Set([key]), anchor: key };
  }
  requestDraw();
}

function clearStreamSelection(): void {
  if (!streamSelection) return;
  streamSelection = null;
  requestDraw();
}

function hideStreamMenu(): void {
  streamMenu.classList.add("hidden");
}

interface MenuEntry {
  label: string;
  action?: () => void;
  children?: MenuEntry[];
}

function menuElement(entry: MenuEntry): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "menuitem";
  button.textContent = entry.label;
  if (!entry.children) {
    button.addEventListener("click", () => {
      hideStreamMenu();
      entry.action?.();
    });
    return button;
  }
  // Submenus open on hover/focus (CSS); see .stream-submenu.
  button.classList.add("has-submenu");
  button.setAttribute("aria-haspopup", "menu");
  const wrap = document.createElement("div");
  wrap.className = "submenu-wrap";
  const submenu = document.createElement("div");
  submenu.className = "stream-submenu";
  submenu.role = "menu";
  submenu.append(...entry.children.map(menuElement));
  wrap.append(button, submenu);
  const fitSubmenu = () => {
    submenu.style.top = "";
    const { bottom } = submenu.getBoundingClientRect();
    const overflow = bottom - (window.innerHeight - 4);
    if (overflow > 0) submenu.style.top = `${-5 - overflow}px`;
  };
  wrap.addEventListener("mouseenter", fitSubmenu);
  wrap.addEventListener("focusin", fitSubmenu);
  return wrap;
}

function showStreamMenu(panel: string, event: MouseEvent): void {
  if (!streamSelection || !trace) return;
  const keys = new Set(streamSelection.keys);
  const layouts = layoutsByPanel.get(panel) ?? [];
  const chosen = layouts.filter((layout) => keys.has(layout.key));
  const others = layouts.filter((layout) => !keys.has(layout.key)).map((layout) => layout.key);
  const count = chosen.length === 1 ? trackLabel(panel, chosen[0]) : `${chosen.length} streams`;
  const streams = chosen.map((layout) => ({ deviceId: layout.deviceId, streamId: layout.id }));
  const currentId = panelWorkspace(panel)?.id ?? null;
  const targets = (picked: StreamRef[]): MenuEntry[] => [
    ...workspaces
      .filter((ws) => ws.id !== currentId)
      .map((ws) => ({ label: ws.name, action: () => copyToWorkspace(picked, ws.id) })),
    { label: "New workspace", action: () => copyToWorkspace(picked, null) },
  ];
  const entries: MenuEntry[] = [];
  if (currentId) {
    entries.push({ label: `Remove ${count} from workspace`,
      action: () => removeFromWorkspace(currentId, keys) });
  }
  entries.push({ label: `Copy ${count} to workspace`, children: targets(streams) });
  if (trace.stages.length > 1) {
    // Same stream id on every device, e.g. to compare ranks.
    const streamIds = [...new Set(chosen.map((layout) => layout.id))];
    const label = streamIds.length === 1 ? `S${streamIds[0]}` : `${streamIds.length} stream ids`;
    entries.push({ label: `Copy ${label} on all GPUs to workspace`, children: targets(
      streamIds.flatMap((streamId) => stageOrder.map((deviceId) => ({ deviceId, streamId }))),
    ) });
  }
  entries.push(
    { label: `Collapse ${count}`, action: () => setCollapsed(panel, [...keys], true) },
    { label: `Expand ${count}`, action: () => setCollapsed(panel, [...keys], false) },
    { label: "Collapse all others", action: () => {
      for (const key of others) collapsedStreams.add(`${panel}|${key}`);
      setCollapsed(panel, [...keys], false);
    } },
    { label: "Clear selection", action: clearStreamSelection },
  );
  streamMenu.replaceChildren(...entries.map(menuElement));
  streamMenu.classList.remove("hidden");
  const { width, height } = streamMenu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - width - 4);
  streamMenu.style.left = `${left}px`;
  streamMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 4)}px`;
  // Open submenus to the left when there is no room on the right.
  streamMenu.classList.toggle("flip", left + width + 260 > window.innerWidth);
}

function trackLabel(panel: string, layout: StreamLayout): string {
  return `S${layout.id}`;
}

function kernelBreakdown(device: string): { rows: KernelSummary[]; totalGpuMs: number } {
  const cached = breakdownCache.get(device);
  if (cached) return cached;
  if (!trace) return { rows: [], totalGpuMs: 0 };
  const result = summarizeKernels(trace, device,
    selection ?? { start: 0, end: trace.durationMs });
  breakdownCache.set(device, result);
  return result;
}

function percent(part: number, whole: number): string {
  const value = whole > 0 ? part / whole * 100 : 0;
  return `${value < 0.1 ? value.toFixed(2) : value.toFixed(1)}%`;
}

function renderBreakdown(): void {
  if (!trace) return;
  const spanDurationMs = selection ? selection.end - selection.start : trace.durationMs;
  element<HTMLElement>("#breakdown-title").textContent = selection
    ? `Kernel breakdown · selected span · ${formatTime(spanDurationMs)}`
    : "Kernel breakdown · full trace";
  document.querySelectorAll<HTMLElement>(".span-column").forEach((column) => {
    column.classList.toggle("hidden", !selection);
  });
  const { rows, totalGpuMs } = kernelBreakdown(breakdownDevice.value);
  const term = search.value.trim().toLowerCase();
  const filtered = rows.filter((row) => row.name.toLowerCase().includes(term));
  const value = (row: KernelSummary): number => {
    switch (breakdownSort) {
      case "count": return row.count;
      case "gpuMs": return row.gpuMs;
      case "gpuShare": return totalGpuMs ? row.gpuMs / totalGpuMs : 0;
      case "avgMs": return row.gpuMs / row.count;
      case "wallMs": return row.wallMs;
      case "wallShare": return spanDurationMs > 0 ? row.wallMs / spanDurationMs : 0;
      case "spanShare": return spanDurationMs > 0 ? row.gpuMs / spanDurationMs : 0;
      default: return 0;
    }
  };
  filtered.sort((a, b) => {
    const difference = breakdownSort === "name"
      ? a.name.localeCompare(b.name) : value(a) - value(b);
    return (breakdownDescending ? -1 : 1) * difference || a.name.localeCompare(b.name);
  });
  const fragment = document.createDocumentFragment();
  for (const row of filtered) {
    const tr = document.createElement("tr");
    const cells = [
      row.name,
      row.count.toLocaleString(),
      formatTime(row.gpuMs),
      ...(selection ? [percent(row.gpuMs, spanDurationMs)] : []),
      percent(row.gpuMs, totalGpuMs),
      formatTime(row.gpuMs / row.count),
      formatTime(row.wallMs),
      percent(row.wallMs, spanDurationMs),
    ];
    for (const [index, content] of cells.entries()) {
      const td = document.createElement("td");
      td.textContent = content;
      if (index === 0) {
        td.className = "kernel-name";
        td.title = content;
      }
      tr.append(td);
    }
    fragment.append(tr);
  }
  if (!filtered.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = selection ? 8 : 7;
    td.className = "breakdown-empty";
    td.textContent = rows.length ? "No kernel names match your search."
      : selection ? "No kernels overlap this span on the selected device(s)."
      : "No kernels on the selected device(s).";
    tr.append(td);
    fragment.append(tr);
  }
  breakdownRows.replaceChildren(fragment);
  element<HTMLElement>("#breakdown-note").textContent =
    `${filtered.length} of ${rows.length} names · GPU share = summed kernel time / ` +
    `${formatTime(totalGpuMs)} total GPU time. ` +
    (selection ? `Span % = summed kernel time / ${formatTime(spanDurationMs)} selected span; ` +
      `concurrent kernels and multiple GPUs can exceed 100%. Calls include overlapping launches; ` +
      `GPU time and Avg use only their time inside the span. ` : "") +
    `Wall % = each name’s union coverage / ${formatTime(spanDurationMs)} ` +
    `${selection ? "selected" : "trace"} span. Names overlap, so Wall % does not ` +
    `add up and does not measure removable latency.`;
  document.querySelectorAll<HTMLButtonElement>(
    ".breakdown-table thead button",
  ).forEach((button) => {
    const active = button.dataset.sort === breakdownSort;
    const arrow = button.querySelector("span");
    if (arrow) arrow.textContent = active ? breakdownDescending ? "↓" : "↑" : "";
    button.closest("th")?.setAttribute("aria-sort", active
      ? breakdownDescending ? "descending" : "ascending" : "none");
  });
}

// Rows can be thousands of pixels tall (one track per stream). Keep the canvas
// viewport-sized and sticky, and draw the scrolled-to slice of the row:
// canvases taller than the GPU max texture size (16384 device px) fall back to
// software raster and make every frame take hundreds of ms.
function appendTimeline(row: HTMLElement, panel: string, label: string): void {
  const canvas = document.createElement("canvas");
  canvas.className = "stage-canvas";
  const rowHeight = panelContentHeight(panel);
  // min-height: a row with few/collapsed tracks still fits its device controls.
  row.style.minHeight = `${rowHeight}px`;
  canvas.style.height = `min(${rowHeight - 1}px, calc(100vh - var(--axis-height)))`;
  canvas.setAttribute("aria-label", label);
  bindTimelineEvents(canvas, panel);
  row.append(canvas);
}

function collapseAllButton(panel: string, keys: string[]): HTMLButtonElement {
  const allCollapsed = keys.length > 0 && keys.every((key) => collapsedStreams.has(`${panel}|${key}`));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stage-collapse";
  button.textContent = allCollapsed ? "Expand all streams" : "Collapse all streams";
  button.addEventListener("click", () => setCollapsed(panel, keys, !allCollapsed));
  return button;
}

function renderWorkspaceBar(ws: Workspace): void {
  const bar = document.createElement("div");
  bar.className = "workspace-bar";
  const name = document.createElement("input");
  name.className = "stage-label";
  name.value = ws.name;
  name.maxLength = 40;
  name.setAttribute("aria-label", "Workspace name");
  name.title = "Rename workspace";
  name.addEventListener("change", () => {
    ws.name = name.value.trim() || ws.name;
    name.value = ws.name;
    renderWorkspacePicker();
  });
  const devices = new Set(ws.tracks.map((item) => item.deviceId)).size;
  const count = document.createElement("span");
  count.className = "workspace-count";
  count.textContent = `${ws.tracks.length} stream${ws.tracks.length === 1 ? "" : "s"} · ` +
    `${devices} GPU${devices === 1 ? "" : "s"}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "stage-collapse";
  remove.textContent = "Delete workspace";
  remove.addEventListener("click", () => deleteWorkspace(ws.id));
  bar.append(name, count, remove);
  rows.append(bar);
  if (!ws.tracks.length) {
    const hint = document.createElement("div");
    hint.className = "workspace-empty";
    hint.textContent = "Empty workspace. In Default, right-click a stream (or a selection) " +
      "and choose Copy to workspace.";
    rows.append(hint);
  }
}

// One device row: the default view's row of all the device's streams, or a
// workspace's row of the streams it holds for that device.
function renderDeviceRow(stage: Stage, panel: string): void {
  const deviceId = stage.deviceId;
  const row = document.createElement("div");
  row.className = "stage-row";
  row.dataset.deviceId = String(deviceId);
  row.dataset.panel = panel;

  const meta = document.createElement("div");
  meta.className = "stage-meta";
  const top = document.createElement("div");
  top.className = "stage-top";
  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.draggable = true;
  handle.title = "Drag to reorder";
  handle.setAttribute("aria-label", `Drag ${stageLabels[deviceId]} to reorder`);
  handle.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/plain", String(deviceId));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => row.classList.remove("dragging"));

  const label = document.createElement("input");
  label.className = "stage-label";
  label.value = stageLabels[deviceId];
  label.maxLength = 24;
  label.setAttribute("aria-label", `Label for CUDA device ${deviceId}`);
  label.title = "Edit device label";
  label.addEventListener("change", () => {
    stageLabels[deviceId] = label.value.trim() || `GPU ${deviceId}`;
    label.value = stageLabels[deviceId];
    saveLayout();
  });
  top.append(handle, label);

  const sub = document.createElement("div");
  sub.className = "stage-sub";
  sub.textContent = `GPU ${stage.deviceId} · PID ${stage.pid ?? "?"}`;
  sub.title = `${stage.kernelCount.toLocaleString()} kernels`;

  const keys = (layoutsByPanel.get(panel) ?? []).map((layout) => layout.key);
  meta.append(top, sub, collapseAllButton(panel, keys));

  row.append(meta);
  appendTimeline(row, panel, `${stageLabels[deviceId]} GPU timeline`);
  row.addEventListener("dragover", (event) => {
    if (isFileDrag(event.dataTransfer?.types)) return;
    event.preventDefault();
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("drop-target");
    const draggedId = event.dataTransfer?.getData("text/plain");
    if (!draggedId) return;
    const from = Number(draggedId);
    if (!stageOrder.includes(from) || from === deviceId) return;
    stageOrder.splice(stageOrder.indexOf(from), 1);
    stageOrder.splice(stageOrder.indexOf(deviceId), 0, from);
    saveLayout();
    renderRows();
  });
  rows.append(row);
}

function renderRows(): void {
  if (!trace) return;
  rows.replaceChildren();
  renderWorkspacePicker();
  const ws = workspaces.find((item) => item.id === currentWorkspace);
  if (ws) renderWorkspaceBar(ws);
  for (const deviceId of stageOrder) {
    const stage = trace.stages.find((item) => item.deviceId === deviceId);
    if (!stage) continue;
    const panel = ws ? workspacePanel(ws.id, deviceId) : String(deviceId);
    if (layoutsByPanel.has(panel)) renderDeviceRow(stage, panel);
  }
  requestDraw();
}

function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function prepareCanvas(canvas: HTMLCanvasElement): {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
} | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(rect.width * ratio);
  const pixelHeight = Math.round(rect.height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function tickValues(): number[] {
  const span = viewEndMs - viewStartMs;
  const step = niceStep(span / 8);
  const ticks: number[] = [];
  for (let value = Math.ceil(viewStartMs / step) * step; value <= viewEndMs; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function xFor(ms: number, width: number): number {
  return ((ms - viewStartMs) / (viewEndMs - viewStartMs)) * width;
}

function setSelection(next: TimeSpan | null): void {
  selection = next;
  selectionSummary.classList.toggle("hidden", !next);
  if (next) {
    element<HTMLElement>("#selection-duration").textContent =
      `Δ ${formatTime(next.end - next.start)}`;
    element<HTMLElement>("#selection-bounds").textContent =
      `${formatTime(next.start)} – ${formatTime(next.end)}`;
  }
  breakdownCache.clear();
  if (!next && breakdownSort === "spanShare") breakdownSort = "gpuMs";
  if (!breakdownPending) {
    breakdownPending = true;
    requestAnimationFrame(() => {
      breakdownPending = false;
      renderBreakdown();
    });
  }
  if (selected) inspect(selected);
  tooltip.classList.add("hidden");
  requestDraw();
}

function drawSelection(ctx: CanvasRenderingContext2D, width: number,
  height: number, handles = false): void {
  if (!selection) return;
  const colors = canvasColors();
  const startX = xFor(selection.start, width);
  const endX = xFor(selection.end, width);
  const left = Math.max(0, startX);
  const right = Math.min(width, endX);
  if (right > left) {
    ctx.fillStyle = colors.rangeFill;
    ctx.fillRect(left, 0, right - left, height);
  }
  ctx.strokeStyle = colors.rangeEdge;
  ctx.lineWidth = 1;
  ctx.fillStyle = colors.rangeEdge;
  for (const x of [startX, endX]) {
    if (x < 0 || x > width) continue;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
    ctx.stroke();
    if (handles) ctx.fillRect(x - 3, height - 11, 7, 11);
  }
}

function drawAxis(): void {
  const surface = prepareCanvas(axis);
  if (!surface) return;
  const { context: ctx, width, height } = surface;
  const colors = canvasColors();
  ctx.fillStyle = colors.axis;
  ctx.fillRect(0, 0, width, height);
  ctx.font = "11px ui-monospace, SFMono-Regular, Consolas, monospace";
  ctx.textBaseline = "middle";
  for (const value of tickValues()) {
    const x = xFor(value, width);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, height - 10);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.fillText(formatTime(value), Math.min(x + 5, width - 65), height / 2);
  }
  drawSelection(ctx, width, height, true);
}

function firstVisible(lane: KernelLane, start: number): number {
  let low = 0;
  let high = lane.events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lane.prefixMaxEnd[middle] < start) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Panel-space y of the canvas's top edge: how far the sticky canvas has slid
// down inside its row.
function trackOffset(canvas: HTMLCanvasElement, panel: string): number {
  const row = canvas.parentElement;
  if (!row) return 0;
  return canvas.getBoundingClientRect().top - row.getBoundingClientRect().top;
}

function drawTracks(canvas: HTMLCanvasElement, panel: string): void {
  const rowRect = canvas.parentElement?.getBoundingClientRect();
  if (rowRect && (rowRect.bottom < 0 || rowRect.top > window.innerHeight)) return;
  const surface = prepareCanvas(canvas);
  if (!surface || !trace) return;
  const { context: ctx, width, height } = surface;
  const offset = trackOffset(canvas, panel);
  const colors = canvasColors();
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  const allLayouts = layoutsByPanel.get(panel) ?? [];
  const isVisible = (layout: StreamLayout) =>
    layout.top + layout.height > offset && layout.top < offset + height;
  const layouts = allLayouts.filter(isVisible);
  ctx.save();
  ctx.translate(0, -offset);
  for (const [index, layout] of allLayouts.entries()) {
    if (!isVisible(layout)) continue;
    ctx.fillStyle = index % 2 ? colors.alternate : colors.track;
    ctx.fillRect(0, layout.top, width, layout.height);
    if (isStreamSelected(panel, layout.key)) {
      ctx.fillStyle = colors.trackSelected;
      ctx.fillRect(0, layout.top, width, layout.height);
    }
  }
  ctx.restore();

  for (const value of tickValues()) {
    const x = xFor(value, width);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }

  const term = search.value.trim().toLowerCase();
  ctx.font = "11px ui-monospace, SFMono-Regular, Consolas, monospace";
  ctx.textBaseline = "middle";
  ctx.save();
  ctx.translate(0, -offset);
  for (const layout of layouts) {
    const lane = kernelsByStream.get(layout.deviceId)?.get(layout.id);
    if (!lane) continue;
    const lastTinyPixel = new Array<number>(layout.laneCount).fill(-1);
    const lastEndX = new Array<number>(layout.laneCount).fill(-Infinity);
    for (let i = firstVisible(lane, viewStartMs); i < lane.events.length; i++) {
      const kernel = lane.events[i];
      if (kernel.startMs > viewEndMs) break;
      // A collapsed stream draws every overlap lane into one thin strip.
      const overlapLane = layout.collapsed ? 0 : kernel.overlapLane ?? 0;
      // A kernel that starts less than a pixel after the previous one in its lane ends
      // touches it on screen and needs a divider; one after idle time keeps its full width.
      const startX = xFor(kernel.startMs, width);
      const touches = startX - lastEndX[overlapLane] < 1;
      lastEndX[overlapLane] = Math.max(lastEndX[overlapLane], xFor(kernel.endMs, width));
      if (kernel.endMs < viewStartMs) continue;
      const x0 = Math.max(0, startX);
      const x1 = Math.min(width, xFor(kernel.endMs, width));
      const barWidth = Math.max(1, x1 - x0);
      const top = layout.top + (layout.collapsed ? 3 : 3 + overlapLane * LANE_HEIGHT);
      const barHeight = layout.collapsed ? COLLAPSED_HEIGHT - 6 : 20;
      if (barWidth <= 1 && Math.floor(x0) === lastTinyPixel[overlapLane]) continue;
      if (barWidth <= 1) lastTinyPixel[overlapLane] = Math.floor(x0);
      const name = trace.names[kernel.nameId] ?? "";
      ctx.globalAlpha = term && !name.toLowerCase().includes(term) ? 0.13 : 0.92;
      ctx.fillStyle = kernelColors.get(kernel.nameId) ?? "#587f95";
      ctx.fillRect(x0, top, barWidth, barHeight);
      if (touches && barWidth >= 3 && ctx.globalAlpha > 0.5) {
        // One 1 px divider at the kernel's start: back-to-back kernels stay 1 px apart. A border on both
        // sides put 2-3 px of near-background colour between them, which reads as an idle gap.
        ctx.fillStyle = colors.edge;
        ctx.fillRect(Math.round(x0), top, 1, barHeight);
      }
      if (!layout.collapsed && barWidth >= 10 && ctx.globalAlpha > 0.5) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 2, top, barWidth - 3, 20);
        ctx.clip();
        ctx.fillStyle = "#fff";
        ctx.fillText(name, x0 + 3, top + 10);
        ctx.restore();
      }
      if (kernel === selected || kernel === hovered) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = kernel === selected ? colors.selected : colors.hover;
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 0.5, top + 0.5, Math.max(2, x1 - x0), barHeight - 1);
      }
    }
  }
  // Stream chips go on top of the bars so they stay readable and clickable.
  ctx.globalAlpha = 1;
  ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
  for (const layout of layouts) {
    const text = `${layout.collapsed ? "▸" : "▾"} ${trackLabel(panel, layout)}`;
    const chipHeight = layout.collapsed ? COLLAPSED_HEIGHT - 2 : 16;
    layout.chipWidth = Math.ceil(ctx.measureText(text).width) + 8;
    const chipSelected = isStreamSelected(panel, layout.key);
    ctx.fillStyle = chipSelected ? colors.chipSelected : colors.chip;
    ctx.fillRect(2, layout.top + 1, layout.chipWidth, chipHeight);
    ctx.fillStyle = chipSelected ? colors.chipSelectedText : colors.text;
    ctx.fillText(text, 6, layout.top + 1 + chipHeight / 2);
  }
  const drop = trackDrop?.panel === panel ? trackDrop : null;
  const dropLayout = drop && allLayouts.find((layout) => layout.key === drop.key);
  if (drop && dropLayout) {
    const y = drop.after ? dropLayout.top + dropLayout.height + TRACK_GAP / 2 : dropLayout.top - TRACK_GAP / 2;
    ctx.fillStyle = colors.rangeEdge;
    ctx.fillRect(0, y - 1, width, 2);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  drawSelection(ctx, width, height);
}

function draw(): void {
  drawPending = false;
  if (!trace) return;
  drawAxis();
  for (const row of Array.from(rows.querySelectorAll<HTMLElement>(".stage-row"))) {
    const canvas = row.querySelector("canvas");
    if (canvas && row.dataset.panel) drawTracks(canvas, row.dataset.panel);
  }
  element<HTMLElement>("#view-range").textContent =
    `${formatTime(viewStartMs)} — ${formatTime(viewEndMs)}`;
}

function requestDraw(): void {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(draw);
}

function setView(start: number, end: number): void {
  if (!trace) return;
  zoomTarget = null;
  const duration = trace.durationMs;
  const span = Math.min(duration, Math.max(0.01, end - start));
  viewStartMs = Math.max(0, Math.min(duration - span, start));
  viewEndMs = viewStartMs + span;
  requestDraw();
}

function zoom(factor: number, anchorFraction = 0.5): void {
  if (!trace) return;
  const sourceStart = zoomTarget?.start ?? viewStartMs;
  const sourceEnd = zoomTarget?.end ?? viewEndMs;
  const span = sourceEnd - sourceStart;
  const anchor = sourceStart + span * anchorFraction;
  const next = Math.min(trace.durationMs, Math.max(0.01, span * factor));
  const start = Math.max(0, Math.min(trace.durationMs - next, anchor - next * anchorFraction));
  zoomTarget = { start, end: start + next };
  if (!zoomAnimating) {
    zoomAnimating = true;
    requestAnimationFrame(animateZoom);
  }
}

function animateZoom(): void {
  if (!zoomTarget) {
    zoomAnimating = false;
    return;
  }
  const target = zoomTarget;
  viewStartMs += (target.start - viewStartMs) * 0.42;
  viewEndMs += (target.end - viewEndMs) * 0.42;
  const epsilon = Math.max(0.00001, (trace?.durationMs ?? 1) * 0.0000001);
  if (Math.abs(viewStartMs - target.start) < epsilon &&
      Math.abs(viewEndMs - target.end) < epsilon) {
    viewStartMs = target.start;
    viewEndMs = target.end;
    zoomTarget = null;
    zoomAnimating = false;
  } else {
    requestAnimationFrame(animateZoom);
  }
  requestDraw();
}

function layoutAt(panel: string, canvas: HTMLCanvasElement,
  event: MouseEvent): StreamLayout | undefined {
  const y = event.clientY - canvas.getBoundingClientRect().top + trackOffset(canvas, panel);
  return layoutsByPanel.get(panel)?.find(
    (item) => y >= item.top && y < item.top + item.height,
  );
}

function hitChip(panel: string, canvas: HTMLCanvasElement,
  event: MouseEvent): { layout: StreamLayout; onArrow: boolean } | null {
  const layout = layoutAt(panel, canvas, event);
  if (!layout) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top + trackOffset(canvas, panel);
  const chipHeight = layout.collapsed ? COLLAPSED_HEIGHT - 2 : 16;
  const inside = x >= 2 && x < 2 + layout.chipWidth &&
    y >= layout.top + 1 && y < layout.top + 1 + chipHeight;
  return inside ? { layout, onArrow: x < 14 } : null;
}

function hitKernel(panel: string, canvas: HTMLCanvasElement, event: PointerEvent): KernelEvent | null {
  if (!trace) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top + trackOffset(canvas, panel);
  const time = viewStartMs + (x / rect.width) * (viewEndMs - viewStartMs);
  const layout = layoutAt(panel, canvas, event);
  if (!layout) return null;
  const overlapLane = Math.floor((y - layout.top) / LANE_HEIGHT);
  const lane = kernelsByStream.get(layout.deviceId)?.get(layout.id);
  if (!lane) return null;
  let best: KernelEvent | null = null;
  for (let i = firstVisible(lane, time); i < lane.events.length; i++) {
    const kernel = lane.events[i];
    if (kernel.startMs > time) break;
    if (kernel.endMs < time) continue;
    if (!layout.collapsed && kernel.overlapLane !== overlapLane) continue;
    // A collapsed track paints overlapping kernels in event order, so the
    // visible one is the last match; expanded lanes never overlap.
    if (layout.collapsed) best = kernel;
    else if (!best || kernel.endMs - kernel.startMs < best.endMs - best.startMs) best = kernel;
  }
  return best;
}

function showTooltip(kernel: KernelEvent, event: PointerEvent): void {
  if (!trace) return;
  const name = trace.names[kernel.nameId] ?? "Unknown kernel";
  tooltip.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = shortName(name);
  const detail = document.createElement("span");
  detail.textContent = `${stageLabels[kernel.deviceId]} · ${formatTime(kernel.endMs - kernel.startMs)}`;
  tooltip.append(title, detail);
  if (selection) {
    const spanDetail = document.createElement("span");
    const overlap = overlapDuration(kernel, selection);
    spanDetail.textContent = `${formatTime(overlap)} in span · ` +
      `${percent(overlap, selection.end - selection.start)} of selected span`;
    tooltip.append(spanDetail);
  }
  tooltip.classList.remove("hidden");
  tooltip.style.left = `${Math.min(event.clientX + 16, window.innerWidth - 330)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 16, window.innerHeight - 90)}px`;
}

function inspect(kernel: KernelEvent): void {
  if (!trace) return;
  selected = kernel;
  inspector.className = selection ? "inspector-grid inspector-span" : "inspector-grid";
  inspector.replaceChildren();
  const fields: [string, string][] = [
    ["NAME", trace.names[kernel.nameId] ?? "Unknown kernel"],
    ["DURATION", formatTime(kernel.endMs - kernel.startMs)],
    ["START", formatTime(kernel.startMs)],
    ["DEVICE", `${stageLabels[kernel.deviceId]} / CUDA ${kernel.deviceId}`],
    ["STREAM", String(kernel.streamId)],
    ["END", formatTime(kernel.endMs)],
  ];
  if (selection) {
    const overlap = overlapDuration(kernel, selection);
    fields.splice(2, 0, ["IN SELECTED SPAN",
      `${formatTime(overlap)} · ${percent(overlap, selection.end - selection.start)}`]);
  }
  for (const [label, value] of fields) {
    const field = document.createElement("div");
    field.className = "inspector-field";
    const heading = document.createElement("span");
    heading.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    content.title = value;
    field.append(heading, content);
    inspector.append(field);
  }
  requestDraw();
}

type TimelineDrag =
  | { mode: "pan"; x: number; start: number; end: number; moved: boolean }
  | { mode: "new"; x: number; anchor: number; moved: boolean }
  | { mode: "start" | "end" }
  | { mode: "track"; key: string; deviceId: number; y: number; moved: boolean };

function bindTimelineEvents(canvas: HTMLCanvasElement, panel?: string): void {
  let drag: TimelineDrag | null = null;
  const timeAt = (event: PointerEvent): number => {
    const rect = canvas.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return viewStartMs + fraction * (viewEndMs - viewStartMs);
  };
  canvas.addEventListener("wheel", (event) => {
    const rect = canvas.getBoundingClientRect();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.width : 1;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      event.preventDefault();
      zoom(Math.exp(event.deltaY * unit * 0.012),
        (event.clientX - rect.left) / rect.width);
    } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      const delta = event.shiftKey ? event.deltaY : event.deltaX;
      const shift = delta * unit / rect.width * (viewEndMs - viewStartMs);
      setView(viewStartMs + shift, viewEndMs + shift);
    }
  }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    hideStreamMenu();
    const chip = event.button === 0 && panel ? hitChip(panel, canvas, event) : null;
    if (chip && panel) {
      if (chip.onArrow) {
        setCollapsed(panel, [chip.layout.key], !chip.layout.collapsed);
        return;
      }
      const key = chip.layout.key;
      if (!isWorkspacePanel(panel)) {
        selectStream(panel, key, event);
        return;
      }
      // In a workspace a chip can be dragged to reorder. Pressing an already
      // selected chip keeps the selection so it moves as a block; a click
      // without dragging narrows the selection to it on pointerup.
      const modifier = event.shiftKey || event.metaKey || event.ctrlKey;
      if (modifier || !isStreamSelected(panel, key)) selectStream(panel, key, event);
      drag = { mode: "track", key, deviceId: chip.layout.deviceId, y: event.clientY, moved: false };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (event.shiftKey || event.button === 1) {
      drag = { mode: "pan", x: event.clientX, start: viewStartMs,
        end: viewEndMs, moved: false };
    } else if (selection) {
      const startDistance = Math.abs(x - xFor(selection.start, rect.width));
      const endDistance = Math.abs(x - xFor(selection.end, rect.width));
      if (Math.min(startDistance, endDistance) <= 8) {
        drag = { mode: startDistance <= endDistance ? "start" : "end" };
      } else {
        drag = { mode: "new", x: event.clientX, anchor: timeAt(event), moved: false };
      }
    } else {
      drag = { mode: "new", x: event.clientX, anchor: timeAt(event), moved: false };
    }
    canvas.setPointerCapture(event.pointerId);
    tooltip.classList.add("hidden");
    if (hovered) {
      hovered = null;
      requestDraw();
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag?.mode === "track") {
      if (Math.abs(event.clientY - drag.y) > 4) drag.moved = true;
      if (!drag.moved || !panel) return;
      canvas.style.cursor = "grabbing";
      const y = event.clientY - canvas.getBoundingClientRect().top + trackOffset(canvas, panel);
      const drop = trackDropAt(panel, drag.deviceId, y);
      trackDrop = drop ? { panel, ...drop } : null;
      requestDraw();
      return;
    }
    if (drag) {
      if (drag.mode === "pan") {
        const delta = event.clientX - drag.x;
        if (Math.abs(delta) > 3) drag.moved = true;
        if (!drag.moved) return;
        const width = canvas.getBoundingClientRect().width;
        const shift = (delta / width) * (drag.end - drag.start);
        setView(drag.start - shift, drag.end - shift);
        canvas.style.cursor = "grabbing";
      } else if (drag.mode === "new") {
        if (Math.abs(event.clientX - drag.x) > 3) drag.moved = true;
        if (drag.moved) {
          const time = timeAt(event);
          setSelection({ start: Math.min(drag.anchor, time),
            end: Math.max(drag.anchor, time) });
        }
      } else if (selection) {
        const time = timeAt(event);
        if (drag.mode === "start") {
          if (time <= selection.end) setSelection({ start: time, end: selection.end });
          else {
            setSelection({ start: selection.end, end: time });
            drag.mode = "end";
          }
        } else if (time >= selection.start) {
          setSelection({ start: selection.start, end: time });
        } else {
          setSelection({ start: time, end: selection.start });
          drag.mode = "start";
        }
      }
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const nearEdge = selection && [selection.start, selection.end].some(
      (time) => Math.abs(x - xFor(time, rect.width)) <= 8,
    );
    const onChip = !nearEdge && panel ? hitChip(panel, canvas, event) : null;
    canvas.style.cursor = nearEdge ? "ew-resize" : onChip ? "pointer" : "crosshair";
    const kernel = panel && !onChip ? hitKernel(panel, canvas, event) : null;
    if (hovered !== kernel) {
      hovered = kernel;
      requestDraw();
    }
    if (kernel) showTooltip(kernel, event);
    else tooltip.classList.add("hidden");
  });
  canvas.addEventListener("contextmenu", (event) => {
    if (!panel) return;
    const layout = layoutAt(panel, canvas, event);
    if (!layout) return;
    event.preventDefault();
    if (!isStreamSelected(panel, layout.key)) {
      streamSelection = { panel, keys: new Set([layout.key]), anchor: layout.key };
      requestDraw();
    }
    tooltip.classList.add("hidden");
    showStreamMenu(panel, event);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (drag?.mode === "track") {
      const { key, moved } = drag;
      const drop = trackDrop;
      drag = null;
      trackDrop = null;
      canvas.style.cursor = "crosshair";
      if (moved && drop && panel) moveWorkspaceTracks(panel, key, drop);
      else if (!moved && panel && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        selectStream(panel, key, event);
      }
      requestDraw();
      return;
    }
    if (drag?.mode === "new" && !drag.moved) {
      if (selection) {
        const time = timeAt(event);
        if (time < selection.start || time > selection.end) setSelection(null);
      }
      if (panel) {
        const kernel = hitKernel(panel, canvas, event);
        if (kernel) inspect(kernel);
      }
    }
    drag = null;
    canvas.style.cursor = "crosshair";
  });
  canvas.addEventListener("pointercancel", () => {
    drag = null;
    trackDrop = null;
    canvas.style.cursor = "crosshair";
  });
  canvas.addEventListener("pointerleave", () => {
    tooltip.classList.add("hidden");
    if (hovered) {
      hovered = null;
      requestDraw();
    }
  });
}

element<HTMLButtonElement>("#open-button").addEventListener("click", () => fileInput.click());
element<HTMLButtonElement>("#drop-button").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
  fileInput.value = "";
});
// A file can be dropped anywhere in the window, also to replace the open trace; without this the
// browser navigates to the dropped file and the viewer is lost.
function showFileDrag(active: boolean): void {
  dropOverlay.classList.toggle("hidden", !active || !emptyState.classList.contains("hidden"));
  emptyState.classList.toggle("file-hover", active);
}
window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event.dataTransfer?.types)) return;
  event.preventDefault();
  showFileDrag(fileDrag.enter());
});
window.addEventListener("dragover", (event) => {
  if (!isFileDrag(event.dataTransfer?.types)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (event) => {
  if (!isFileDrag(event.dataTransfer?.types)) return;
  showFileDrag(fileDrag.leave());
});
window.addEventListener("drop", (event) => {
  if (!isFileDrag(event.dataTransfer?.types)) return;
  event.preventDefault();
  fileDrag.reset();
  showFileDrag(false);
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});
element<HTMLButtonElement>("#fit-view").addEventListener("click", () => {
  if (trace) setView(0, trace.durationMs);
});
element<HTMLButtonElement>("#zoom-in").addEventListener("click", () => zoom(0.4));
element<HTMLButtonElement>("#zoom-out").addEventListener("click", () => zoom(2.5));
element<HTMLElement>(".viewer-card").addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey && !event.altKey &&
      Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    event.preventDefault();
  }
}, { capture: true, passive: false });
element<HTMLButtonElement>("#clear-selection").addEventListener("click", () => setSelection(null));
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!streamMenu.classList.contains("hidden")) hideStreamMenu();
  else if (streamSelection) clearStreamSelection();
  else if (selection) setSelection(null);
});
window.addEventListener("pointerdown", (event) => {
  if (!streamMenu.contains(event.target as Node)) hideStreamMenu();
}, { capture: true });
window.addEventListener("scroll", hideStreamMenu, { passive: true });
bindTimelineEvents(axis);
workspaceSelect.addEventListener("change", () => switchWorkspace(workspaceSelect.value || null));
element<HTMLButtonElement>("#new-workspace").addEventListener("click", () => {
  if (!trace) return;
  const ws = createWorkspace();
  computeLayouts();
  switchWorkspace(ws.id);
});
breakdownDevice.addEventListener("change", renderBreakdown);
document.querySelectorAll<HTMLButtonElement>(
  ".breakdown-table thead button",
).forEach((button) => {
  button.addEventListener("click", () => {
    const sort = button.dataset.sort as typeof breakdownSort;
    if (sort === breakdownSort) breakdownDescending = !breakdownDescending;
    else {
      breakdownSort = sort;
      breakdownDescending = sort !== "name";
    }
    renderBreakdown();
  });
});
search.addEventListener("input", () => {
  requestDraw();
  renderBreakdown();
});
new ResizeObserver(requestDraw).observe(element<HTMLElement>("#workspace"));
// Stage canvases only hold the visible slice of each row, so redraw on scroll.
window.addEventListener("scroll", requestDraw, { passive: true });
window.addEventListener("resize", requestDraw);
