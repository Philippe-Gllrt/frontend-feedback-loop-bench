import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { RUNS_DIR, loadBenchConfig, resultsDir, seriesId } from "./config.ts";

test("one results folder per model and effort", () => {
  assert.equal(seriesId({ model: "claude-opus-5-5", effort: "xhigh" }), "opus-5-5_xhigh");
  assert.equal(seriesId({ model: "claude-sonnet-5-5", effort: "xhigh" }), "sonnet-5-5_xhigh");
  assert.equal(resultsDir("estatein", { model: "claude-sonnet-5-5", effort: "xhigh" }), path.join(RUNS_DIR, "estatein", "sonnet-5-5_xhigh"));
});

test("--model and --effort on the command line override config/bench.json", () => {
  const base = loadBenchConfig([]);
  const sonnet = loadBenchConfig(["--mockup", "estatein", "--model", "claude-sonnet-5-5", "--effort", "medium"]);
  assert.equal(sonnet.model, "claude-sonnet-5-5");
  assert.equal(sonnet.effort, "medium");
  assert.equal(sonnet.prompt, base.prompt); // everything else unchanged
  assert.throws(() => loadBenchConfig(["--effort", "huge"]), /--effort must be one of/);
});

test("the screenshot input gets its own series; the export series keep their name", () => {
  assert.equal(seriesId({ model: "claude-opus-5-5", effort: "xhigh", input: "export" }), "opus-5-5_xhigh");
  assert.equal(seriesId({ model: "claude-opus-5-5", effort: "xhigh", input: "screenshot" }), "opus-5-5_xhigh_screenshot");
  assert.equal(loadBenchConfig([]).input, "export");
  assert.equal(loadBenchConfig(["--input", "screenshot"]).input, "screenshot");
  assert.throws(() => loadBenchConfig(["--input", "photo"]), /--input must be one of/);
});
