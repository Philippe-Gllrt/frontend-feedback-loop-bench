// Loads the configuration files (config/bench.json, config/tools.json) and resolves the
// bench's folders, so every script uses the same paths.
// config/bench.local.json, if present, overrides keys of bench.json for this machine only
// (e.g. claudeBin). It is in .gitignore, so a personal path is never published.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Absolute path of the repository root (two levels above this file). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MOCKUPS_DIR = path.join(ROOT, "mockups");
export const RUNS_DIR = path.join(ROOT, "runs");
export const TEMPLATE_DIR = path.join(ROOT, "template");
export const SKILL_DIR = path.join(ROOT, "skill");

export type BenchConfig = {
  model: string;
  /** Reasoning effort passed to Claude Code (--effort), the same for every condition. */
  effort: (typeof EFFORTS)[number];
  /**
   * What the agent receives as the mockup (17/11/2026). "export": design.json + captures + assets
   * (the default, and every series before this key). "screenshot": the two captures and the assets
   * only, plus sections.json (frame sizes and section ids; no box, no text, no style), so the agent
   * reads the layout from the image. The measure always uses the full design.json of mockups/.
   */
  input: (typeof INPUTS)[number];
  trialsPerCondition: number;
  maxRoundsPerSection: number;
  maxTurns: number;
  prompt: string;
  colorJndDeltaE00: number;
  layoutBuckets: [number, number, number];
  noiseFloorPx: number;
  responsiveWidths: number[];
  devServerUrl: string;
  devServerTimeoutMs: number;
  maxFailedAttempts: number;
  /** Path of the Claude Code executable; null to find it (see src/lib/claude-bin.ts). Set it in bench.local.json. */
  claudeBin: string | null;
};

export type ToolSignature = { bash: string[]; tools: string[] };

export type ToolConfig = {
  id: string;
  name: string;
  homepage: string | null;
  skill: "full" | "control";
  prerequisites: string[];
  setup: string[];
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  claudeArgs: string[];
  needsRealChrome: boolean;
  platforms?: string[];
  /** Id of the condition this one is a variant of (same tool, another environment). Reported as a variant only. */
  variantOf?: string;
  /** How the tool shows in the session log: Bash command names, or tool name prefixes. */
  signature: ToolSignature;
  /** Commands run before the agent to check the tool works; empty if it cannot be checked by a script. */
  healthCheck: string[];
  /** Ways of running the tool that leave the condition (e.g. Playwriter without its extension). Optional. */
  forbidden?: ForbiddenUse[];
  extraContext: string;
};

/** A Bash command matching `pattern` (a regular expression) stops the session: the attempt fails with `reason`. */
export type ForbiddenUse = { pattern: string; reason: string };

/** Reads and parses a JSON file of the repository (path relative to ROOT). */
function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8")) as T;
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const INPUTS = ["export", "screenshot"] as const;

/**
 * config/bench.json, then config/bench.local.json, then `--model` and `--effort` on the command
 * line. Every script reads the same command line, so run-trials, measure and report given the same
 * --model/--effort work on the same series (see resultsDir).
 */
export function loadBenchConfig(argv: string[] = process.argv.slice(2)): BenchConfig {
  const shared = readJson<BenchConfig>("config/bench.json");
  const localFile = "config/bench.local.json";
  const merged = existsSync(path.join(ROOT, localFile)) ? { ...shared, ...readJson<Partial<BenchConfig>>(localFile) } : shared;
  const args = parseArgs(argv);
  if (args.model) merged.model = args.model;
  if (args.effort) {
    if (!(EFFORTS as readonly string[]).includes(args.effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
    merged.effort = args.effort as BenchConfig["effort"];
  }
  if (args.input) {
    if (!(INPUTS as readonly string[]).includes(args.input)) throw new Error(`--input must be one of ${INPUTS.join(", ")}`);
    merged.input = args.input as BenchConfig["input"];
  }
  merged.input ??= "export";
  return merged;
}

/**
 * Name of a series of trials: the model (without "claude-") and its effort, e.g. "opus-5-5_xhigh",
 * then "_screenshot" when the agent got the captures only (the export series keep their name).
 */
export function seriesId(bench: Pick<BenchConfig, "model" | "effort"> & { input?: BenchConfig["input"] }): string {
  const input = bench.input && bench.input !== "export" ? `_${bench.input}` : "";
  return `${bench.model.replace(/^claude-/, "")}_${bench.effort}${input}`;
}

/**
 * Folder of the results of one mockup for one model and effort: runs/<mockup>/<series>/.
 * Trials of another model or effort never mix with these (a Sonnet trial is not "trial 2" of Opus).
 */
export function resultsDir(mockup: string, bench: Pick<BenchConfig, "model" | "effort"> & { input?: BenchConfig["input"] }): string {
  return path.join(RUNS_DIR, mockup, seriesId(bench));
}

export function loadTools(): ToolConfig[] {
  return readJson<{ tools: ToolConfig[] }>("config/tools.json").tools;
}

/**
 * Minimal command-line parser: turns `--name value --flag` into
 * { name: "value", flag: "true" }. Enough for the few options the scripts take,
 * and avoids a dependency.
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = "true";
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}
