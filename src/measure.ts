// Measures the trials, independently of the agent: builds each workspace, opens the
// page at the width of each mockup frame, and compares it with the export.
//
// Usage:
//   npm run measure -- --mockup <name> [--model <id>] [--effort <level>] [--run <tool>-<n>] [--force]
//
//   --model, --effort  the series to measure (default: config/bench.json), see run-trials.ts.
//
//   --run    only this trial (default: every trial of the mockup that has a meta.json).
//   --force  measure again trials that already have a measure.json.
//
// For each trial it writes runs/<mockup>/<run>/measure.json with:
//   final    the state the agent left (its working tree), per frame and overall
//   rounds   the same numbers for each "round <n>: ..." commit, to draw the curve per round
// and, for the final state, <breakpoint>.png (capture), <breakpoint>-diff.png (image diff)
// and responsive-<width>.png (capture at each responsive width, for reading).
//
// Measures (see src/lib/score.ts and src/lib/responsive.ts for the exact definitions):
//   main measure: the remaining layout gap per key block at the end of the trial;
//   guard rail: unreported defects above the noise floor, and false alarms;
//   style checks, global image similarity (an indicator only: a 2 px font shift moves the
//   whole score), console errors;
//   responsive (final state only): at each width of responsiveWidths, horizontal overflow and
//   overlaps the mockup does not have; at every width, the count of `position: absolute` elements.
// Not measured yet: the Lighthouse accessibility score listed in the protocol.
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { MOCKUPS_DIR, loadBenchConfig, parseArgs, resultsDir, seriesId } from "./lib/config.ts";
import { extractPage } from "./lib/page-extract.ts";
import { cropToFrame } from "./lib/frame-crop.ts";
import { findOverlaps, mockupOverlaps, type Overlap } from "./lib/responsive.ts";
import { normaliseText, scoreBlocks, summarise, type BlockResult, type Summary } from "./lib/score.ts";
import type { AgentReport, Design, Frame, TextReference, TextReferenceFile } from "./lib/types.ts";

/** Runs a command synchronously; returns stdout, or throws with the output. */
function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/**
 * Builds a project with Vite (without the type check: a type error must not hide
 * the rendering from the measurement). Returns null and the error if the build fails:
 * a trial that does not build is measured as "every block missing".
 */
function build(dir: string): { ok: true } | { ok: false; error: string } {
  const r = spawnSync(process.execPath, [path.join(dir, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "error"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? { ok: true } : { ok: false, error: `${r.stdout}\n${r.stderr}`.trim() };
}

/** Content types for the static server. */
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json",
};

/** Serves a dist/ folder on a free port (single-page fallback to index.html). Returns the server and its URL. */
async function serve(dist: string): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(dist, urlPath);
    if (!file.startsWith(dist) || !existsSync(file) || (await stat(file)).isDirectory()) file = path.join(dist, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

/**
 * Pixel comparison of two PNGs of possibly different sizes. Both are placed on a
 * canvas of the larger size; the area outside one image counts as different.
 * Returns the share of identical pixels (0..1) and the diff image.
 */
function imageSimilarity(reference: PNG, actual: PNG): { similarity: number; diff: PNG } {
  const w = Math.max(reference.width, actual.width), h = Math.max(reference.height, actual.height);
  const pad = (img: PNG) => {
    const out = new PNG({ width: w, height: h });
    out.data.fill(0); // transparent black: always different from a painted pixel
    PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
    return out;
  };
  const a = pad(reference), b = pad(actual);
  const diff = new PNG({ width: w, height: h });
  // threshold 0.1 is pixelmatch's default sensitivity to colour difference per pixel.
  const different = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1 });
  return { similarity: 1 - different / (w * h), diff };
}

type FrameMeasure = { breakpoint: Frame["breakpoint"]; summary: Summary; blocks: BlockResult[]; imageSimilarity: number | null; consoleErrors: string[]; absoluteCount: number | null };
/** The page at one responsive width (between the mockup's frames, no reference to compare with). */
type ResponsiveMeasure = { width: number; overflowPx: number; overlaps: Overlap[]; absoluteCount: number };
type StateMeasure = { buildError: string | null; frames: FrameMeasure[]; overall: Summary; responsive: ResponsiveMeasure[] };

/** Viewport height used at a responsive width: a common screen height for that width. Only the visible part changes; captures are full page. */
const responsiveHeight = (width: number) => (width >= 1024 ? 800 : 1024);

/**
 * Number of elements laid out with `position: absolute` (computed style, so it does not
 * matter whether the agent wrote CSS, Tailwind classes or inline styles). Icons' inner SVG
 * shapes are left out. Runs in the page; must stay free of imports and closures.
 */
function countAbsolute(): number {
  return Array.from(document.body.querySelectorAll("*")).filter((e) => !e.closest("svg") && getComputedStyle(e).position === "absolute").length;
}

/**
 * Measures one state of the code (a folder with node_modules): build, serve, render
 * each frame, score. `captureDir` (optional) receives the captures and diff images; when it
 * is given (final state), the page is also rendered at each responsive width.
 */
async function measureState(dir: string, design: Design, mockupDir: string, report: AgentReport | null, browser: Browser, texts: Record<string, TextReference>, captureDir?: string): Promise<StateMeasure> {
  const bench = loadBenchConfig();
  const sum = (results: BlockResult[]) => summarise(results, bench.layoutBuckets, bench.noiseFloorPx);
  const built = build(dir);
  const frames: FrameMeasure[] = [];
  const responsive: ResponsiveMeasure[] = [];
  let server: Server | null = null, url = "";
  if (built.ok) ({ server, url } = await serve(path.join(dir, "dist")));
  try {
    for (const frame of design.frames) {
      const blocks = design.blocks.filter((b) => b.frameId === frame.id);
      if (!built.ok) {
        const results = scoreBlocks(blocks, [], report, bench.colorJndDeltaE00, texts);
        frames.push({ breakpoint: frame.breakpoint, summary: sum(results), blocks: results, imageSimilarity: null, consoleErrors: [], absoluteCount: null });
        continue;
      }
      // deviceScaleFactor 1: one CSS pixel = one image pixel, like the scale-1 reference export.
      const page = await browser.newPage({ viewport: { width: Math.round(frame.width), height: Math.round(frame.height) }, deviceScaleFactor: 1 });
      const consoleErrors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(e.message));
      await page.goto(url, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready); // web fonts must be drawn before measuring
      const elements = await page.evaluate(extractPage);
      const absoluteCount = await page.evaluate(countAbsolute);
      const shot = PNG.sync.read(await page.screenshot({ fullPage: true }));
      await page.close();

      // Figma's capture can be wider than the frame (content sticking out): crop it back to the frame first.
      const reference = cropToFrame(PNG.sync.read(await readFile(path.join(mockupDir, `${frame.breakpoint}.png`))), frame.width, frame.height);
      const { similarity, diff } = imageSimilarity(reference, shot);
      if (captureDir) {
        await writeFile(path.join(captureDir, `${frame.breakpoint}.png`), PNG.sync.write(shot));
        await writeFile(path.join(captureDir, `${frame.breakpoint}-diff.png`), PNG.sync.write(diff));
      }
      const results = scoreBlocks(blocks, elements, report, bench.colorJndDeltaE00, texts);
      frames.push({ breakpoint: frame.breakpoint, summary: sum(results), blocks: results, imageSimilarity: Math.round(similarity * 10000) / 10000, consoleErrors, absoluteCount });
    }

    if (built.ok && captureDir) {
      const keyTexts = new Set(design.blocks.filter((b) => b.kind === "text").map((b) => normaliseText(b.text ?? "")));
      const allowed = mockupOverlaps(design.blocks, bench.noiseFloorPx);
      for (const width of bench.responsiveWidths) {
        const page = await browser.newPage({ viewport: { width, height: responsiveHeight(width) }, deviceScaleFactor: 1 });
        await page.goto(url, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        // Overflow: how much wider than the viewport the document is (0 = no horizontal scroll bar).
        const overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
        const elements = await page.evaluate(extractPage);
        const absoluteCount = await page.evaluate(countAbsolute);
        await writeFile(path.join(captureDir, `responsive-${width}.png`), await page.screenshot({ fullPage: true }));
        await page.close();
        responsive.push({ width, overflowPx, overlaps: findOverlaps(elements, keyTexts, allowed, bench.noiseFloorPx), absoluteCount });
      }
    }
  } finally {
    server?.close();
  }
  return { buildError: built.ok ? null : built.error, frames, overall: sum(frames.flatMap((f) => f.blocks)), responsive };
}

/** Reads the agent's ./report.json; null if it is missing or not valid JSON (then every defect counts as unreported). */
async function readAgentReport(workspace: string): Promise<{ report: AgentReport | null; problem: string | null }> {
  const file = path.join(workspace, "report.json");
  if (!existsSync(file)) return { report: null, problem: "report.json missing" };
  try { return { report: JSON.parse(await readFile(file, "utf8")) as AgentReport, problem: null }; }
  catch (e) { return { report: null, problem: `report.json invalid: ${(e as Error).message}` }; }
}

/** Lists the agent's "round <n>: ..." commits, oldest first. */
function roundCommits(workspace: string): Array<{ hash: string; subject: string }> {
  return run("git", ["log", "--reverse", "--format=%H%x09%s"], workspace)
    .split("\n").filter(Boolean)
    .map((line) => { const [hash, ...rest] = line.split("\t"); return { hash, subject: rest.join("\t") }; })
    .filter((c) => /^round\b/i.test(c.subject));
}

/**
 * Measures a past commit in a temporary git worktree. node_modules is linked
 * (a junction on Windows) from the workspace instead of being installed again.
 * The agent's FINAL report is used for every round: it is the only report it writes.
 */
async function measureCommit(workspace: string, hash: string, design: Design, mockupDir: string, report: AgentReport | null, browser: Browser, texts: Record<string, TextReference>): Promise<StateMeasure> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bench-round-"));
  const dir = path.join(tmp, "w");
  const link = path.join(dir, "node_modules");
  try {
    run("git", ["worktree", "add", "--detach", dir, hash], workspace);
    await symlink(path.join(workspace, "node_modules"), link, "junction");
    return await measureState(dir, design, mockupDir, report, browser, texts);
  } finally {
    // The link MUST be removed first, on its own: a recursive delete of the worktree
    // (git worktree remove, rm -r) follows the junction and empties the workspace's
    // real node_modules. unlink() removes only the link.
    if (existsSync(link)) await unlink(link);
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: workspace });
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Entry point: measures every finished trial of a mockup. */
async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.mockup) { console.error("Usage: npm run measure -- --mockup <name> [--model <id>] [--effort <level>] [--run <tool>-<n>] [--force]"); process.exit(1); }
  const base = resultsDir(args.mockup, loadBenchConfig());
  console.log(`Series ${seriesId(loadBenchConfig())}`);
  const runs = (await readdir(base)).filter((r) => (!args.run || r === args.run) && existsSync(path.join(base, r, "meta.json")));
  // The text reference (D104) lives next to the export, never in the workspace the agent saw.
  const refFile = path.join(MOCKUPS_DIR, args.mockup, "text-reference.json");
  const texts: Record<string, TextReference> = existsSync(refFile) ? (JSON.parse(await readFile(refFile, "utf8")) as TextReferenceFile).blocks : {};
  if (!existsSync(refFile)) console.warn(`! No ${refFile}: texts are measured against Figma's layer frame, line breaks are not checked. Run \`npm run text-reference\` first.`);
  const browser = await chromium.launch();
  try {
    for (const runId of runs) {
      const runDir = path.join(base, runId);
      if (!args.force && existsSync(path.join(runDir, "measure.json"))) { console.log(`= ${runId} already measured.`); continue; }
      console.log(`> measuring ${runId}...`);
      const workspace = path.join(runDir, "workspace");
      // A screenshot trial has no design.json in its workspace: the reference is then the export in mockups/.
      const inWorkspace = path.join(workspace, "mockup");
      const mockupDir = existsSync(path.join(inWorkspace, "design.json")) ? inWorkspace : path.join(MOCKUPS_DIR, args.mockup);
      const design = JSON.parse(await readFile(path.join(mockupDir, "design.json"), "utf8")) as Design;
      const { report, problem } = await readAgentReport(workspace);
      const final = await measureState(workspace, design, mockupDir, report, browser, texts, runDir);
      const rounds = [];
      for (const c of roundCommits(workspace)) {
        const m = await measureCommit(workspace, c.hash, design, mockupDir, report, browser, texts);
        rounds.push({ commit: c.hash, subject: c.subject, buildError: m.buildError, overall: m.overall });
      }
      await writeFile(path.join(runDir, "measure.json"), JSON.stringify({ runId, reportProblem: problem, final, rounds }, null, 2));
      const o = final.overall;
      console.log(`  median gap ${o.medianGap ?? "–"} px, worst ${o.worstGap ?? "–"} px (${o.blocks} blocks); `
        + `${o.unreportedAboveNoise} unreported defects above ${loadBenchConfig().noiseFloorPx} px, ${o.falseAlarms} false alarms; `
        + `${o.misbrokenTexts} misbroken texts of ${o.textsLineChecked} (${o.movedWords} words moved); ${rounds.length} rounds.`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
