// Computes where each mockup text should be drawn and where its lines should break (D104),
// and writes mockups/<name>/text-reference.json. Run once per mockup, after `npm run export`.
// The file is for the measurement only: the launcher never copies it into the agent's workspace.
//
// Usage:
//   npm run text-reference -- --mockup <name>
//   (needs FIGMA_TOKEN, in the environment or in a .env file at the bench root)
//
// Why it is needed. Figma gives two boxes for a text, and neither compares with the page:
//   - absoluteBoundingBox, the frame of the text layer, often a fixed width much wider than
//     the words ("Featured Properties": a 1200 px frame for 413 px of text);
//   - absoluteRenderBounds, the ink of the glyphs, while Chrome measures text by the advance
//     of its letters (the ink starts about 3 px later on a 48 px heading).
// And Figma's REST API does not give the line breaks of a wrapped text (its lineTypes are
// paragraphs, per the API documentation read on 2026-11-09).
// So the reference is computed in Chromium: each Figma text is laid out at its Figma frame
// width with its Figma style, then read with the page measurement's own code (page-extract.ts):
// the text box (advance of the letters) and the words of each line. Same engine, same code as
// the measurement of the trials.
//
// The check: the ink width of the Chromium layout (canvas measureText, line by line) is
// compared with Figma's ink width. A difference above the noise floor means the layout is not
// Figma's (font, letter spacing, mixed styles): those texts are listed at the end, to read
// against the mockup capture before trusting their line breaks.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { MOCKUPS_DIR, loadBenchConfig, parseArgs } from "./lib/config.ts";
import { extractPage } from "./lib/page-extract.ts";
import type { Design, TextReference, TextReferenceFile } from "./lib/types.ts";

/** The subset of a Figma REST TEXT node this script reads. */
type FigmaBox = { x: number; y: number; width: number; height: number };
type FigmaText = {
  id: string;
  type: string;
  characters?: string;
  absoluteBoundingBox?: FigmaBox | null;
  absoluteRenderBounds?: FigmaBox | null;
  characterStyleOverrides?: number[];
  style?: {
    fontFamily?: string; fontWeight?: number; fontSize?: number; lineHeightPx?: number; letterSpacing?: number;
    textCase?: string; textAlignHorizontal?: string; textAutoResize?: string; textTruncation?: string; italic?: boolean;
  };
  children?: FigmaText[];
};

/** One text to lay out in the probe page. */
type ProbeText = {
  id: string; text: string; width: number | null; family: string; weight: number; size: number; lineHeight: number | null;
  letterSpacing: number; align: string; textCase: string; italic: boolean;
};

const CSS_ALIGN: Record<string, string> = { LEFT: "left", RIGHT: "right", CENTER: "center", JUSTIFIED: "justify" };
const CSS_CASE: Record<string, string> = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };

/** Escapes text for HTML. */
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The probe page: one div per text, at its Figma width (or unbounded if Figma sizes the layer to its text). */
function probePage(texts: ProbeText[], fonts: Map<string, Set<number>>): string {
  const families = [...fonts].map(([f, w]) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:ital,wght@${[0, 1].flatMap((i) => [...w].sort().map((x) => `${i},${x}`)).join(";")}`).join("&");
  const divs = texts.map((t) => {
    const css = [
      `font-family:'${t.family}'`, `font-weight:${t.weight}`, `font-size:${t.size}px`, t.lineHeight ? `line-height:${t.lineHeight}px` : "",
      `letter-spacing:${t.letterSpacing}px`, `text-align:${CSS_ALIGN[t.align] ?? "left"}`, t.italic ? "font-style:italic" : "",
      CSS_CASE[t.textCase] ? `text-transform:${CSS_CASE[t.textCase]}` : "", t.textCase.startsWith("SMALL_CAPS") ? "font-variant-caps:small-caps" : "",
      // A fixed-width Figma layer wraps; a layer sized to its text (WIDTH_AND_HEIGHT) breaks only at typed line breaks.
      t.width !== null ? `width:${t.width}px;white-space:pre-wrap` : "width:max-content;white-space:pre",
    ].filter(Boolean).join(";");
    return `<div style="${css};margin:0 0 40px 0;padding:0">${html(t.text)}</div>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families}&display=block">`
    + `<style>body{margin:0;padding:0}</style></head><body>${divs.join("")}</body></html>`;
}

/** Entry point: reads the export, asks Figma for the text layers, lays them out in Chromium, writes the reference. */
async function main(): Promise<void> {
  const args = parseArgs();
  const token = process.env.FIGMA_TOKEN;
  if (!args.mockup || !token) { console.error("Usage: FIGMA_TOKEN=... npm run text-reference -- --mockup <name>"); process.exit(1); }
  const dir = path.join(MOCKUPS_DIR, args.mockup);
  const design = JSON.parse(await readFile(path.join(dir, "design.json"), "utf8")) as Design;
  const noise = loadBenchConfig().noiseFloorPx;

  // One call to Figma, for both frames: the text layers with their full style and ink.
  const ids = design.frames.map((f) => f.id).join(",");
  const res = await fetch(`https://api.figma.com/v1/files/${design.source.fileKey}/nodes?ids=${encodeURIComponent(ids)}`, { headers: { "X-Figma-Token": token } });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  const { nodes } = (await res.json()) as { nodes: Record<string, { document: FigmaText & { absoluteBoundingBox: FigmaBox } }> };
  const figma = new Map<string, FigmaText & { frame: FigmaBox }>();
  for (const id of design.frames.map((f) => f.id)) {
    const frame = nodes[id].document;
    const walk = (n: FigmaText) => { if (n.type === "TEXT") figma.set(n.id, { ...n, frame: frame.absoluteBoundingBox }); (n.children ?? []).forEach(walk); };
    walk(frame);
  }

  const texts: ProbeText[] = [];
  const fonts = new Map<string, Set<number>>();
  const approximate = new Map<string, string>();
  for (const b of design.blocks.filter((x) => x.kind === "text")) {
    const n = figma.get(b.id);
    const s = n?.style;
    if (!n || !s?.fontFamily || !s.fontSize) { console.warn(`  ! ${b.id}: not found in Figma, or no font: no reference`); continue; }
    const reasons = [];
    if ((n.characterStyleOverrides ?? []).some((o) => o !== 0)) reasons.push("mixed styles in the text (the base style is used)");
    if (s.textTruncation === "ENDING") reasons.push("truncated with an ellipsis in Figma");
    if (reasons.length) approximate.set(b.id, reasons.join("; "));
    const weight = s.fontWeight ?? 400;
    fonts.set(s.fontFamily, (fonts.get(s.fontFamily) ?? new Set()).add(weight));
    texts.push({
      id: b.id, text: n.characters ?? b.text ?? "", width: s.textAutoResize === "WIDTH_AND_HEIGHT" ? null : b.box.w,
      family: s.fontFamily, weight, size: s.fontSize, lineHeight: s.lineHeightPx ?? null, letterSpacing: s.letterSpacing ?? 0,
      align: s.textAlignHorizontal ?? "LEFT", textCase: s.textCase ?? "ORIGINAL", italic: !!s.italic,
    });
  }

  const browser = await chromium.launch();
  const out: TextReferenceFile = { computedAt: new Date().toISOString(), fonts: {}, blocks: {} };
  try {
    const page = await browser.newPage({ viewport: { width: 2400, height: 1000 }, deviceScaleFactor: 1 });
    await page.setContent(probePage(texts, fonts), { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    for (const [family, weights] of fonts) {
      for (const w of weights) {
        const key = `${family} ${w}`;
        out.fonts[key] = await page.evaluate(async (f) => { await document.fonts.load(f); return document.fonts.check(f); }, `${w} 16px '${family}'`);
      }
    }
    // The divs are the only elements with text, in the same order as `texts` (depth 0 = no child element).
    const elements = (await page.evaluate(extractPage)).filter((e) => e.kind === "text" && e.depth === 0);
    if (elements.length !== texts.length) throw new Error(`Probe page: ${elements.length} texts read for ${texts.length} laid out.`);
    // Ink width of each laid-out line, with the canvas (same font, letter spacing and case as the div).
    const inks = await page.evaluate((list) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      return list.map(({ t, lines }) => {
        ctx.font = `${t.italic ? "italic " : ""}${t.weight} ${t.size}px '${t.family}'`;
        (ctx as unknown as { letterSpacing: string }).letterSpacing = `${t.letterSpacing}px`;
        const tc = (w: string) => t.textCase === "UPPER" ? w.toUpperCase() : t.textCase === "LOWER" ? w.toLowerCase() : w;
        return Math.max(0, ...lines.map((l) => { const m = ctx.measureText(tc(l.join(" "))); return m.actualBoundingBoxLeft + m.actualBoundingBoxRight; }));
      });
    }, texts.map((t, i) => ({ t, lines: elements[i].lines ?? [] })));

    texts.forEach((t, i) => {
      const fontOk = out.fonts[`${t.family} ${t.weight}`];
      if (!fontOk) { console.warn(`  ! ${t.id}: font ${t.family} ${t.weight} not loaded: no reference`); return; }
      const e = elements[i], n = figma.get(t.id)!;
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const ref: TextReference = {
        textBox: { dx: r2(e.box.x), w: r2(e.box.w) },
        lines: e.lines ?? [],
        inkFigma: n.absoluteRenderBounds ? r2(n.absoluteRenderBounds.width) : null,
        inkProbe: r2(inks[i]),
      };
      if (approximate.has(t.id)) ref.approximate = approximate.get(t.id);
      out.blocks[t.id] = ref;
    });
  } finally {
    await browser.close();
  }

  await writeFile(path.join(dir, "text-reference.json"), JSON.stringify(out, null, 2));
  const refs = Object.entries(out.blocks);
  const doubtful = refs.filter(([, r]) => r.inkFigma !== null && Math.abs(r.inkProbe - r.inkFigma) > noise);
  console.log(`Written ${path.join(dir, "text-reference.json")}: ${refs.length} texts, fonts ${JSON.stringify(out.fonts)}.`);
  console.log(`${doubtful.length} texts whose Chromium ink width differs from Figma's by more than ${noise} px (read them against the mockup capture):`);
  for (const [id, r] of doubtful) {
    const b = design.blocks.find((x) => x.id === id)!;
    console.log(`  ${id} (${design.frames.find((f) => f.id === b.frameId)?.breakpoint}) Figma ${r.inkFigma} px, Chromium ${r.inkProbe} px, ${r.lines.length} lines${r.approximate ? `, ${r.approximate}` : ""}: "${(b.text ?? "").slice(0, 50).replace(/\s+/g, " ")}"`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
