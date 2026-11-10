import "./style.css";
import type { KernelEvent, Stage, TraceData, WorkerResponse } from "./types";
import { overlapDuration, summarizeKernels, type KernelSummary, type TimeSpan } from "./breakdown";

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
        <input id="file-input" type="file" accept=".sqlite,.db,.sqlite3" hidden />
      </div>
    </header>

    <main>
      <section id="empty-state" class="empty-state" aria-label="Open a trace">
        <h1>Open a trace</h1>
        <p>Drop an Nsight Systems SQLite export here, or choose a file.</p>
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
    <div id="toast" class="toast hidden" role="status"></div>
    <div id="tooltip" class="tooltip hidden" role="tooltip"></div>
  </div>
`;

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

const fileInput = element<HTMLInputElement>("#file-input");
const emptyState = element<HTMLElement>("#empty-state");
const workspace = element<HTMLElement>("#workspace");
const rows = element<HTMLDivElement>("#stage-rows");
const axis = element<HTMLCanvasElement>("#axis-canvas");
const tooltip = element<HTMLDivElement>("#tooltip");
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
  id: number;
  top: number;
  laneCount: number;
}
let kernelsByStream = new Map<number, Map<number, KernelLane>>();
let layoutsByDevice = new Map<number, StreamLayout[]>();
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
  rangeFill: "#d5b26b24", rangeEdge: "#e7c277",
};
const lightCanvas = {
  axis: "#f0f2f5", background: "#fff", track: "#edf1f4",
  alternate: "#f5f7f9", grid: "#cbd3da", text: "#4d5b67",
  edge: "#fff", hover: "#644812", selected: "#875714",
  rangeFill: "#ad854124", rangeEdge: "#9b6b1f",
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
      JSON.stringify({ order: stageOrder, labels: stageLabels }),
    );
  } catch {
    // The viewer remains usable when local storage is unavailable.
  }
}

function restoreLayout(devices: number[]): void {
  stageOrder = [...devices];
  stageLabels = Object.fromEntries(devices.map((id) => [id, `GPU ${id}`]));
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
  if (!/\.(sqlite|sqlite3|db)$/i.test(file.name)) {
    announce("Choose an Nsight SQLite export (.sqlite, .sqlite3, or .db).", true);
    return;
  }
  element<HTMLButtonElement>("#open-button").disabled = true;
  announce(`Opening ${file.name} locally…`);
  pendingFile = { key: `${file.name}:${file.size}`, name: file.name };
  try {
    const buffer = await file.arrayBuffer();
    worker.postMessage({ buffer }, [buffer]);
  } catch (error) {
    announce(error instanceof Error ? error.message : String(error), true);
    element<HTMLButtonElement>("#open-button").disabled = false;
  }
}

function loadTrace(data: TraceData): void {
  if (pendingFile) {
    fileKey = pendingFile.key;
    fileName = pendingFile.name;
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
  layoutsByDevice = new Map();
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
  for (const stage of data.stages) {
    let top = 4;
    const layouts = stage.streamIds.map((id) => {
      const laneCount = kernelsByStream.get(stage.deviceId)?.get(id)?.activeEnds.length ?? 1;
      const layout = { id, top, laneCount };
      top += laneCount * 24 + 6;
      return layout;
    });
    layoutsByDevice.set(stage.deviceId, layouts);
  }
  refreshKernelColors();
  restoreLayout(data.stages.map((stage) => stage.deviceId));
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

function renderRows(): void {
  if (!trace) return;
  rows.replaceChildren();
  for (const deviceId of stageOrder) {
    const stage = trace.stages.find((item) => item.deviceId === deviceId);
    if (!stage) continue;

    const row = document.createElement("div");
    row.className = "stage-row";
    row.dataset.deviceId = String(deviceId);

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

    meta.append(top, sub);

    const canvas = document.createElement("canvas");
    canvas.className = "stage-canvas";
    const layouts = layoutsByDevice.get(deviceId) ?? [];
    const last = layouts.at(-1);
    const rowHeight = last ? last.top + last.laneCount * 24 + 8 : 38;
    row.style.height = `${rowHeight}px`;
    // Rows can be thousands of pixels tall (one track per stream). Keep the
    // canvas viewport-sized and sticky, and draw the scrolled-to slice of the
    // row: canvases taller than the GPU max texture size (16384 device px)
    // fall back to software raster and make every frame take hundreds of ms.
    canvas.style.height = `min(${rowHeight - 1}px, calc(100vh - var(--axis-height)))`;
    canvas.setAttribute("aria-label", `${stageLabels[deviceId]} GPU timeline`);
    bindTimelineEvents(canvas, stage);
    row.append(meta, canvas);
    row.addEventListener("dragover", (event) => {
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

// How far the sticky canvas has slid down inside its row, i.e. the row-space y
// of the canvas's top edge.
function rowScrollOffset(canvas: HTMLCanvasElement): number {
  const row = canvas.parentElement;
  if (!row) return 0;
  return canvas.getBoundingClientRect().top - row.getBoundingClientRect().top;
}

function drawStage(canvas: HTMLCanvasElement, stage: Stage): void {
  const rowRect = canvas.parentElement?.getBoundingClientRect();
  if (rowRect && (rowRect.bottom < 0 || rowRect.top > window.innerHeight)) return;
  const surface = prepareCanvas(canvas);
  if (!surface || !trace) return;
  const { context: ctx, width, height } = surface;
  const offset = rowScrollOffset(canvas);
  const colors = canvasColors();
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  const allLayouts = layoutsByDevice.get(stage.deviceId) ?? [];
  const isVisible = (layout: StreamLayout) =>
    layout.top + layout.laneCount * 24 + 2 > offset && layout.top < offset + height;
  const layouts = allLayouts.filter(isVisible);
  ctx.save();
  ctx.translate(0, -offset);
  for (const [index, layout] of allLayouts.entries()) {
    if (!isVisible(layout)) continue;
    ctx.fillStyle = index % 2 ? colors.alternate : colors.track;
    ctx.fillRect(0, layout.top, width, layout.laneCount * 24 + 2);
    ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.fillStyle = colors.text;
    ctx.fillText(`S${layout.id}`, 6, layout.top + 16);
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
    const lane = kernelsByStream.get(stage.deviceId)?.get(layout.id);
    if (!lane) continue;
    const lastTinyPixel = new Array<number>(layout.laneCount).fill(-1);
    for (let i = firstVisible(lane, viewStartMs); i < lane.events.length; i++) {
      const kernel = lane.events[i];
      if (kernel.startMs > viewEndMs) break;
      if (kernel.endMs < viewStartMs) continue;
      const x0 = Math.max(0, xFor(kernel.startMs, width));
      const x1 = Math.min(width, xFor(kernel.endMs, width));
      const barWidth = Math.max(1, x1 - x0);
      const overlapLane = kernel.overlapLane ?? 0;
      const top = layout.top + 3 + overlapLane * 24;
      if (barWidth <= 1 && Math.floor(x0) === lastTinyPixel[overlapLane]) continue;
      if (barWidth <= 1) lastTinyPixel[overlapLane] = Math.floor(x0);
      const name = trace.names[kernel.nameId] ?? "";
      ctx.globalAlpha = term && !name.toLowerCase().includes(term) ? 0.13 : 0.92;
      ctx.fillStyle = kernelColors.get(kernel.nameId) ?? "#587f95";
      ctx.fillRect(x0, top, barWidth, 20);
      if (barWidth >= 3 && ctx.globalAlpha > 0.5) {
        ctx.strokeStyle = colors.edge;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, top + 0.5, barWidth - 1, 19);
      }
      if (barWidth >= 10 && ctx.globalAlpha > 0.5) {
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
        ctx.strokeRect(x0 + 0.5, top + 0.5, Math.max(2, x1 - x0), 19);
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  drawSelection(ctx, width, height);
}

function draw(): void {
  drawPending = false;
  if (!trace) return;
  drawAxis();
  for (const stage of trace.stages) {
    const canvas = rows.querySelector<HTMLCanvasElement>(
      `.stage-row[data-device-id="${stage.deviceId}"] canvas`,
    );
    if (canvas) drawStage(canvas, stage);
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

function hitKernel(stage: Stage, canvas: HTMLCanvasElement, event: PointerEvent): KernelEvent | null {
  if (!trace) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top + rowScrollOffset(canvas);
  const time = viewStartMs + (x / rect.width) * (viewEndMs - viewStartMs);
  const layout = layoutsByDevice.get(stage.deviceId)?.find(
    (item) => y >= item.top && y < item.top + item.laneCount * 24,
  );
  if (!layout) return null;
  const overlapLane = Math.floor((y - layout.top) / 24);
  const lane = kernelsByStream.get(stage.deviceId)?.get(layout.id);
  if (!lane) return null;
  let best: KernelEvent | null = null;
  for (let i = firstVisible(lane, time); i < lane.events.length; i++) {
    const kernel = lane.events[i];
    if (kernel.startMs > time) break;
    if (kernel.endMs < time || kernel.overlapLane !== overlapLane) continue;
    if (!best || kernel.endMs - kernel.startMs < best.endMs - best.startMs) best = kernel;
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
  | { mode: "start" | "end" };

function bindTimelineEvents(canvas: HTMLCanvasElement, stage?: Stage): void {
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
    canvas.style.cursor = nearEdge ? "ew-resize" : "crosshair";
    const kernel = stage ? hitKernel(stage, canvas, event) : null;
    if (hovered !== kernel) {
      hovered = kernel;
      requestDraw();
    }
    if (kernel) showTooltip(kernel, event);
    else tooltip.classList.add("hidden");
  });
  canvas.addEventListener("pointerup", (event) => {
    if (drag?.mode === "new" && !drag.moved) {
      if (selection) {
        const time = timeAt(event);
        if (time < selection.start || time > selection.end) setSelection(null);
      }
      if (stage) {
        const kernel = hitKernel(stage, canvas, event);
        if (kernel) inspect(kernel);
      }
    }
    drag = null;
    canvas.style.cursor = "crosshair";
  });
  canvas.addEventListener("pointercancel", () => {
    drag = null;
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
emptyState.addEventListener("dragover", (event) => {
  event.preventDefault();
  emptyState.classList.add("file-hover");
});
emptyState.addEventListener("dragleave", () => emptyState.classList.remove("file-hover"));
emptyState.addEventListener("drop", (event) => {
  event.preventDefault();
  emptyState.classList.remove("file-hover");
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
  if (event.key === "Escape" && selection) setSelection(null);
});
bindTimelineEvents(axis);
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
