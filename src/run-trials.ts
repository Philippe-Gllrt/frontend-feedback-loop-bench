// Runs the trials, unattended: one fresh Claude Code session per trial, with one
// browser tool plugged in (or none, for the control).
//
// Usage:
//   npm run run-trials -- --mockup <name> [--model <id>] [--effort <level>] [--input export|screenshot] [--tools id1,id2] [--trials 3] [--dry-run] [--check]
//
//   --mockup   folder name in mockups/ (made by `npm run export`).
//   --model, --effort  override config/bench.json for this series. Results go to
//              runs/<mockup>/<model without "claude-">_<effort>/ (e.g. runs/estatein/sonnet-5-5_xhigh/),
//              so a series never mixes with another. measure and report take the same two options.
//   --tools    only these condition ids from config/tools.json (default: all).
//   --input    "export" (default) or "screenshot": the agent gets the two captures and the assets only,
//              plus mockup/sections.json (frame sizes, section ids), with the skill variant *.screenshot.md.
//              Results go to runs/<mockup>/<series>_screenshot/. measure and report take the same option.
//   --trials   overrides trialsPerCondition from config/bench.json (e.g. 1 for a pilot).
//   --dry-run  prepares the workspaces and prints the claude command without running it.
//   --check    runs the initialisation checks only, then stops.
//
// Initialisation checks, before the first trial, so nothing is spent on a run that cannot work
// (none of them calls the model): Claude Code is found (src/lib/claude-bin.ts), it starts,
// it is logged in with a plan and not an API key (`claude auth status`), the dev server port
// is free and the template's dev server starts, and the health check of each selected tool
// passes. Every problem is listed, then the bench stops.
//
// Order: trial 1 of every tool, then trial 2 of every tool, and so on (interleaved), so that
// no tool runs at a better or worse moment than the others. Start with trialsPerCondition 1,
// read the token cost, then raise it: finished trials are kept, only the new ones run.
//
// For each trial it creates runs/<mockup>/<series>/<tool>-<n>/ with:
//   workspace/        copy of template/ + ./mockup/ + the skill, a git repo with a "baseline" commit.
//                     The agent works on it in the system's temporary folder; it is moved here
//                     once the session is over.
//   mcp.json          the MCP servers of this condition only
//   transcript.jsonl  the full session (Claude Code --output-format stream-json)
//   stderr.log        anything Claude Code printed on stderr
//   devserver.log     output of the dev server the launcher started for the agent
//   meta.json         tool, trial number, model, effort, timings, exit code, warnings
// A trial whose meta.json already exists is skipped, so an interrupted run can be resumed.
// The unfinished folder of an interrupted trial is moved to runs/<mockup>/_interrupted/.
//
// Dev server: the launcher starts the trial project's Vite dev server before the agent
// (devServerUrl in config/bench.json), as a developer works with a running server. The
// skill tells the agent it is there. It runs for every condition, the control included.
//
// Failed attempts (rules in src/lib/session-check.ts): when the tool or the environment
// breaks, the attempt is not a trial. It is moved to runs/<mockup>/_failed/ and run again.
// After maxFailedAttempts failed attempts of a tool (all its trials together), the tool is
// declared unusable unattended: runs/<mockup>/<tool>.unusable.json, remaining trials skipped.
//
// Isolation choices:
// - The workspace sits in the system's temporary folder during the session, outside the
//   repository, so the agent does not stumble on the bench's code, its .env or earlier trials.
// - Tools that drive a real Chrome through an extension (Playwriter, Claude in Chrome) must
//   use a Chrome profile made for the bench, with no personal account, never your everyday profile.
// - `--strict-mcp-config` makes Claude Code ignore every MCP server configured on the
//   machine and use only mcp.json, so a trial sees exactly one browser tool.
// - Skills of CLI tools are installed inside the workspace (project level), and the
//   launcher warns when browser skills sit in ~/.claude/skills, where every trial would see them.
// - `--permission-mode bypassPermissions` is required to run without anyone answering
//   prompts. The agent can then run any command on this machine: run the bench on a
//   machine (or account) you are fine handing to an agent.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MOCKUPS_DIR, RUNS_DIR, SKILL_DIR, TEMPLATE_DIR, loadBenchConfig, loadTools, parseArgs, resultsDir, seriesId, type BenchConfig, type ToolConfig } from "./lib/config.ts";
import { checkAuth, resolveClaudeBin } from "./lib/claude-bin.ts";
import type { Design } from "./lib/types.ts";
import { checkSession, createForbiddenGuard, createSkillGuard, isUsageLimit, parseTranscript } from "./lib/session-check.ts";

/** Name under which the skill is installed in each workspace; the prompt refers to it. */
const SKILL_NAME = "frontend-feedback-loop";
/** The Claude Code executable, resolved at start (see src/lib/claude-bin.ts). */
let CLAUDE_BIN = "claude";

/** Runs a shell command synchronously in `cwd`; throws with its output if it fails. */
function sh(command: string, cwd: string): void {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`"${command}" failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
}

/** Installs the template's dependencies once; trial workspaces then copy node_modules instead of installing again. */
function ensureTemplateInstalled(): void {
  if (existsSync(path.join(TEMPLATE_DIR, "node_modules"))) return;
  console.log("Installing the template's dependencies (once)...");
  sh("npm install --no-audit --no-fund", TEMPLATE_DIR);
}

/** Warns about browser skills installed globally: they would be visible to every condition and bias the comparison. */
async function warnAboutGlobalSkills(tools: ToolConfig[]): Promise<void> {
  const dir = path.join(os.homedir(), ".claude", "skills");
  if (!existsSync(dir)) return;
  const names = await readdir(dir);
  const suspicious = names.filter((n) => tools.some((t) => t.id !== "control" && n.toLowerCase().includes(t.id.split("-")[0])));
  if (suspicious.length) {
    console.warn(`! Global skills that look like browser tools were found in ${dir}: ${suspicious.join(", ")}.`);
    console.warn("  Every trial would see them. Move them out before running the comparison.");
  }
}

/** Reads the skill variant of a condition and appends the tool's optional extra context. */
async function skillFor(tool: ToolConfig, input: BenchConfig["input"]): Promise<string> {
  const variant = (tool.skill === "control" ? "SKILL.control" : "SKILL") + (input === "screenshot" ? ".screenshot" : "");
  const file = path.join(SKILL_DIR, `${variant}.md`);
  if (!existsSync(file)) throw new Error(`Missing skill file ${file}. See skill/README.md.`);
  let text = await readFile(file, "utf8");
  // The first ("raw") test leaves extraContext empty for every tool. A later test can
  // fill it to measure how much tool-specific guidance helps. For a control (no browser tool),
  // it states the rule of the condition (strict-control, 17/11).
  const heading = tool.skill === "control" ? "No browser" : "Notes about your browser tool";
  // The strict control's rule names design.json; with the screenshot input there is none.
  const extra = input === "screenshot"
    ? tool.extraContext.replaceAll("./mockup/design.json and the captures", "the captures in ./mockup/")
    : tool.extraContext;
  if (extra.trim()) text += `\n\n## ${heading}\n\n${extra.trim()}\n`;
  return text;
}

/** Builds a fresh workspace: template + mockup + skill, as a git repo with a baseline commit. */
async function prepareWorkspace(workspace: string, mockupDir: string, tool: ToolConfig, input: BenchConfig["input"]): Promise<void> {
  await cp(TEMPLATE_DIR, workspace, { recursive: true });
  const target = path.join(workspace, "mockup");
  if (input === "screenshot") {
    // The captures and the assets only (17/11/2026). design.json stays out of the workspace: the
    // layout, the texts and the styles are read from the image. sections.json gives what a developer
    // is told along with a screenshot (frame widths) and the ids the final report needs.
    await mkdir(target, { recursive: true });
    for (const name of ["desktop.png", "mobile.png"]) await cp(path.join(mockupDir, name), path.join(target, name));
    await cp(path.join(mockupDir, "assets"), path.join(target, "assets"), { recursive: true });
    const design = JSON.parse(await readFile(path.join(mockupDir, "design.json"), "utf8")) as Design;
    await writeFile(path.join(target, "sections.json"), JSON.stringify(screenshotSections(design), null, 2));
  } else {
    // text-reference.json is the measurement's answer key (D104): the agent never sees it.
    await cp(mockupDir, target, { recursive: true, filter: (src) => path.basename(src) !== "text-reference.json" });
  }
  const skillDir = path.join(workspace, ".claude", "skills", SKILL_NAME);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), await skillFor(tool, input));
  // node_modules is copied but never committed: the per-round commits must stay small.
  await writeFile(path.join(workspace, ".gitignore"), "node_modules/\ndist/\n");
  sh("git init -q && git add -A && git -c user.name=bench -c user.email=bench@localhost commit -q -m baseline", workspace);
  for (const command of tool.setup) {
    console.log(`  setup: ${command}`);
    sh(command, workspace);
  }
}

/**
 * What the screenshot input tells the agent besides the captures: the frames (id, breakpoint,
 * width, height) and the sections in page order (id, name, frame). No box, no text, no style.
 */
export function screenshotSections(design: Design) {
  return {
    frames: design.frames.map(({ id, name, breakpoint, width, height }) => ({ id, name, breakpoint, width, height })),
    sections: design.sections.map(({ id, name, frameId }) => ({ id, name, frameId })),
  };
}

/** The command-line arguments given to Claude Code for one trial. */
function claudeArgs(tool: ToolConfig, mcpConfig: string, prompt: string): string[] {
  const bench = loadBenchConfig();
  return [
    "-p", prompt,
    "--model", bench.model,
    "--effort", bench.effort,
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--output-format", "stream-json",
    "--verbose", // required by Claude Code with stream-json in print mode
    "--max-turns", String(bench.maxTurns),
    "--permission-mode", "bypassPermissions",
    ...tool.claudeArgs,
  ];
}

/**
 * Starts Claude Code in the workspace and streams its output to files; resolves with the exit
 * code. The session is watched live: if the agent cannot be following the skill
 * (createSkillGuard), or uses the tool in a forbidden way (createForbiddenGuard, e.g.
 * Playwriter without its extension), it is stopped at once and the transcript shows why.
 */
function runClaude(args: string[], workspace: string, transcript: string, stderrLog: string, tool: ToolConfig): Promise<number> {
  return new Promise((resolve, reject) => {
    // Commits made by the agent need an identity; set it here so the agent never has to.
    const env = { ...process.env, GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@localhost", GIT_COMMITTER_NAME: "agent", GIT_COMMITTER_EMAIL: "agent@localhost" };
    const child = spawn(CLAUDE_BIN, args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(createWriteStream(transcript));
    child.stderr.pipe(createWriteStream(stderrLog));
    const skillGuard = createSkillGuard(SKILL_NAME);
    const forbiddenGuard = createForbiddenGuard(tool.forbidden);
    const guard = (event: Record<string, unknown>) => skillGuard(event) ?? forbiddenGuard(event);
    let pending = "";
    let stopped = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const event of parseTranscript(lines.join("\n"))) {
        const reason = guard(event);
        if (reason) {
          stopped = true;
          console.warn(`  ! stopping the session: ${reason}`);
          child.kill();
          return;
        }
      }
    });
    child.on("error", (e) => reject(new Error(`Could not start "${CLAUDE_BIN}" (${e.message}).`)));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/** True if the URL answers an HTTP request (any status) within 2 s. */
async function isUp(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the Vite dev server of a workspace and waits until it answers.
 * Vite is run directly with Node (no npm, no shell), so stopping it is a single kill.
 * Returns the process (to stop it later) and whether it came up in time.
 */
async function startDevServer(workspace: string, url: string, timeoutMs: number, log: string): Promise<{ child: ChildProcess; up: boolean }> {
  const vite = path.join(workspace, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "--strictPort"], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
  const out = createWriteStream(log);
  child.stdout!.pipe(out);
  child.stderr!.pipe(out);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { child, up: false }; // e.g. the port is already taken
    if (await isUp(url)) return { child, up: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { child, up: false };
}

/** Stops the dev server and waits for it to exit, so the next trial can take the same port. */
async function stopDevServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

/**
 * Runs the tool's health check (config/tools.json) before the agent starts, so a tool that
 * is not installed or cannot open the page fails the attempt without spending any token.
 * Runs in a temporary folder, so nothing it writes ends up in the agent's workspace.
 * Returns null if every command succeeded, else the failing command and its output.
 */
async function runHealthCheck(tool: ToolConfig, log: string): Promise<string | null> {
  if (!tool.healthCheck.length) return null;
  console.log(`  health check of ${tool.name}...`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "bench-health-"));
  const lines: string[] = [];
  try {
    for (const command of tool.healthCheck) {
      const r = spawnSync(command, { cwd: dir, shell: true, encoding: "utf8", timeout: 60000 });
      lines.push(`$ ${command}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
      if (r.status !== 0) return `"${command}" exited with ${r.status ?? r.signal}`;
    }
    return null;
  } finally {
    await writeFile(log, lines.join("\n"));
    // The tool's browser may still hold the folder for a moment after its close command
    // returns (EBUSY with playwright-cli, 2026-11-17): retry before giving up.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

/** Number of failed attempts already recorded for a tool (they survive an interrupted run). */
async function failedAttempts(base: string, toolId: string): Promise<number> {
  const dir = path.join(base, "_failed");
  if (!existsSync(dir)) return 0;
  return (await readdir(dir)).filter((n) => n.startsWith(`${toolId}-`)).length;
}

/** True if the tool can run on this machine in this run (platform, not declared unusable). */
function isRunnable(tool: ToolConfig, base: string): boolean {
  if (tool.platforms && !tool.platforms.includes(process.platform)) return false;
  return !existsSync(path.join(base, `${tool.id}.unusable.json`));
}

/**
 * The initialisation checks (see the top of this file). Sets CLAUDE_BIN. Throws with every
 * problem found; none of the checks calls the model.
 */
async function preflight(bench: BenchConfig, tools: ToolConfig[]): Promise<void> {
  console.log("Initialisation checks:");
  const problems: string[] = [];
  const ok = (what: string) => console.log(`  ok    ${what}`);

  try {
    const bin = resolveClaudeBin({ configured: bench.claudeBin });
    CLAUDE_BIN = bin.path;
    const version = spawnSync(bin.path, ["--version"], { encoding: "utf8", timeout: 30000 });
    if (version.status !== 0) throw new Error(`"${bin.path} --version" failed: ${version.error?.message ?? version.stderr}`);
    ok(`Claude Code ${version.stdout.trim()} (${bin.path}, from ${bin.source})`);
    const auth = spawnSync(bin.path, ["auth", "status"], { encoding: "utf8", timeout: 30000 });
    const authError = checkAuth(auth.status, auth.stdout ?? "");
    if (authError) problems.push(authError);
    else ok("Claude Code is logged in with a plan");
  } catch (e) {
    problems.push((e as Error).message);
  }

  if (await isUp(bench.devServerUrl)) {
    problems.push(`Something already answers on ${bench.devServerUrl}. Stop it: the trials' dev server needs this port.`);
  } else {
    // One folder per run, named after its start time, so earlier checks are kept for reading.
    const logDir = path.join(RUNS_DIR, "_preflight", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(logDir, { recursive: true });
    const dev = await startDevServer(TEMPLATE_DIR, bench.devServerUrl, bench.devServerTimeoutMs, path.join(logDir, "devserver.log"));
    try {
      if (!dev.up) problems.push(`The dev server did not answer on ${bench.devServerUrl} within ${bench.devServerTimeoutMs} ms (log: ${path.join(logDir, "devserver.log")}).`);
      else {
        ok(`dev server starts (${bench.devServerUrl})`);
        for (const tool of tools.filter((t) => t.healthCheck.length)) {
          const log = path.join(logDir, `${tool.id}-healthcheck.log`);
          const error = await runHealthCheck(tool, log);
          if (error) problems.push(`Health check of ${tool.name} failed: ${error} (log: ${log}). Fix its install, or leave it out with --tools.`);
          else ok(`${tool.name} health check`);
        }
      }
    } finally {
      await stopDevServer(dev.child);
    }
  }

  if (problems.length) throw new Error(`The bench cannot start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  console.log("All checks passed.\n");
}

/**
 * Moves a folder. A rename when both paths are on the same drive (instant, even with
 * node_modules); otherwise a copy, then the source is removed.
 */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true }).catch(() => console.warn(`  ! could not remove ${from}; delete it by hand.`));
  }
}

/** What the trials of a run share: the mockup, the settings, the prompt and the dry-run flag. */
/**
 * The instruction given to the agent. The control has no fix loop (D82), so the sentence about
 * rounds of fixes is left out of its instruction (decided 16/11/2026, from the Sonnet series on;
 * the first Opus series still had it).
 */
export function promptFor(tool: Pick<ToolConfig, "skill">, ctx: Pick<RunContext, "bench">): string {
  const rounds = ` At most ${ctx.bench.maxRoundsPerSection} rounds of fixes per section.`;
  return tool.skill === "control" ? ctx.bench.prompt : ctx.bench.prompt + rounds;
}

type RunContext = { mockup: string; mockupDir: string; base: string; bench: BenchConfig; dryRun: boolean };

/**
 * Runs one trial of one tool, running it again after each failed attempt.
 * Returns "unusable" when the tool reached maxFailedAttempts (its next trials are skipped).
 *
 * The agent works in a fresh folder of the system's temporary directory, not in runs/:
 * inside the repository it could read the bench's code and .env (the Figma token), earlier
 * trials, or edit the scoring code. Logs are written to runs/ from outside the session, and
 * the workspace is moved to runs/<mockup>/<tool>-<n>/workspace/ once the session is over,
 * for the measure. Not a sandbox: with bypassPermissions the agent can still reach any path.
 */
async function runTrial(tool: ToolConfig, n: number, ctx: RunContext): Promise<"done" | "unusable"> {
  const { base, bench } = ctx;
  const runDir = path.join(base, `${tool.id}-${n}`);
  if (existsSync(path.join(runDir, "meta.json"))) { console.log(`= ${tool.id}-${n} already done, skipped.`); return "done"; }
  const unusableFile = path.join(base, `${tool.id}.unusable.json`);

  // One attempt per pass; a failed attempt (tool or environment broke) is run again.
  for (;;) {
    // A folder without meta.json is left by an interrupted run (or a dry run): kept for reading, out of the way.
    if (existsSync(runDir)) {
      const keep = path.join(base, "_interrupted", `${tool.id}-${n}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await mkdir(path.dirname(keep), { recursive: true });
      await moveDir(runDir, keep);
      console.warn(`  ! an unfinished ${tool.id}-${n} was moved to ${keep}`);
    }
    console.log(`> ${tool.id}-${n}: preparing the workspace...`);
    await mkdir(runDir, { recursive: true });
    const tmp = await mkdtemp(path.join(os.tmpdir(), `bench-${tool.id}-${n}-`));
    const workspace = path.join(tmp, "workspace");
    await prepareWorkspace(workspace, ctx.mockupDir, tool, bench.input);
    const mcpConfig = path.join(runDir, "mcp.json");
    await writeFile(mcpConfig, JSON.stringify({ mcpServers: tool.mcpServers }, null, 2));
    const cmd = claudeArgs(tool, mcpConfig, promptFor(tool, ctx));
    if (ctx.dryRun) {
      console.log(`  [dry run] in ${workspace}\n  ${CLAUDE_BIN} ${cmd.map((a) => JSON.stringify(a)).join(" ")}`);
      await moveDir(workspace, path.join(runDir, "workspace"));
      await rm(tmp, { recursive: true, force: true });
      return "done";
    }

    if (await isUp(bench.devServerUrl)) throw new Error(`Something already answers on ${bench.devServerUrl}. Stop it: the trial's dev server needs this port.`);
    console.log(`  starting the dev server (${bench.devServerUrl})...`);
    const dev = await startDevServer(workspace, bench.devServerUrl, bench.devServerTimeoutMs, path.join(runDir, "devserver.log"));
    const transcript = path.join(runDir, "transcript.jsonl");
    const startedAt = new Date();
    let exitCode = -1;
    let devUpAtEnd = false;
    let healthError: string | null = null;
    try {
      if (dev.up) healthError = await runHealthCheck(tool, path.join(runDir, "healthcheck.log"));
      if (dev.up && !healthError) {
        console.log(`  running Claude Code (${bench.model}, effort ${bench.effort}) in ${workspace}...`);
        exitCode = await runClaude(cmd, workspace, transcript, path.join(runDir, "stderr.log"), tool);
        devUpAtEnd = await isUp(bench.devServerUrl);
      }
    } finally {
      // Even if Claude Code cannot start, never leave the server holding the port.
      await stopDevServer(dev.child);
      // The session is over: bring the workspace back next to its logs, for the measure.
      await moveDir(workspace, path.join(runDir, "workspace"));
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    const endedAt = new Date();
    const events = existsSync(transcript) ? parseTranscript(await readFile(transcript, "utf8")) : [];
    const verdict = healthError
      ? { valid: false, failures: [`health check failed: ${healthError}`], warnings: [] }
      : checkSession(events, Object.keys(tool.mcpServers), dev.up && devUpAtEnd, tool.signature, SKILL_NAME, tool.forbidden);
    const meta = {
      tool: tool.id, toolName: tool.name, trial: n, mockup: ctx.mockup, model: bench.model, effort: bench.effort, input: bench.input,
      startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
      wallClockMs: endedAt.getTime() - startedAt.getTime(), exitCode,
      failures: verdict.failures, warnings: verdict.warnings,
    };

    if (verdict.valid) {
      await writeFile(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
      const warn = verdict.warnings.length ? `, warnings: ${verdict.warnings.join(", ")}` : "";
      console.log(`  done in ${Math.round(meta.wallClockMs / 60000)} min, exit code ${exitCode}${warn}.`);
      return "done";
    }

    // The plan's usage limit is neither the tool nor the trial (18/11/2026): retrying cannot help, and
    // counting it would declare a working tool unusable. The attempt is kept apart and the run stops;
    // run the same command again once the limit resets (finished trials are skipped).
    if (isUsageLimit(verdict.failures)) {
      const quotaDir = path.join(base, "_usage-limit");
      await mkdir(quotaDir, { recursive: true });
      await writeFile(path.join(runDir, "failed.json"), JSON.stringify(meta, null, 2));
      await moveDir(runDir, path.join(quotaDir, `${tool.id}-${n}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
      throw new Error(`Usage limit reached during ${tool.id}-${n} (${verdict.failures.join("; ")}). Not counted as a failed attempt. Run the same command again after the reset.`);
    }

    // A failed attempt: kept for reading, out of the way of the measure, then run again.
    const failedDir = path.join(base, "_failed");
    await mkdir(failedDir, { recursive: true });
    const failedCount = (await failedAttempts(base, tool.id)) + 1;
    await writeFile(path.join(runDir, "failed.json"), JSON.stringify(meta, null, 2));
    await moveDir(runDir, path.join(failedDir, `${tool.id}-${n}-attempt${failedCount}`));
    console.warn(`! ${tool.id}-${n}: failed attempt (${verdict.failures.join("; ")}). ${failedCount} / ${bench.maxFailedAttempts} for this tool.`);
    if (failedCount >= bench.maxFailedAttempts) {
      await writeFile(unusableFile, JSON.stringify({ tool: tool.id, toolName: tool.name, failedAttempts: failedCount, declaredAt: new Date().toISOString() }, null, 2));
      console.warn(`! ${tool.name} declared unusable unattended; its remaining trials are skipped.`);
      return "unusable";
    }
  }
}

/**
 * Entry point. Trials are interleaved: trial 1 of every tool, then trial 2 of every tool,
 * and so on. Running all the trials of one tool before the next would give each tool a
 * different moment (model load, quota, network), which would then look like a tool effect.
 */
async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.mockup) { console.error("Usage: npm run run-trials -- --mockup <name> [--model <id>] [--effort <level>] [--input export|screenshot] [--tools a,b] [--trials n] [--dry-run] [--check]"); process.exit(1); }
  const mockupDir = path.join(MOCKUPS_DIR, args.mockup);
  if (!existsSync(path.join(mockupDir, "design.json"))) throw new Error(`No export in ${mockupDir}. Run \`npm run export\` first.`);

  const bench = loadBenchConfig();
  const trials = args.trials ? Number(args.trials) : bench.trialsPerCondition;
  const wanted = args.tools?.split(",");
  const tools = loadTools().filter((t) => !wanted || wanted.includes(t.id));
  const base = resultsDir(args.mockup, bench);
  console.log(`Series ${seriesId(bench)}: results in ${path.relative(process.cwd(), base)}`);
  const ctx: RunContext = {
    mockup: args.mockup, mockupDir, base, bench, dryRun: !!args["dry-run"],
  };

  ensureTemplateInstalled();
  await warnAboutGlobalSkills(tools);

  if (ctx.dryRun) {
    try { CLAUDE_BIN = resolveClaudeBin({ configured: bench.claudeBin }).path; } catch (e) { console.warn(`! ${(e as Error).message}`); }
  } else {
    await preflight(bench, tools.filter((t) => isRunnable(t, base)));
    if (args.check) return;
  }

  // Tools that will not run are announced once, before the first trial.
  const active: ToolConfig[] = [];
  for (const tool of tools) {
    if (tool.platforms && !tool.platforms.includes(process.platform)) { console.warn(`- Skipping ${tool.name}: not supported on ${process.platform} (see its README).`); continue; }
    const unusableFile = path.join(base, `${tool.id}.unusable.json`);
    if (existsSync(unusableFile)) { console.warn(`- Skipping ${tool.name}: declared unusable unattended (${unusableFile}).`); continue; }
    if (tool.prerequisites.length) console.log(`${tool.name} expects, once, on this machine: ${tool.prerequisites.join(" / ")}`);
    if (tool.needsRealChrome) console.warn(`! ${tool.name} drives a real Chrome through an extension: use a dedicated Chrome profile, and it may need you in front of the screen.`);
    active.push(tool);
  }

  for (let n = 1; n <= trials; n++) {
    for (const tool of [...active]) {
      if (await runTrial(tool, n, ctx) === "unusable") active.splice(active.indexOf(tool), 1);
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
