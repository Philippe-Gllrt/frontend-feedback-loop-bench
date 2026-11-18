# Front-end feedback loop testbench

**Which browser tool best helps a coding agent check its own front-end?**

When a coding agent builds a page from a mockup, it often says "done, it matches"
while the rendering does not. In back-end work the agent checks itself with text
(tests, types). In front-end work the check is visual, and the agent codes blind.

This bench measures the gap between **what the agent claims** and **what the code
measures**. An agent (Claude Code) builds the same Figma mockup in an empty
React + TypeScript project, once per browser tool, following the same skill:
build a section, look at it in a browser, measure the gap with the mockup, fix,
repeat. A script then measures the result, independently of the agent.

Existing comparisons of browser tools count tokens on browsing tasks. This one
asks whether the tool helps the agent **find the defects in its own front-end**.

## What is compared

| Condition | How the agent sees the page |
|---|---|
| Control (homemade loop) | Same skill, without the browser steps, and no browser tool. The first controls (Opus 5.5, Sonnet 5.5) still built their own loop: a script that drives the Chrome or Edge installed on the machine, headless. Kept as a result: what an agent does alone |
| Strict control (`strict-control`) | It does not, at all: same skill, plus a rule that forbids any browser. The bench stops the session (failed attempt) at the first Bash command **or written file** that names a browser, a headless mode or a browser library (`forbidden` in `config/tools.json`) |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | MCP server |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP server |
| [Playwright CLI](https://github.com/microsoft/playwright-cli) | CLI + skill |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | CLI + skill |
| [dev-browser](https://github.com/sawyerhood/dev-browser) | MCP server (macOS and Linux only) |
| [Playwriter](https://github.com/remorses/playwriter) | Chrome extension + CLI + skill |
| [Claude in Chrome](https://code.claude.com/docs/en/chrome) | Chrome extension (`claude --chrome`) |

The list lives in [`config/tools.json`](config/tools.json). Adding a tool means adding an entry.
The first test is **raw**: every tool is installed exactly as its README says, with
the same skill for all and no tool-specific guidance. Each entry has an optional
`extraContext` field, empty by default, for a later test with tool-specific guidance.

## What is measured

All measures are computed by code ([`src/lib/score.ts`](src/lib/score.ts), [`src/lib/responsive.ts`](src/lib/responsive.ts)), never by a model.

| Measure | Definition |
| --- | --- |
| **Remaining gap** (main measure) | For each key block (texts, images, icons), at the end of the trial, in px. An image: the largest of the x, y, width and height differences with Figma. A text: its **position**, not the size of its box — on each axis, the smallest offset among the start, the centre and the end of the box, so a text drawn in the right place counts whatever its alignment; its size is covered by the font size and the line breaks. (Sorting every block above 2 px of the first pass by eye showed that text box sizes were always noise: rotated letters, line heights, the system emoji font.) No tolerance: the target is 0 px. The report gives the distribution (0, 1-2, 3-8, >8 px, missing), the median and the worst gap. **How a block is found:** a text by its words (the text shown, without parts hidden by `display: none`; typographic and straight quotes are the same; a field's `placeholder` counts as a text), an image by its overlap with the Figma box (a 0 px line, in Figma or in the page, counts as 1 px wide; an element of width 0 that draws a line counts as an image). Reading the "missing" blocks of 10 trials showed that each of these cases made a block missing while the page showed it. |
| **Report vs page** (guard rail) | A defect is a key block with a layout gap of at least 1 px, a block missing from the page, or a wrong style value. It counts as reported only if the agent's final report marks the block's section as non-conforming **and** lists the block. *Unreported defects* are counted above 2 px (`noiseFloorPx`): a 1-2 px gap can come from font rendering, so that range is read against the control. *False alarms* are blocks the agent lists while they have no defect, so flagging everything does not pay; an issue the agent itself marks `visible: false` does not count (noting a 0.01 px difference and saying it does not show is scrupulous, not crying wolf). |
| Responsive | The page is also rendered at 1280 and 768 px (`responsiveWidths`), where the mockup has no frame: horizontal overflow, and overlaps of the mockup's texts that the mockup itself does not have. Overlaps are taken on the part of each element that can be seen (an image cut by its section's `overflow` only overlaps with what shows), and a text over a backdrop (an image the mockup itself puts texts on, recognised by its file name) is not counted: only the image's box is known, not where its pixels are transparent. `position: absolute` elements are counted at every width. Captures are kept for reading. |
| Style fidelity                        | Font size, weight, family, line height, text colour and background colour of each text block. A value is right only if it is equal to Figma's. A wrong colour also gets its CIEDE2000 distance, flagged when it is below human perception.                                    |
| Image similarity                      | Share of identical pixels between the capture and the Figma export (pixelmatch). An indicator only: a 2 px font shift moves the whole score.                                                                                                                                  |
| Technical quality                     | Console errors, failed builds.                                                                                                                                                                                                                                                |
| Curve per round                       | The same numbers after each round of the fix loop (one commit per round).                                                                                                                                                                                                     |
| Cost                                  | Tokens, estimated cost, turns and duration, from the Claude Code session log.                                                                                                                                                                                                 |

The bench does not replace looking: put the mockup and each rendering side by side
and read every report before trusting the numbers.

## How to run it

Requirements: Node 23.6 or later (the scripts are TypeScript run directly by Node),
git, [Claude Code](https://code.claude.com/docs/en/overview), and a Figma personal access token.

```bash
npm install
npx playwright install chromium
npm test
```

1. **Export your mockup once.** Pick a Figma file with a desktop frame and a mobile
   frame, then run:

   ```bash
   FIGMA_TOKEN=<token> npm run export -- --file <fileKey> --desktop <nodeId> --mobile <nodeId> --name my-mockup
   ```

   This writes `mockups/my-mockup/` (captures, assets and `design.json`). The agent
   reads this export, not Figma: every trial gets exactly the same input, and no
   Figma quota is used during the trials. Check the key blocks the script picked:
   the automatic pick can keep decorative shapes or miss a button drawn as a plain rectangle.
   Sections are the direct children of each frame, sorted top to bottom; the n-th desktop
   section is paired with the n-th mobile one, so the export stops if their counts differ.

   Then compute the text reference (needs FIGMA_TOKEN, in the environment or in `.env`):

   ```bash
   npm run text-reference -- --mockup my-mockup
   ```

   It lays out every mockup text in Chromium at its Figma width and style, and writes
   `mockups/my-mockup/text-reference.json`: where each text should be drawn, and the words
   of each line. The measurement uses it for the x and width of texts (Figma's layer frame
   is often much wider than its words) and to count misbroken texts. The agent never sees
   it. The script lists the texts whose layout differs from Figma's ink by more than the
   noise floor: read them against the mockup capture before trusting their line breaks.

2. **Read the skill** the agent follows, in `skill/`: `SKILL.md` for the browser tools,
   `SKILL.control.md` for the controls, and their `*.screenshot.md` variants for the
   screenshot input. Adapt it if you want; see [`skill/README.md`](skill/README.md) for
   what the bench needs from it (one commit per round, a `report.json` at the end).

3. **Install the tools** listed as `prerequisites` in `config/tools.json` (global CLIs,
   browser extensions). Keep browser skills out of `~/.claude/skills`, or every trial will see them.

4. **Check the setup, run a pilot**, then the trials:

   ```bash
   npm run run-trials -- --mockup my-mockup --check
   npm run run-trials -- --mockup my-mockup --trials 1 --tools control,playwright-mcp
   npm run run-trials -- --mockup my-mockup
   ```

   Every run starts with checks that call no model: Claude Code is found, it is logged
   in with a plan (an API key is refused, so the trials are never billed at API rates),
   the dev server starts, and each tool's health check passes. `--check` stops after them.
   The bench finds Claude Code by itself: `CLAUDE_BIN`, then the PATH, then the native
   installer's folder (`~/.local/bin`). To force a path on your machine, write it in
   `config/bench.local.json` (`{ "claudeBin": "..." }`). That file overrides any key of
   `config/bench.json` and is kept out of git.

   **Series.** `--model` and `--effort` override `config/bench.json` for one series, and
   `--input screenshot` gives the agent only the two captures and the assets (plus the
   frame sizes and section ids in `sections.json`), never `design.json`; the measurement
   still compares the page with `design.json`. Each series gets its own folder,
   `runs/<mockup>/<model>_<effort>[_screenshot]/` (e.g. `runs/my-mockup/opus-5-5_xhigh/`),
   so series never mix. `measure` and `report` take the same options.

   A trial cut by the usage quota (5-hour limit, or the agent stopping in the grace period)
   is not a failure: it is moved to `_usage-limit/` and the run stops; run the same command
   again after the reset.

   Each trial is a fresh, non-interactive Claude Code session (`claude -p`) with one
   tool plugged in (`--mcp-config` + `--strict-mcp-config`). Trials are interleaved:
   trial 1 of every tool, then trial 2 of every tool, so no tool gets a better or worse
   moment. `trialsPerCondition` starts at 1: read the token cost of that first pass, then
   raise it; finished trials are kept. An interrupted run resumes where it stopped.

   The agent works in a fresh folder of the system's temporary directory, outside this
   repository; the folder is moved to `runs/` once the session is over. **Trials run
   with `--permission-mode bypassPermissions`**: the agent can still run any command on
   the machine. Run the bench where you are fine with that. The two tools that drive a
   real Chrome (Playwriter, Claude in Chrome) must use a Chrome profile made for the
   bench, with no personal account in it, and may need you in front of the screen.
   Open that Chrome before a Playwriter trial: its health check opens a session through
   the extension. A tool can list forbidden uses in `config/tools.json` (`forbidden`):
   Playwriter run without its extension (`--browser headless`, `--direct`...) is not the
   Playwriter condition, so the bench stops the session at once and the attempt fails.

5. **Measure and report:**

   ```bash
   npm run measure -- --mockup my-mockup
   npm run report -- --mockup my-mockup
   ```

   Add `--model`, `--effort` or `--input` if the trials used them. The report is written
   to `report.md` in the series folder (e.g. `runs/my-mockup/opus-5-5_xhigh/report.md`),
   with every number per trial in `trials.csv` next to it.

6. **Look at two versions side by side** (optional):

   ```bash
   npm run compare
   ```

   Opens a viewer on http://localhost:4400/ that shows two versions in scaled device frames
   (1920 × 1080 desktop down to a 390 px phone): the Figma capture of a mockup, or the built
   page of any trial (`workspace/dist`). Scrolling is linked, the choice is kept in the URL,
   and "Mode capture" hides the toolbar for screenshots. Each trial is served on its own port
   (4401 and up); a small script is injected into the served HTML to link scrolling and hide
   the scrollbar, the trial's files are not changed.

## Settings

[`config/bench.json`](config/bench.json): model and its effort (`--effort`), trials per condition (1 to start), rounds per
section (3), the instruction given to the agent, the colour perception threshold, the gap buckets,
the noise floor (2 px) and the responsive widths (1280 and 768 px).

## Repository layout

```
config/     the conditions (tools.json) and the bench settings (bench.json)
skill/      the skill the agent follows, with its control and screenshot variants
template/   the empty React + TypeScript (Vite) project copied into every trial
src/        export, launcher, measurement, report (TypeScript, run by Node)
mockups/    your exported mockups (not versioned)
runs/       trial workspaces, logs, measures and reports (not versioned)
```

## Not done yet

- The Lighthouse accessibility score.
- Charts, and the curve per round in `report.md` (the numbers are in each `measure.json`).

## License

[MIT](LICENSE)
