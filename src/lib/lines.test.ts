// Tests of the line-break comparison. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareLines, isMisbroken } from "./lines.ts";

test("same breaks, whatever the case", () => {
  const r = compareLines([["Featured", "Properties"]], [["FEATURED", "properties"]]);
  assert.deepEqual(r, { expectedLines: 1, actualLines: 1, movedWords: 0 });
  assert.equal(isMisbroken(r), false);
});

test("a word moved to the next line", () => {
  const r = compareLines([["Find", "your", "dream"], ["home"]], [["Find", "your"], ["dream", "home"]]);
  assert.deepEqual(r, { expectedLines: 2, actualLines: 2, movedWords: 1 });
  assert.equal(isMisbroken(r), true);
});

test("one line instead of two", () => {
  const r = compareLines([["Find", "your"], ["home"]], [["Find", "your", "home"]]);
  assert.deepEqual(r, { expectedLines: 2, actualLines: 1, movedWords: 1 });
});

test("different words: not comparable", () => {
  assert.equal(compareLines([["Find", "home"]], [["Find", "a", "home"]]), null);
  assert.equal(compareLines([], []), null);
  assert.equal(isMisbroken(null), false);
});

test("typographic and straight quotes are the same word (16/11)", () => {
  const r = compareLines([["We're", "here"]], [["We’re", "here"]]);
  assert.deepEqual(r, { expectedLines: 1, actualLines: 1, movedWords: 0 });
});
