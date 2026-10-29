import assert from "node:assert/strict";
import test from "node:test";
import { FileDragDepth, isFileDrag } from "../src/filedrop.ts";

test("only drags that carry files count", () => {
  assert.equal(isFileDrag(["Files"]), true);
  assert.equal(isFileDrag(["text/plain"]), false);
  assert.equal(isFileDrag(undefined), false);
});

test("nested dragenter / dragleave keep the drag active until it leaves the window", () => {
  const depth = new FileDragDepth();
  depth.enter();
  depth.enter();
  assert.equal(depth.leave(), true);
  assert.equal(depth.leave(), false);
  assert.equal(depth.leave(), false);
  depth.enter();
  depth.reset();
  assert.equal(depth.leave(), false);
});
