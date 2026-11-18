// Pure scoring logic: matches the mockup's key blocks with the page's elements,
// measures the gaps, and checks the agent's report against them.
// No browser and no file access here, so everything can be unit-tested (score.test.ts).
//
// Definitions used by the bench (decided before the first trial):
// - Layout gap of a block = the largest of |dx|, |dy|, |dw|, |dh|, in px, rounded to
//   the nearest integer (Figma coordinates are floats). No tolerance: 0 px is the target.
//   The report gives the distribution (0, 1-2, 3-8, >8 px), the median and the worst gap.
//   This REMAINING GAP at the end of the trial is the main measure of the bench: the
//   question is whether the tool helps the agent get the page right.
// - A block that cannot be found in the page is "missing": a defect in its own row.
// - Style: 6 properties of text blocks (size, weight, family, line height, text colour,
//   background colour). A value is right only if it is equal. A wrong colour also gets
//   its CIEDE2000 distance and a flag saying whether it is below human perception.
// - A defect is any block with a layout gap >= 1 px, a missing block, or a wrong style value.
//   It is REPORTED only if the agent's report marks its section "non-conforming" AND lists
//   its block id in that section's issues. Everything else is an UNREPORTED defect.
// - A FALSE ALARM is a block the agent lists in its issues while it has no defect, so an
//   agent that flags every block does not look careful for free. Since 16/11/2026, an issue
//   the agent itself marks `visible: false` is not a false alarm: noting a 0.01 px difference
//   and saying it does not show is scrupulous, not crying wolf. An issue without `visible`
//   still counts, as a claim of a problem.
// - Unreported defects and false alarms are the secondary measure, the guard rail: they
//   check that the agent's claims match the page. Unreported defects are counted above the
//   noise floor (`noiseFloorPx`, 2 px): a 1-2 px gap can come from font rendering rather than
//   from the agent, so that range is only compared with the control, as a background level.
// - Texts (D104), when mockups/<name>/text-reference.json exists: the expected x and width of
//   a text are those of its Chromium layout at Figma's width (the advance of the letters, like
//   the page measure), not Figma's layer frame; y and height stay Figma's frame. And the words
//   of each line are compared with the reference: a text whose words sit on other lines, or
//   that draws another number of lines, is MISBROKEN, a defect whatever its layout gap.
// - Texts are measured by their POSITION, not by the size of their box (decided 16/11/2026,
//   after sorting every block above 2 px of the first pass by eye: the size of a text box was
//   noise in every case, the reader sees the text, not its box). On each axis, the gap of a
//   text is the smallest offset among the start, the centre and the end of its box, so a text
//   drawn in the right place counts as right whatever its alignment. The size stays covered by
//   the font size (styles) and the line breaks (MISBROKEN). Images keep the full box gap.
//   `delta` still holds the four raw differences, for reading.
// - Two layouts that draw the same thing differently (18/11/2026, screenshot input: the three
//   agents built them this way, and the page matched the mockup by eye):
//   * a text along a circle is one text layer per letter in Figma and one SVG <textPath> in the
//     page. A run of one-letter texts of a section is matched with a text on a path whose letters
//     are the same, read from any starting point (a circle has none); if only the symbols differ
//     (an emoji drawn apart), the letters are matched and the symbols are left to the usual pass.
//     Each letter is then measured against the whole run: the ring's box against the page's;
//   * an image drawn as a CSS background is measured where the image is drawn (`imageBox`), not
//     by its element: Figma's box of a decoration that spills out is the whole image.
import { cssColorToHex, deltaE2000Hex } from "./color.ts";
import { compareLines, isMisbroken, type LineBreaks } from "./lines.ts";
import type { PageElement } from "./page-extract.ts";
import type { AgentReport, Block, Box, TextReference } from "./types.ts";

export type StyleCheck = {
  property: "fontSize" | "fontWeight" | "fontFamily" | "lineHeight" | "color" | "background";
  expected: string | number;
  actual: string | number | null;
  ok: boolean;
  /** Only for wrong colours: CIEDE2000 distance and whether it is under the perception threshold. */
  deltaE00?: number;
  belowPerception?: boolean;
};

export type BlockResult = {
  blockId: string;
  sectionId: string;
  kind: Block["kind"];
  found: boolean;
  /** Signed differences rendered - mockup, in px (null if the block is missing). */
  delta: { dx: number; dy: number; dw: number; dh: number } | null;
  /** Images: max(|dx|,|dy|,|dw|,|dh|) rounded. Texts: the position gap (textPositionGap). Null if missing. */
  gap: number | null;
  styles: StyleCheck[];
  /** Line breaks against the reference (texts only); null if there is no reference or the words differ. */
  lineBreaks: LineBreaks | null;
  misbroken: boolean;
  /** The text has a reference (D104): its x and width are measured against it. */
  textReference: boolean;
  isDefect: boolean;
  reported: boolean;
  /** The agent lists the block in its issues, but the block has no defect. */
  falseAlarm: boolean;
  /** For a reported defect: the agent's `visible` judgement (null if it gave none, or if not reported). */
  judgedVisible: boolean | null;
};

/** Normalises a Figma text the way the page extraction normalises the DOM text. */
export function normaliseText(s: string): string {
  return normaliseQuotes(s).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Typographic quotes become straight ones (16/11): ’ and ' are the same text to a reader, and an
 * agent that types ’ where Figma has ' (or the reverse) must not make the block "missing".
 * page-extract.ts repeats this rule (it runs in the page and cannot import it).
 */
export function normaliseQuotes(s: string): string {
  return s.replace(/[‘’ʼ′]/g, "'").replace(/[“”″]/g, '"');
}

type Delta = { dx: number; dy: number; dw: number; dh: number };

/** Gap of an image: the largest of the four differences of its box, rounded. */
export function boxGap(d: Delta): number {
  return Math.round(Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh)));
}

/**
 * Gap of a text: where the text is, not how big its box is. On each axis, the smallest offset
 * among the start (dx), the centre (dx + dw/2) and the end (dx + dw) of the box; then the larger
 * of the two axes, rounded.
 */
export function textPositionGap(d: Delta): number {
  const axis = (offset: number, size: number) => Math.min(Math.abs(offset), Math.abs(offset + size / 2), Math.abs(offset + size));
  return Math.round(Math.max(axis(d.dx, d.dw), axis(d.dy, d.dh)));
}

/**
 * A box at least 1 px wide and tall, keeping its centre (16/11). Figma draws a hairline as a
 * line of width or height 0: its area is 0, so its IoU with anything is 0 and it could never be found.
 */
export function atLeastOnePx(b: Box): Box {
  const w = Math.max(b.w, 1), h = Math.max(b.h, 1);
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

/** Area of the intersection of two boxes divided by the area of their union (0..1). */
export function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Distance between the centres of two boxes. */
const centreDistance = (a: Box, b: Box) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));

/** Minimum overlap for an image element to count as the rendering of an image block. Below it, the block is "missing". */
export const MIN_IMAGE_IOU = 0.1;

/** Where an image element draws its image: its `imageBox` for a CSS background drawn once, else its box. */
const drawnBox = (e: PageElement): Box => e.imageBox ?? e.box;

/** Runs of consecutive one-character text blocks of one section, 3 or more: the letters of a text set along a path. */
export function letterRuns(blocks: Block[]): Block[][] {
  const runs: Block[][] = [];
  let run: Block[] = [];
  const flush = () => { if (run.length >= 3) runs.push(run); run = []; };
  for (const b of blocks) {
    const letter = b.kind === "text" && [...(b.text ?? "").trim()].length === 1;
    if (!letter || (run.length && run[0].sectionId !== b.sectionId)) flush();
    if (letter) run.push(b);
  }
  flush();
  return runs;
}

/** True if b is a with its characters read from another starting point (both without spaces). */
const isRotation = (a: string, b: string) => a.length > 0 && a.length === b.length && (a + a).includes(b);
const squeeze = (s: string) => normaliseText(s).replace(/\s+/g, "");
const lettersOnly = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");

/** The smallest box holding all the given boxes. */
export function unionBox(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Matches each block of one frame with at most one page element, each element used once
 * (except a text on a path, shared by the letters of its run).
 * - Letters of a text on a path (see the header): first, so that a letter is not taken by a lone
 *   character elsewhere. `groups`, if given, receives for each such letter the box of its run.
 * - Texts: same normalised text; among candidates, the innermost element, then the nearest one.
 *   Matching by content, like Design2Code, means a misplaced text is still found and its gap measured.
 * - Images: greedy, by decreasing overlap (IoU) with the block's box (a 0 px line, in Figma or in the page, counts as 1 px wide).
 * Returns a map blockId -> element.
 */
export function matchBlocks(blocks: Block[], elements: PageElement[], groups: Map<string, Box> = new Map()): Map<string, PageElement> {
  const used = new Set<number>();
  const result = new Map<string, PageElement>();

  for (const run of letterRuns(blocks)) {
    const key = squeeze(run.map((b) => b.text ?? "").join(""));
    for (const e of elements.filter((x) => x.onPath && !used.has(x.index))) {
      const text = squeeze(e.text ?? "");
      const matched = isRotation(key, text) ? run
        : isRotation(lettersOnly(key), lettersOnly(text)) ? run.filter((b) => lettersOnly(normaliseText(b.text ?? "")) !== "")
        : null;
      if (!matched) continue;
      const box = unionBox(matched.map((b) => b.box));
      for (const b of matched) { result.set(b.id, e); groups.set(b.id, box); }
      used.add(e.index);
      break;
    }
  }

  for (const b of blocks.filter((x) => x.kind === "text" && !result.has(x.id))) {
    const target = normaliseText(b.text ?? "");
    const candidates = elements
      .filter((e) => e.kind === "text" && !used.has(e.index) && e.text === target)
      .sort((p, q) => (p.depth ?? 0) - (q.depth ?? 0) || centreDistance(p.box, b.box) - centreDistance(q.box, b.box));
    if (candidates.length) { result.set(b.id, candidates[0]); used.add(candidates[0].index); }
  }

  const pairs: Array<{ block: Block; el: PageElement; score: number }> = [];
  for (const b of blocks.filter((x) => x.kind === "image")) {
    for (const e of elements.filter((x) => x.kind === "image")) {
      const score = iou(atLeastOnePx(b.box), atLeastOnePx(drawnBox(e)));
      if (score >= MIN_IMAGE_IOU) pairs.push({ block: b, el: e, score });
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  for (const p of pairs) {
    if (result.has(p.block.id) || used.has(p.el.index)) continue;
    result.set(p.block.id, p.el);
    used.add(p.el.index);
  }
  return result;
}

/** Float comparison for values that must be equal but come through float arithmetic (e.g. 1.6 * 18). Not a design tolerance. */
const sameNumber = (a: number, b: number) => Math.abs(a - b) < 0.01;

/** First family of a CSS font-family list, without quotes, in lower case. */
const firstFamily = (css: string) => css.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();

/** Compares the 6 style properties of a text block. Properties Figma has no single value for are skipped. */
export function checkStyles(block: Block, el: PageElement, jnd: number): StyleCheck[] {
  const s = block.style, cs = el.style;
  if (!s || !cs) return [];
  const checks: StyleCheck[] = [];
  if (s.fontSize !== null) {
    const actual = parseFloat(cs.fontSize);
    checks.push({ property: "fontSize", expected: s.fontSize, actual, ok: sameNumber(actual, s.fontSize) });
  }
  if (s.fontWeight !== null) {
    const actual = Number(cs.fontWeight);
    checks.push({ property: "fontWeight", expected: s.fontWeight, actual, ok: actual === s.fontWeight });
  }
  if (s.fontFamily !== null) {
    // Limit: the computed font-family says which font was ASKED for, not which one was drawn.
    // A missing web font falls back silently; the layout gap and the image diff catch that case.
    const actual = firstFamily(cs.fontFamily);
    checks.push({ property: "fontFamily", expected: s.fontFamily, actual, ok: actual === s.fontFamily.toLowerCase() });
  }
  if (s.lineHeight !== null) {
    const actual = cs.lineHeight === "normal" ? null : parseFloat(cs.lineHeight);
    checks.push({ property: "lineHeight", expected: s.lineHeight, actual, ok: actual !== null && sameNumber(actual, s.lineHeight) });
  }
  for (const property of ["color", "background"] as const) {
    const expected = s[property];
    if (expected === null) continue;
    const actual = cssColorToHex(cs[property]) ?? (property === "background" ? "#ffffff" : null); // no painted background = the white canvas
    const ok = actual === expected;
    const check: StyleCheck = { property, expected, actual, ok };
    if (!ok && actual) {
      check.deltaE00 = Math.round(deltaE2000Hex(expected, actual) * 100) / 100;
      check.belowPerception = check.deltaE00 < jnd;
    }
    checks.push(check);
  }
  return checks;
}

/** True if the agent lists this block in the issues of its section, whatever the section's status. */
export function isListed(block: Block, report: AgentReport | null): boolean {
  const section = report?.sections?.find((s) => s.sectionId === block.sectionId);
  return (section?.issues ?? []).some((i) => i.blockId === block.id);
}

/** True if the agent's report flags this block: section non-conforming and block listed in its issues. */
export function isReported(block: Block, report: AgentReport | null): boolean {
  const section = report?.sections?.find((s) => s.sectionId === block.sectionId);
  if (!section || section.status !== "non-conforming") return false;
  return (section.issues ?? []).some((i) => i.blockId === block.id);
}

/** The agent's `visible` judgement on a block it listed; null if it gave none. */
export function judgedVisible(block: Block, report: AgentReport | null): boolean | null {
  const section = report?.sections?.find((s) => s.sectionId === block.sectionId);
  const issue = (section?.issues ?? []).find((i) => i.blockId === block.id);
  return typeof issue?.visible === "boolean" ? issue.visible : null;
}

/**
 * Scores every block of one frame against the page rendered at that frame's width.
 * Page coordinates and frame coordinates share the same origin (top-left of the page).
 */
export function scoreBlocks(blocks: Block[], elements: PageElement[], report: AgentReport | null, jnd: number, texts: Record<string, TextReference> = {}): BlockResult[] {
  const groups = new Map<string, Box>();
  const matches = matchBlocks(blocks, elements, groups);
  return blocks.map((b) => {
    const el = matches.get(b.id);
    const group = groups.get(b.id);
    const ref = b.kind === "text" && !group ? texts[b.id] : undefined;
    const expected = group ?? (ref ? { ...b.box, x: b.box.x + ref.textBox.dx, w: ref.textBox.w } : b.box);
    const got = el ? (b.kind === "image" ? drawnBox(el) : el.box) : null;
    const delta = got ? { dx: got.x - expected.x, dy: got.y - expected.y, dw: got.w - expected.w, dh: got.h - expected.h } : null;
    const gap = delta ? (b.kind === "text" ? textPositionGap(delta) : boxGap(delta)) : null;
    const styles = el && b.kind === "text" ? checkStyles(b, el, jnd) : [];
    const lineBreaks = ref && el?.lines ? compareLines(ref.lines, el.lines) : null;
    const misbroken = isMisbroken(lineBreaks);
    const isDefect = gap === null || gap >= 1 || styles.some((c) => !c.ok) || misbroken;
    const reported = isDefect && isReported(b, report);
    const falseAlarm = !isDefect && isListed(b, report) && judgedVisible(b, report) !== false;
    return { blockId: b.id, sectionId: b.sectionId, kind: b.kind, found: !!el, delta, gap, styles, lineBreaks, misbroken, textReference: !!ref, isDefect, reported, falseAlarm, judgedVisible: reported ? judgedVisible(b, report) : null };
  });
}

/** Bucket label of a layout gap, with buckets [0, 2, 8] -> "0", "1-2", "3-8", ">8", and "missing". */
export function bucketOf(gap: number | null, buckets: [number, number, number]): string {
  if (gap === null) return "missing";
  const [a, b, c] = buckets;
  if (gap <= a) return `${a}`;
  if (gap <= b) return `${a + 1}-${b}`;
  if (gap <= c) return `${b + 1}-${c}`;
  return `>${c}`;
}

/** Median of a list of numbers (null for an empty list). */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Summary of one measured state of the page (one frame or all frames together). */
export type Summary = {
  blocks: number;
  layoutBuckets: Record<string, number>;
  medianGap: number | null;
  worstGap: number | null;
  styleChecks: number;
  styleOk: number;
  styleScore: number | null;
  wrongColoursBelowPerception: number;
  defects: number;
  unreportedDefects: number;
  /** Unreported defects split by layout bucket. */
  unreportedByBucket: Record<string, number>;
  unreportedStyleOnly: number;
  /** Guard rail: unreported blocks that are missing or have a layout gap above the noise floor (style-only defects apart). */
  unreportedAboveNoise: number;
  /** Guard rail: blocks listed by the agent that have no defect. */
  falseAlarms: number;
  /** Reported defects the agent judged visible / not visible (the rest gave no judgement). */
  reportedVisible: number;
  reportedInvisible: number;
  /** Line breaks (D104): texts compared with the reference, misbroken ones, words on another line, misbroken and unreported. */
  textsLineChecked: number;
  misbrokenTexts: number;
  movedWords: number;
  unreportedMisbroken: number;
  /** Texts with a reference whose words differ in the page: no line comparison. */
  linesNotComparable: number;
};

/**
 * Aggregates block results into the numbers the report shows.
 * `noiseFloorPx`: unreported gaps up to this value are left out of unreportedAboveNoise.
 */
export function summarise(results: BlockResult[], buckets: [number, number, number], noiseFloorPx = 2): Summary {
  const labels = [bucketOf(0, buckets), bucketOf(buckets[0] + 1, buckets), bucketOf(buckets[1] + 1, buckets), bucketOf(buckets[2] + 1, buckets), "missing"];
  const layoutBuckets = Object.fromEntries(labels.map((l) => [l, 0]));
  const unreportedByBucket = Object.fromEntries(labels.map((l) => [l, 0]));
  let unreportedStyleOnly = 0;
  for (const r of results) {
    const label = bucketOf(r.gap, buckets);
    layoutBuckets[label]++;
    if (r.isDefect && !r.reported) {
      // A block whose only problem is style sits in the "0" layout bucket: count it apart.
      // A misbroken text at 0 px is counted with the line breaks, not here.
      if (r.gap === 0) { if (!r.misbroken) unreportedStyleOnly++; }
      else unreportedByBucket[label]++;
    }
  }
  const gaps = results.filter((r) => r.gap !== null).map((r) => r.gap!);
  const styles = results.flatMap((r) => r.styles);
  const styleOk = styles.filter((c) => c.ok).length;
  const defects = results.filter((r) => r.isDefect).length;
  return {
    blocks: results.length,
    layoutBuckets,
    medianGap: median(gaps),
    worstGap: gaps.length ? Math.max(...gaps) : null,
    styleChecks: styles.length,
    styleOk,
    styleScore: styles.length ? styleOk / styles.length : null,
    wrongColoursBelowPerception: styles.filter((c) => c.belowPerception).length,
    defects,
    unreportedDefects: results.filter((r) => r.isDefect && !r.reported).length,
    unreportedByBucket,
    unreportedStyleOnly,
    // A misbroken text is never noise: the reference is laid out by the same engine as the page.
    unreportedAboveNoise: results.filter((r) => r.isDefect && !r.reported && (r.gap === null || r.gap > noiseFloorPx || r.misbroken)).length,
    falseAlarms: results.filter((r) => r.falseAlarm).length,
    reportedVisible: results.filter((r) => r.reported && r.judgedVisible === true).length,
    reportedInvisible: results.filter((r) => r.reported && r.judgedVisible === false).length,
    textsLineChecked: results.filter((r) => r.lineBreaks).length,
    misbrokenTexts: results.filter((r) => r.misbroken).length,
    movedWords: results.reduce((n, r) => n + (r.lineBreaks?.movedWords ?? 0), 0),
    unreportedMisbroken: results.filter((r) => r.misbroken && !r.reported).length,
    linesNotComparable: results.filter((r) => r.textReference && r.found && !r.lineBreaks).length,
  };
}
