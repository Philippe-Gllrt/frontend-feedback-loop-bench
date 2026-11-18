import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import { cropToFrame, frameOffset } from "./frame-crop.ts";

/** A capture `w` x `h` with an opaque frame of `fw` x `fh` at (ox, oy), and a band sticking out on rows [by, by + bh). */
function capture(w: number, h: number, fw: number, fh: number, ox: number, oy: number, band?: { by: number; bh: number }) {
  const img = new PNG({ width: w, height: h });
  img.data.fill(0);
  const paint = (x: number, y: number, v: number) => { const i = (y * w + x) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; };
  for (let y = oy; y < oy + fh; y++) for (let x = ox; x < ox + fw; x++) paint(x, y, x === ox ? 200 : 20); // marker on the frame's first column
  if (band) for (let y = band.by; y < band.by + band.bh; y++) for (let x = 0; x < w; x++) paint(x, y, 40);
  return img;
}

test("frame offset: a band sticking out on both sides (the Estatein desktop case)", () => {
  const img = capture(1942, 300, 1920, 300, 11, 0, { by: 100, bh: 40 });
  assert.deepEqual(frameOffset(img, 1920, 300), { x: 11, y: 0 });
  const out = cropToFrame(img, 1920, 300);
  assert.equal(out.width, 1920);
  assert.equal(out.data[(0 * 1920 + 0) * 4], 200); // the frame's first column is now column 0
});

test("frame offset: overflow on one side only", () => {
  const img = capture(130, 50, 100, 50, 30, 0);
  assert.deepEqual(frameOffset(img, 100, 50), { x: 30, y: 0 });
});

test("a capture at the frame's size is left as is", () => {
  const img = capture(390, 80, 390, 80, 0, 0);
  assert.equal(cropToFrame(img, 390, 80), img);
});
