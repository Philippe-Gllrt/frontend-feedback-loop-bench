// Builds the comparison report of a mockup from the measured trials.
//
// Usage:
//   npm run report -- --mockup <name>
//
// Reads runs/<mockup>/<run>/{meta.json, measure.json, transcript.jsonl} and writes:
//   runs/<mockup>/report.md    one table per measure, one row per condition (median of its trials)
//   runs/<mockup>/trials.csv   one row per trial, every number, for charts and checks
//
// Cost comes from the last "result" event of the Claude Code transcript
// (--output-format stream-json), which carries the session totals: tokens,
// cost in USD (an API-price estimate; on a subscription plan nothing is billed per token),
// number of turns and duration.
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBenchConfig, parseArgs, resultsDir } from "./lib/config.ts";
import { median, type Summary } from "./lib/score.ts";

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null; turns: number | null; durationMs: number | null };

/** Reads the session totals from the transcript's final "result" event. Null if the session did not finish. */
async function readUsage(file: string): Promise<Usage | null> {
  if (!existsSync(file)) return null;
  const lines = (await readFile(file, "utf8")).trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.type !== "result") continue;
      const u = e.usage ?? {};
      return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        costUsd: e.total_cost_usd ?? null,
        turns: e.num_turns ?? null,
        durationMs: e.duration_ms ?? null,
      };
    } catch { /* a truncated last line: keep looking */ }
  }
  return null;
}

/** One measured trial, flattened. */
type Trial = {
  run: string; tool: string; toolName: string; trial: number; exitCode: number; warnings: string[];
  overall: Summary; imageSimilarity: number | null; consoleErrors: number; buildError: boolean; reportProblem: string | null;
  rounds: Array<{ subject: string; overall: Summary }>;
  usage: Usage | null;
  /** Count of `position: absolute` elements per mockup frame (null if the build failed). */
  absolute: Record<string, number | null>;
  responsive: Array<{ width: number; overflowPx: number; overlaps: unknown[]; absoluteCount: number }>;
};

/** Loads every trial of a mockup that has both meta.json and measure.json. */
async function loadTrials(base: string): Promise<Trial[]> {
  const trials: Trial[] = [];
  for (const run of (await readdir(base)).sort()) {
    const dir = path.join(base, run);
    if (!existsSync(path.join(dir, "meta.json")) || !existsSync(path.join(dir, "measure.json"))) continue;
    const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8"));
    const m = JSON.parse(await readFile(path.join(dir, "measure.json"), "utf8"));
    const sims = m.final.frames.map((f: { imageSimilarity: number | null }) => f.imageSimilarity).filter((s: number | null) => s !== null);
    trials.push({
      run, tool: meta.tool, toolName: meta.toolName, trial: meta.trial, exitCode: meta.exitCode, warnings: meta.warnings ?? [],
      overall: m.final.overall,
      imageSimilarity: sims.length ? sims.reduce((a: number, b: number) => a + b, 0) / sims.length : null,
      consoleErrors: m.final.frames.reduce((n: number, f: { consoleErrors: string[] }) => n + f.consoleErrors.length, 0),
      buildError: m.final.buildError !== null,
      reportProblem: m.reportProblem,
      rounds: m.rounds,
      usage: await readUsage(path.join(dir, "transcript.jsonl")),
      absolute: Object.fromEntries(m.final.frames.map((f: { breakpoint: string; absoluteCount?: number | null }) => [f.breakpoint, f.absoluteCount ?? null])),
      responsive: m.final.responsive ?? [],
    });
  }
  return trials;
}

/**
 * Reliability of each tool run unattended: failed attempts (moved to _failed/ by the launcher)
 * and tools declared unusable after maxFailedAttempts. A result of the comparison in itself.
 */
async function loadReliability(base: string): Promise<Array<{ tool: string; failedAttempts: number; unusable: boolean }>> {
  const failedDir = path.join(base, "_failed");
  const failed = existsSync(failedDir) ? await readdir(failedDir) : [];
  const files = await readdir(base);
  const tools = new Set<string>();
  for (const n of failed) tools.add(n.replace(/-\d+-attempt\d+$/, ""));
  for (const n of files) if (n.endsWith(".unusable.json")) tools.add(n.replace(/\.unusable\.json$/, ""));
  return [...tools].sort().map((tool) => ({
    tool,
    failedAttempts: failed.filter((n) => n.startsWith(`${tool}-`)).length,
    unusable: files.includes(`${tool}.unusable.json`),
  }));
}

/** Median of the non-null values picked from a list of trials, formatted; "–" if none. */
function med(trials: Trial[], pick: (t: Trial) => number | null | undefined, digits = 0): string {
  const v = median(trials.map(pick).filter((x): x is number => typeof x === "number"));
  return v === null ? "–" : v.toFixed(digits);
}

/** Renders a Markdown table. */
function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** Entry point. */
async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.mockup) { console.error("Usage: npm run report -- --mockup <name> [--model <id>] [--effort <level>]"); process.exit(1); }
  const base = resultsDir(args.mockup, loadBenchConfig());
  const trials = await loadTrials(base);
  if (!trials.length) throw new Error(`No measured trial in ${base}. Run \`npm run measure\` first.`);
  const buckets = Object.keys(trials[0].overall.layoutBuckets);
  const byTool = new Map<string, Trial[]>();
  for (const t of trials) byTool.set(t.toolName, [...(byTool.get(t.toolName) ?? []), t]);
  const groups = [...byTool.entries()];
  const bench = loadBenchConfig();
  const reliability = await loadReliability(base);

  const md: string[] = [
    `# Bench report: ${args.mockup}`,
    "",
    `${trials.length} measured trials, model ${bench.model}, effort ${bench.effort}. Every number is the median over the trials of a condition.`,
    "",
    "## Remaining gap (main measure)",
    "",
    "How far the page is from the mockup at the end of the trial: for each key block, the largest of its x, y, width and height differences.",
    "",
    table(["Condition", "Trials", ...buckets.map((b) => `Blocks ${b === "missing" ? "missing" : `${b} px`}`), "Median gap (px)", "Worst gap (px)"],
      groups.map(([name, ts]) => [name, String(ts.length), ...buckets.map((b) => med(ts, (t) => t.overall.layoutBuckets[b])), med(ts, (t) => t.overall.medianGap, 1), med(ts, (t) => t.overall.worstGap)])),
    "",
    "## Does the agent's report match the page? (guard rail)",
    "",
    `Unreported: a defect the agent did not report (its section was declared conforming, or the block was not listed). Counted above ${bench.noiseFloorPx} px;`
      + ` the 1-${bench.noiseFloorPx} px range can come from font rendering and is read against the control. False alarm: a block listed as an issue while it has no defect.`,
    "",
    table(["Condition", "Defects", `Unreported > ${bench.noiseFloorPx} px or missing`, "False alarms", ...buckets.filter((b) => b !== "0").map((b) => `Unreported ${b}`), "Unreported (style only)"],
      groups.map(([name, ts]) => [name, med(ts, (t) => t.overall.defects), med(ts, (t) => t.overall.unreportedAboveNoise), med(ts, (t) => t.overall.falseAlarms),
        ...buckets.filter((b) => b !== "0").map((b) => med(ts, (t) => t.overall.unreportedByBucket[b])), med(ts, (t) => t.overall.unreportedStyleOnly)])),
    "",
    "Reported defects, split by the agent's own judgement (`visible` in report.json). A grade by thresholds will be computed from these counts once the pilot gives data to set them.",
    "",
    table(["Condition", "Reported", "Judged visible", "Judged not visible", "No judgement"],
      groups.map(([name, ts]) => [name, med(ts, (t) => t.overall.defects - t.overall.unreportedDefects), med(ts, (t) => t.overall.reportedVisible),
        med(ts, (t) => t.overall.reportedInvisible), med(ts, (t) => t.overall.defects - t.overall.unreportedDefects - t.overall.reportedVisible - t.overall.reportedInvisible)])),
    "",
    "## Line breaks",
    "",
    "At the two widths of the mockup, the words of each line of a text against the reference (Figma's text laid out in Chromium at its Figma width,"
      + " mockups/<name>/text-reference.json). Misbroken: a word sits on another line, or the text draws another number of lines. It is a defect whatever its layout gap."
      + " Not comparable: the page's text has other words (then the lines cannot be compared).",
    "",
    table(["Condition", "Texts checked", "Misbroken", "Words moved", "Misbroken, unreported", "Not comparable"],
      groups.map(([name, ts]) => [name, med(ts, (t) => t.overall.textsLineChecked), med(ts, (t) => t.overall.misbrokenTexts), med(ts, (t) => t.overall.movedWords),
        med(ts, (t) => t.overall.unreportedMisbroken), med(ts, (t) => t.overall.linesNotComparable)])),
    "",
    "## Tool reliability, unattended",
    "",
    reliability.length
      ? table(["Condition", "Failed attempts", "Declared unusable"], reliability.map((r) => [r.tool, String(r.failedAttempts), r.unusable ? `yes (after ${bench.maxFailedAttempts})` : "no"]))
      : "No failed attempt: every tool ran unattended.",
    "",
    "## Responsive",
    "",
    `At widths the mockup does not have (${bench.responsiveWidths.join(" and ")} px): horizontal overflow, and overlaps of the mockup's texts that the mockup does not have.`
      + " `position: absolute` elements are counted at every width: it is the shortcut that matches two widths to the pixel and breaks in between."
      + " Captures: responsive-<width>.png in each trial folder.",
    "",
    table(["Condition", ...bench.responsiveWidths.flatMap((w) => [`Overflow ${w} (px)`, `Overlaps ${w}`]), "Absolute (desktop)", "Absolute (mobile)"],
      groups.map(([name, ts]) => [name,
        ...bench.responsiveWidths.flatMap((w) => [med(ts, (t) => t.responsive.find((r) => r.width === w)?.overflowPx), med(ts, (t) => t.responsive.find((r) => r.width === w)?.overlaps.length)]),
        med(ts, (t) => t.absolute.desktop), med(ts, (t) => t.absolute.mobile)])),
    "",
    "## Style fidelity, image similarity, technical quality",
    "",
    table(["Condition", "Style values right", "Wrong colours below perception", "Image similarity", "Console errors", "Builds failed"],
      groups.map(([name, ts]) => [name, med(ts, (t) => t.overall.styleScore !== null ? t.overall.styleScore * 100 : null, 1) + " %",
        med(ts, (t) => t.overall.wrongColoursBelowPerception), med(ts, (t) => t.imageSimilarity !== null ? t.imageSimilarity * 100 : null, 1) + " %",
        med(ts, (t) => t.consoleErrors), String(ts.filter((t) => t.buildError).length)])),
    "",
    "## Cost",
    "",
    table(["Condition", "Output tokens", "Input + cache tokens", "Cost (USD, API price)", "Turns", "Duration (min)", "Rounds committed"],
      groups.map(([name, ts]) => [name, med(ts, (t) => t.usage?.outputTokens), med(ts, (t) => t.usage ? t.usage.inputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens : null),
        med(ts, (t) => t.usage?.costUsd, 2), med(ts, (t) => t.usage?.turns), med(ts, (t) => t.usage?.durationMs != null ? t.usage.durationMs / 60000 : null, 1), med(ts, (t) => t.rounds.length)])),
    "",
    "## Problems to read before trusting the numbers",
    "",
    ...trials.filter((t) => t.exitCode !== 0 || t.buildError || t.reportProblem || !t.usage || t.warnings.length)
      .map((t) => `- ${t.run}: ${[t.warnings.includes("max-turns") && `stopped by maxTurns (${bench.maxTurns}): counted, but the agent may not have finished`,
        t.exitCode !== 0 && `exit code ${t.exitCode}`, t.buildError && "build failed", t.reportProblem, !t.usage && "no session totals in the transcript"].filter(Boolean).join(", ")}`),
    "",
  ];
  await writeFile(path.join(base, "report.md"), md.join("\n"));

  const csvHead = ["run", "tool", "trial", "exitCode", "blocks", ...buckets.map((b) => `gap_${b}`), "medianGap", "worstGap", "defects", "unreported", "unreportedAboveNoise", "falseAlarms", "misbrokenTexts", "movedWords",
    ...bench.responsiveWidths.flatMap((w) => [`overflow_${w}`, `overlaps_${w}`]), "absoluteDesktop", "absoluteMobile", "styleScore", "imageSimilarity", "consoleErrors", "outputTokens", "costUsd", "turns", "durationMs", "rounds"];
  const csv = [csvHead.join(","), ...trials.map((t) => [t.run, t.tool, t.trial, t.exitCode, t.overall.blocks,
    ...buckets.map((b) => t.overall.layoutBuckets[b]), t.overall.medianGap, t.overall.worstGap, t.overall.defects, t.overall.unreportedDefects, t.overall.unreportedAboveNoise, t.overall.falseAlarms, t.overall.misbrokenTexts, t.overall.movedWords,
    ...bench.responsiveWidths.flatMap((w) => { const r = t.responsive.find((x) => x.width === w); return [r?.overflowPx, r?.overlaps.length]; }), t.absolute.desktop, t.absolute.mobile,
    t.overall.styleScore, t.imageSimilarity, t.consoleErrors,
    t.usage?.outputTokens, t.usage?.costUsd, t.usage?.turns, t.usage?.durationMs, t.rounds.length].map((v) => v ?? "").join(","))];
  await writeFile(path.join(base, "trials.csv"), csv.join("\n") + "\n");
  console.log(`Written ${path.join(base, "report.md")} and trials.csv`);
}

main().catch((e) => { console.error(e); process.exit(1); });
