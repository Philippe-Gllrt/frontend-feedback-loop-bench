// Tests of the scoring logic on small hand-made cases. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { atLeastOnePx, bucketOf, iou, letterRuns, matchBlocks, median, normaliseText, scoreBlocks, summarise, boxGap, textPositionGap } from "./score.ts";
import type { PageElement } from "./page-extract.ts";
import type { AgentReport, Block } from "./types.ts";

const style = { fontFamily: "Inter", fontWeight: 700, fontSize: 32, lineHeight: 40, color: "#111111", background: "#ffffff" };
const blocks: Block[] = [
  { id: "1:1", name: "Title", kind: "text", frameId: "f", sectionId: "s1", box: { x: 10, y: 10, w: 200, h: 40 }, text: "Hello\nworld", style },
  { id: "1:2", name: "Photo", kind: "image", frameId: "f", sectionId: "s1", box: { x: 0, y: 100, w: 300, h: 200 } },
  { id: "1:3", name: "Footer", kind: "text", frameId: "f", sectionId: "s2", box: { x: 0, y: 400, w: 100, h: 20 }, text: "Bye", style },
];
const cssStyle = { fontFamily: '"Inter", sans-serif', fontWeight: "700", fontSize: "32px", lineHeight: "40px", color: "rgb(17, 17, 17)", background: "rgba(0, 0, 0, 0)" };
const elements: PageElement[] = [
  { index: 0, kind: "text", text: "hello world", depth: 0, box: { x: 10, y: 13, w: 200, h: 40 }, style: cssStyle },        // 3 px low
  { index: 1, kind: "image", box: { x: 0, y: 100, w: 300, h: 200 } },                                                       // exact
  { index: 2, kind: "text", text: "bye", depth: 0, box: { x: 0, y: 400, w: 100, h: 20 }, style: { ...cssStyle, color: "rgb(17, 17, 18)" } }, // colour off by 1
];

test("helpers", () => {
  assert.equal(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }), 50 / 150);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.deepEqual([0, 1, 2, 3, 8, 9, null].map((g) => bucketOf(g, [0, 2, 8])), ["0", "1-2", "1-2", "3-8", "3-8", ">8", "missing"]);
});

test("gaps, styles and reported defects", () => {
  const report: AgentReport = { sections: [
    { sectionId: "s1", status: "non-conforming", issues: [{ blockId: "1:1", description: "title too low" }] },
    { sectionId: "s2", status: "conforming", issues: [] },
  ] };
  const results = scoreBlocks(blocks, elements, report, 1.0);
  const [title, photo, footer] = results;
  assert.equal(title.gap, 3);
  assert.equal(title.reported, true);
  assert.equal(photo.gap, 0);
  assert.equal(photo.isDefect, false);
  assert.equal(footer.gap, 0);
  assert.equal(footer.isDefect, true); // wrong colour, even if invisible
  assert.equal(footer.reported, false); // its section was declared conforming
  const colour = footer.styles.find((c) => c.property === "color")!;
  assert.equal(colour.ok, false);
  assert.equal(colour.belowPerception, true);

  const s = summarise(results, [0, 2, 8]);
  assert.equal(s.defects, 2);
  assert.equal(s.unreportedDefects, 1);
  assert.equal(s.unreportedStyleOnly, 1);
  assert.equal(s.worstGap, 3);
});

test("the agent's visible judgement is counted for reported defects only", () => {
  const report: AgentReport = { sections: [
    { sectionId: "s1", status: "non-conforming", issues: [{ blockId: "1:1", description: "title too low", visible: true }] },
    { sectionId: "s2", status: "conforming", issues: [{ blockId: "1:3", description: "colour", visible: false }] },
  ] };
  const results = scoreBlocks(blocks, elements, report, 1.0);
  assert.equal(results[0].judgedVisible, true);
  assert.equal(results[2].judgedVisible, null); // listed, but its section was declared conforming: not reported
  const s = summarise(results, [0, 2, 8]);
  assert.equal(s.reportedVisible, 1);
  assert.equal(s.reportedInvisible, 0);
});

test("a block missing from the page is an unreported defect when no report exists", () => {
  const results = scoreBlocks(blocks, [], null, 1.0);
  assert.ok(results.every((r) => !r.found && r.isDefect && !r.reported));
  assert.equal(summarise(results, [0, 2, 8]).unreportedByBucket.missing, 3);
  assert.equal(summarise(results, [0, 2, 8]).unreportedAboveNoise, 3); // missing blocks are always above the noise floor
});

test("a block listed without any defect is a false alarm", () => {
  // The photo (1:2) is exact; the agent lists it anyway.
  const report: AgentReport = { sections: [
    { sectionId: "s1", status: "non-conforming", issues: [{ blockId: "1:1", description: "title" }, { blockId: "1:2", description: "photo" }] },
  ] };
  const results = scoreBlocks(blocks, elements, report, 1.0);
  assert.equal(results[1].falseAlarm, true);
  assert.equal(results[0].falseAlarm, false); // a real defect, reported
  assert.equal(summarise(results, [0, 2, 8]).falseAlarms, 1);
  // The same block, which the agent itself marks not visible: not a false alarm (16/11).
  const notVisible: AgentReport = { sections: [
    { sectionId: "s1", status: "non-conforming", issues: [{ blockId: "1:2", description: "x is 0.01 px less", visible: false }] },
  ] };
  assert.equal(scoreBlocks(blocks, elements, notVisible, 1.0)[1].falseAlarm, false);
  const visible: AgentReport = { sections: [
    { sectionId: "s1", status: "non-conforming", issues: [{ blockId: "1:2", description: "photo too small", visible: true }] },
  ] };
  assert.equal(scoreBlocks(blocks, elements, visible, 1.0)[1].falseAlarm, true);
});

test("unreported gaps up to the noise floor are left out of unreportedAboveNoise", () => {
  const shifted = (dy: number): PageElement[] => [{ ...elements[0], box: { ...elements[0].box, y: 10 + dy } }, elements[1], { ...elements[2], style: cssStyle }];
  const at = (dy: number) => summarise(scoreBlocks(blocks, shifted(dy), null, 1.0), [0, 2, 8], 2);
  assert.equal(at(2).unreportedDefects, 1);
  assert.equal(at(2).unreportedAboveNoise, 0); // 2 px: noise floor
  assert.equal(at(3).unreportedAboveNoise, 1); // 3 px: counted
});

test("texts are measured by position, images by their whole box (16/11)", () => {
  // Real cases from the sort of the first pass (16/11), all judged by eye.
  const noise = {
    rotatedLetter: { dx: 0.1, dy: 0.2, dw: 10.5, dh: -0.5 }, // badge letter: same place, wider box
    narrowerParagraph: { dx: 0, dy: 0, dw: -4.3, dh: 0 }, // same words, same lines
    shorterTitle: { dx: 0, dy: 3, dw: 0, dh: -6 }, // line height: the text is centred in a shorter box
    emoji: { dx: -2.6, dy: -2.7, dw: 2.2, dh: 5.5 }, // Windows emoji font
  };
  for (const [name, d] of Object.entries(noise)) assert.ok(textPositionGap(d) <= 2, name);
  // The real defect: key figures left-aligned instead of centred on mobile (Playwright CLI).
  assert.equal(textPositionGap({ dx: -145.5, dy: 0, dw: 0, dh: 0 }), 146);
  assert.equal(textPositionGap({ dx: -15.1, dy: 0, dw: 0, dh: 0 }), 15);
  // A text drawn lower is still a gap, whatever its box.
  assert.equal(textPositionGap({ dx: 0, dy: 12, dw: 0, dh: 0 }), 12);
  // Images keep the whole box.
  assert.equal(boxGap({ dx: 0, dy: 0, dw: -277, dh: 0 }), 277);
});

test("text reference (D104): x and width from the reference, a misbroken text is a defect", () => {
  // Figma frame 200 px wide; the words take 120 px. The page draws 120 px, on one line.
  const b: Block = { id: "t", name: "T", kind: "text", frameId: "f", sectionId: "s1", box: { x: 10, y: 10, w: 200, h: 40 }, text: "Find your home" };
  const page: PageElement[] = [{ index: 0, kind: "text", text: "find your home", depth: 0, box: { x: 10, y: 10, w: 120, h: 40 }, lines: [["Find", "your", "home"]] }];
  const sameBreaks = { textBox: { dx: 0, w: 120 }, lines: [["Find", "your", "home"]], inkFigma: 118, inkProbe: 118 };
  const [ok] = scoreBlocks([b], page, null, 1, { t: sameBreaks });
  assert.equal(ok.gap, 0);
  assert.equal(ok.misbroken, false);
  assert.equal(ok.isDefect, false);
  const [noRef] = scoreBlocks([b], page, null, 1);
  assert.equal(noRef.gap, 0); // Figma's frame is 80 px wider, but the words start where they should (position, 16/11)
  assert.equal(noRef.delta!.dw, -80); // the raw difference is kept for reading
  const [bad] = scoreBlocks([b], page, null, 1, { t: { ...sameBreaks, lines: [["Find", "your"], ["home"]] } });
  assert.equal(bad.gap, 0);
  assert.equal(bad.misbroken, true);
  assert.equal(bad.isDefect, true);
  const s = summarise([bad], [0, 2, 8]);
  assert.equal(s.unreportedAboveNoise, 1);
  assert.equal(s.unreportedStyleOnly, 0);
  assert.equal(s.movedWords, 1);
});

test("missing blocks that were bench artefacts (16/11): typographic quotes, 0 px lines", () => {
  // Real case: the Sonnet control typed &rsquo; where Figma has a straight quote.
  assert.equal(normaliseText("Estatein’s services, “View Details”"), normaliseText("Estatein's services, \"View Details\""));
  const quote: Block = { id: "2:1", name: "Lead", kind: "text", frameId: "f", sectionId: "s", box: { x: 0, y: 0, w: 100, h: 20 }, text: "We're here", style };
  // Real case: a footer line of width 0 in Figma (181:1464), drawn as a 1 px image.
  const line: Block = { id: "2:2", name: "Line", kind: "image", frameId: "f", sectionId: "s", box: { x: 195.5, y: 4170, w: 0, h: 212 } };
  assert.deepEqual(atLeastOnePx(line.box), { x: 195, y: 4170, w: 1, h: 212 });
  const page: PageElement[] = [
    { index: 0, kind: "text", text: normaliseText("We’re here"), depth: 0, box: { x: 0, y: 0, w: 100, h: 20 } },
    { index: 1, kind: "image", box: { x: 195, y: 4170, w: 1, h: 212 } },
  ];
  const m = matchBlocks([quote, line], page);
  assert.equal(m.get("2:1")?.index, 0);
  assert.equal(m.get("2:2")?.index, 1);
});

test("a 0 px line in the page (width 0, drawn by a box-shadow) matches a 0 px line in Figma, not a real image (16/11)", () => {
  const line: Block = { id: "3:1", name: "Line", kind: "image", frameId: "f", sectionId: "s", box: { x: 195.5, y: 4170, w: 0, h: 212 } };
  const photo: Block = { id: "3:2", name: "Photo", kind: "image", frameId: "f", sectionId: "s", box: { x: 0, y: 0, w: 300, h: 200 } };
  const page: PageElement[] = [{ index: 0, kind: "image", box: { x: 195.5, y: 4170, w: 0, h: 212 } }, { index: 1, kind: "image", box: { x: 150, y: 0, w: 0, h: 200 } }];
  const m = matchBlocks([line, photo], page);
  assert.equal(m.get("3:1")?.index, 0);
  assert.equal(m.has("3:2"), false); // a hairline inside a photo is not the photo
});

test("the letters of a circular badge match one SVG text on a path, from any starting point (18/11)", () => {
  // Real case: Figma has one text layer per letter of "✨Discover..." around a circle; the three
  // agents of the screenshot series wrote one <textPath>, starting elsewhere or without the emoji.
  const letters: Block[] = [..."✨Dream"].map((c, i) => ({ id: `4:${i}`, name: "Text", kind: "text", frameId: "f", sectionId: "s", box: { x: 100 + i * 10, y: 100, w: 10, h: 10 }, text: c, style }));
  const other: Block = { id: "4:9", name: "Title", kind: "text", frameId: "f", sectionId: "s2", box: { x: 0, y: 0, w: 50, h: 10 }, text: "Bye", style };
  assert.deepEqual(letterRuns([...letters, other]).map((r) => r.length), [6]);
  const ring = { x: 100, y: 100, w: 60, h: 10 };
  const rotated: PageElement[] = [{ index: 0, kind: "text", text: "dream ✨", depth: 0, onPath: true, box: ring }];
  const results = scoreBlocks(letters, rotated, null, 1);
  assert.ok(results.every((r) => r.found && r.gap === 0), "every letter found, measured with the ring's box");
  // Without the emoji: the letters match, the emoji is left to the usual pass (here: missing).
  const noEmoji = scoreBlocks(letters, [{ ...rotated[0], text: "dream" }], null, 1);
  assert.deepEqual(noEmoji.map((r) => r.found), [false, true, true, true, true, true]);
  // An ordinary text (not on a path) with the same letters does not take them.
  assert.equal(matchBlocks(letters, [{ ...rotated[0], onPath: undefined }]).size, 0);
});

test("a CSS background image is matched and measured where the image is drawn, not by its element (18/11)", () => {
  // Real case: the hero decoration, 1924 x 1286 at (498, -75) in Figma, drawn by the Playwright MCP
  // agent as the background of a 920 x 814 element, offset -502 px -237 px.
  const deco: Block = { id: "5:1", name: "Abstract Design", kind: "image", frameId: "f", sectionId: "s", box: { x: 498, y: -75, w: 1924, h: 1286 } };
  const page: PageElement[] = [{ index: 0, kind: "image", box: { x: 1000, y: 162, w: 920, h: 814 }, imageBox: { x: 498, y: -75, w: 1924, h: 1286 } }];
  const [r] = scoreBlocks([deco], page, null, 1);
  assert.equal(r.gap, 0);
  const [old] = scoreBlocks([deco], [{ ...page[0], imageBox: undefined }], null, 1);
  assert.equal(old.gap, 1004); // what the bench measured before
});
