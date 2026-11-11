import assert from "node:assert/strict";
import test from "node:test";
import { PAN_RATE_PER_MS, heldKeysView, isNavKey, isTextEntry, zoomedView } from "../src/wasd.ts";

test("the point under the mouse stays put while zooming", () => {
  const view = zoomedView(100, 200, 0.25, 0.5);
  assert.deepEqual(view, { start: 112.5, end: 162.5 });
  assert.equal(view.start + (view.end - view.start) * 0.25, 125);
});

test("W zooms in, S zooms out, A / D pan by the view width", () => {
  const zoomIn = heldKeysView(0, 100, ["w"], 100, 0.5);
  assert.ok(zoomIn.end - zoomIn.start < 100);
  assert.equal((zoomIn.start + zoomIn.end) / 2, 50);
  const zoomOut = heldKeysView(0, 100, ["s"], 100, 0.5);
  assert.ok(zoomOut.end - zoomOut.start > 100);
  assert.deepEqual(heldKeysView(0, 100, ["d"], 100, 0.5), { start: 100 * PAN_RATE_PER_MS * 100, end: 100 + 100 * PAN_RATE_PER_MS * 100 });
  assert.deepEqual(heldKeysView(0, 100, ["a", "d"], 100, 0.5), { start: 0, end: 100 });
  assert.deepEqual(heldKeysView(0, 100, ["w", "s"], 100, 0.5), { start: 0, end: 100 });
});

test("only W, A, S, D are navigation keys, and not while typing", () => {
  assert.deepEqual(["w", "a", "s", "d", "q", "toString"].map(isNavKey), [true, true, true, true, false, false]);
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry({ closest: () => ({}) }), true);
  assert.equal(isTextEntry({ closest: () => null }), false);
});
