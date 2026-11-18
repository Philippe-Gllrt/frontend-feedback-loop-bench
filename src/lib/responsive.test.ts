// Tests of the responsive check (overlaps) on small hand-made cases. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assetStem, findOverlaps, intersection, mockupOverlaps } from "./responsive.ts";
import type { PageElement } from "./page-extract.ts";
import type { Block } from "./types.ts";

// Mockup: a heading on a photo (allowed), and a paragraph below, apart from everything.
const blocks: Block[] = [
  { id: "1", name: "Photo", kind: "image", frameId: "f", sectionId: "s", box: { x: 0, y: 0, w: 400, h: 200 } },
  { id: "2", name: "Heading", kind: "text", frameId: "f", sectionId: "s", box: { x: 20, y: 20, w: 200, h: 40 }, text: "Find your home" },
  { id: "3", name: "Body", kind: "text", frameId: "f", sectionId: "s", box: { x: 0, y: 260, w: 400, h: 60 }, text: "We help you" },
];
const keyTexts = new Set(["find your home", "we help you"]);
const allowed = mockupOverlaps(blocks, 2);

const el = (index: number, kind: "text" | "image", box: PageElement["box"], text?: string, ancestors: number[] = []): PageElement =>
  ({ index, kind, text, nodeId: index, ancestors, box });

test("intersection", () => {
  assert.deepEqual(intersection({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 8, w: 10, h: 10 }), { w: 5, h: 2 });
  assert.deepEqual(intersection({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 }), { w: 0, h: 5 }); // apart on x: no overlap
});

test("the mockup's own overlaps are not counted", () => {
  assert.ok(allowed.textsOnImage.has("find your home"));
  const page = [el(0, "image", { x: 0, y: 0, w: 400, h: 200 }), el(1, "text", { x: 20, y: 20, w: 200, h: 40 }, "find your home")];
  assert.equal(findOverlaps(page, keyTexts, allowed, 2).length, 0);
});

test("a paragraph pushed over the heading is counted once, through the innermost element", () => {
  const page = [
    el(0, "text", { x: 0, y: 0, w: 400, h: 100 }, "find your home"),                    // a card holding the heading
    el(1, "text", { x: 20, y: 20, w: 200, h: 40 }, "find your home", [0]),             // the heading itself
    el(2, "text", { x: 10, y: 30, w: 300, h: 40 }, "we help you"),                     // absolutely placed paragraph
  ];
  const found = findOverlaps(page, keyTexts, allowed, 2);
  assert.equal(found.length, 1);
  assert.equal(found[0].kinds, "text/text");
});

test("nested elements, thin touches and image over image are not overlaps", () => {
  const page = [
    el(0, "image", { x: 0, y: 0, w: 400, h: 200 }),
    el(1, "image", { x: 100, y: 100, w: 50, h: 50 }),                                   // icon on the photo
    el(2, "text", { x: 0, y: 300, w: 400, h: 20 }, "we help you"),
    el(3, "text", { x: 0, y: 318, w: 400, h: 20 }, "find your home"),                  // 2 px of line box: noise
  ];
  assert.equal(findOverlaps(page, keyTexts, allowed, 2).length, 0);
});

test("an image cut by its section only overlaps with what shows (17/11)", () => {
  // Real case (Opus Chrome DevTools at 768 px): a decorative image of the CTA section spills under the
  // footer's "Enter Your Email", but the section cuts it (overflow: hidden), so nothing shows there.
  const text = el(1, "text", { x: 63, y: 3999, w: 101, h: 24 }, "we help you");
  const cut = { ...el(0, "image", { x: -20, y: 3482, w: 284, h: 522 }), visibleBox: { x: 0, y: 3482, w: 264, h: 450 } };
  assert.equal(findOverlaps([cut, text], keyTexts, allowed, 2).length, 0);
  const uncut = el(0, "image", { x: -20, y: 3482, w: 284, h: 522 });
  assert.equal(findOverlaps([uncut, text], keyTexts, allowed, 2).length, 1); // without the cut, it would count
});

test("a text over a backdrop, an image the mockup itself puts texts on, is not counted (17/11)", () => {
  // Real case (Opus control at 1280 px): the hero's "Abstract Design" pattern (121-1829.png) holds
  // the hero texts in the mockup; at 1280 px it also sits behind "200+", invisible (transparent).
  const withAsset: Block[] = [
    { id: "9", name: "Abstract Design", kind: "image", frameId: "f", sectionId: "s", box: { x: 0, y: 0, w: 400, h: 200 }, asset: "assets/121-1829.png" },
    { id: "10", name: "Title", kind: "text", frameId: "f", sectionId: "s", box: { x: 20, y: 20, w: 200, h: 40 }, text: "Find your home" },
    { id: "11", name: "Stat", kind: "text", frameId: "f", sectionId: "s", box: { x: 0, y: 300, w: 100, h: 40 }, text: "We help you" },
  ];
  const allowedHere = mockupOverlaps(withAsset, 2);
  assert.ok(allowedHere.backdrops.has("121-1829"));
  assert.equal(assetStem("http://localhost:5173/assets/121-1829.png?v=2"), "121-1829");
  const text = el(1, "text", { x: 10, y: 10, w: 100, h: 40 }, "we help you");
  const backdrop = { ...el(0, "image", { x: 0, y: 0, w: 400, h: 200 }), src: "/assets/121-1829.png" };
  assert.equal(findOverlaps([backdrop, text], keyTexts, allowedHere, 2).length, 0);
  const photo = { ...el(0, "image", { x: 0, y: 0, w: 400, h: 200 }), src: "/assets/46-400.png" }; // an image no text sits on
  assert.equal(findOverlaps([photo, text], keyTexts, allowedHere, 2).length, 1);
});
