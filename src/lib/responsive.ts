// Pure logic of the responsive check: the page is also rendered at widths the mockup does
// not have (responsiveWidths in config/bench.json, e.g. 1280 and 768 px), where there is no
// reference to compare with. Two signs of a layout that does not adapt are measured there:
// - horizontal overflow: the page is wider than the viewport (a horizontal scroll bar);
// - overlaps: two blocks drawn on top of each other while the mockup never puts them so.
// A third number, the count of `position: absolute` elements, is read in the page by
// measure.ts: absolute positioning is the shortcut that matches a mockup to the pixel at
// two widths and breaks everywhere in between.
//
// No browser and no file access here, so everything can be unit-tested (responsive.test.ts).
import { normaliseText } from "./score.ts";
import type { PageElement } from "./page-extract.ts";
import type { Block, Box } from "./types.ts";

/** Two page elements drawn on top of each other. Texts are given for reading; an image has no text. */
export type Overlap = { a: string; b: string; kinds: string; intersection: { w: number; h: number } };

/** Width and height of the intersection of two boxes (0 if they do not meet). */
export function intersection(a: Box, b: Box): { w: number; h: number } {
  return {
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)),
  };
}

/** True if two boxes overlap by more than `minPx` on both axes (touching lines of text do not count). */
const meet = (a: Box, b: Box, minPx: number) => { const i = intersection(a, b); return i.w > minPx && i.h > minPx; };

/** Order-independent key of a pair of texts. */
const pairKey = (a: string, b: string) => [a, b].sort().join("\u0000");

/**
 * The overlaps the mockup itself contains, in any of its frames, so they are not counted
 * as defects: pairs of texts drawn over each other, and texts drawn over an image (a
 * heading on a photo). Texts are identified by their content, the only thing that stays
 * the same from one width to another.
 */
export function mockupOverlaps(blocks: Block[], minPx: number): { textPairs: Set<string>; textsOnImage: Set<string>; backdrops: Set<string> } {
  const textPairs = new Set<string>(), textsOnImage = new Set<string>(), backdrops = new Set<string>();
  for (const a of blocks) {
    if (a.kind !== "text") continue;
    for (const b of blocks) {
      if (a === b || a.frameId !== b.frameId || !meet(a.box, b.box, minPx)) continue;
      if (b.kind === "text") textPairs.add(pairKey(normaliseText(a.text ?? ""), normaliseText(b.text ?? "")));
      else { textsOnImage.add(normaliseText(a.text ?? "")); if (b.asset) backdrops.add(assetStem(b.asset)); }
    }
  }
  return { textPairs, textsOnImage, backdrops };
}

/**
 * Name of an image file without folder, query or extension ("assets/121-1829.png" -> "121-1829"): how a
 * page image is recognised as a mockup image, since the agents keep the exported file names.
 */
export function assetStem(src: string): string {
  return (src.split(/[?#]/)[0].split("/").pop() ?? "").replace(/\.[a-z0-9]+$/i, "").toLowerCase();
}

/** The part of an element that can be seen (17/11): its box, cut by the ancestors that clip it. */
const seen = (e: PageElement) => e.visibleBox ?? e.box;

/** True if one element is the other, or contains it in the DOM: a heading inside its card is not an overlap. */
const nested = (a: PageElement, b: PageElement) =>
  a.nodeId === b.nodeId || (a.ancestors ?? []).includes(b.nodeId!) || (b.ancestors ?? []).includes(a.nodeId!);

/**
 * Overlaps between page elements that the mockup does not have.
 * Only the mockup's texts are looked at (`keyTexts`, normalised), each through its innermost
 * element: the page extraction also lists every container that holds text, and a card
 * would otherwise count again each overlap of the heading it contains. Images are all kept.
 * Counted: text over text, and text over image, when the two elements are not nested and
 * meet by more than `minPx` on both axes, in the part of each that can be seen (an image cut by its
 * section only overlaps with what shows). Not counted: image over image (decorative layers
 * are common and harmless), the overlaps found in the mockup (see mockupOverlaps), and texts over
 * a backdrop, an image the mockup itself puts texts on.
 */
export function findOverlaps(all: PageElement[], keyTexts: Set<string>, allowed: ReturnType<typeof mockupOverlaps>, minPx: number): Overlap[] {
  const keyed = all.filter((e) => e.kind === "image" || keyTexts.has(e.text ?? ""));
  const elements = keyed.filter((e) => e.kind === "image"
    || !keyed.some((f) => f !== e && f.kind === "text" && f.text === e.text && (f.ancestors ?? []).includes(e.nodeId!)));
  const out: Overlap[] = [];
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i], b = elements[j];
      if (a.kind === "image" && b.kind === "image") continue;
      if (nested(a, b) || !meet(seen(a), seen(b), minPx)) continue;
      if (a.kind === "text" && b.kind === "text") {
        if (allowed.textPairs.has(pairKey(a.text!, b.text!))) continue;
      } else {
        const text = a.kind === "text" ? a.text! : b.text!;
        if (allowed.textsOnImage.has(text)) continue;
        // A backdrop (17/11): an image the mockup itself puts texts on (a background pattern) can hold
        // any text at another width; only its box is known, not where its pixels are transparent.
        const image = a.kind === "image" ? a : b;
        if (image.src && allowed.backdrops.has(assetStem(image.src))) continue;
      }
      const i2 = intersection(seen(a), seen(b));
      out.push({ a: a.text ?? "(image)", b: b.text ?? "(image)", kinds: `${a.kind}/${b.kind}`, intersection: { w: Math.round(i2.w), h: Math.round(i2.h) } });
    }
  }
  return out;
}
