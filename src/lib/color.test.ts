// Tests of the colour helpers. Run with `npm test`.
// The CIEDE2000 pairs come from the test data published by Sharma, Wu & Dalal
// (2005), table 1; expected values are given to 4 decimals there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cssColorToHex, deltaE2000, deltaE2000Hex, figmaRgbToHex } from "./color.ts";

const sharmaPairs: Array<[[number, number, number], [number, number, number], number]> = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
];

test("deltaE2000 matches Sharma et al. (2005) test data", () => {
  for (const [a, b, expected] of sharmaPairs) {
    assert.ok(Math.abs(deltaE2000(a, b) - expected) < 1e-4, `${a} / ${b}: got ${deltaE2000(a, b)}, want ${expected}`);
  }
});

test("identical colours have a zero difference", () => {
  assert.equal(deltaE2000Hex("#1a2b3c", "#1a2b3c"), 0);
});

test("colour conversions", () => {
  assert.equal(figmaRgbToHex({ r: 1, g: 0.5, b: 0 }), "#ff8000");
  assert.equal(cssColorToHex("rgb(255, 128, 0)"), "#ff8000");
  assert.equal(cssColorToHex("rgba(0, 0, 0, 0)"), null);
  assert.equal(cssColorToHex("rgb(10 20 30 / 50%)"), "#0a141e");
});
