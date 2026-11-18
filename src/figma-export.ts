// Exports a Figma mockup ONCE into mockups/<name>/, so that every trial reads
// exactly the same input and no Figma quota is spent during the trials.
//
// Usage:
//   FIGMA_TOKEN=<personal access token> npm run export -- \
//     --file <fileKey> --desktop <nodeId> --mobile <nodeId> --name <mockup-name>
//
//   fileKey  the part after /design/ (or /file/) in the Figma URL.
//   nodeId   the id of the frame, e.g. "12:34" (in the URL it appears as node-id=12-34;
//            both spellings are accepted).
//
// Output (mockups/<name>/):
//   design.json   frames, sections and key blocks with their boxes and styles (see src/lib/types.ts)
//   desktop.png   reference capture of the desktop frame (scale 1 = CSS pixels)
//   mobile.png    reference capture of the mobile frame
//   assets/       every image block rendered as PNG (scale 2) and every icon as SVG
//
// Why the REST API and not the Figma MCP server: the MCP server is rate-limited
// (6 tool calls per month on a Starter plan, per Figma's documentation, 2026-11-04),
// and its answers may differ between calls. The REST API is called once, here.
//
// Key blocks are picked by this script, not by hand: every visible text, every node
// painted with an image, and every icon (a group made only of vector shapes).
// Check the result by eye on a new mockup: the automatic pick can keep blocks of no
// interest (decorative shapes) or miss some (a button drawn as a plain rectangle).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MOCKUPS_DIR, parseArgs } from "./lib/config.ts";
import { figmaRgbToHex } from "./lib/color.ts";
import type { Block, Box, Design, Frame, Section, Style } from "./lib/types.ts";

const API = "https://api.figma.com/v1";

/** The subset of a Figma REST node this script reads. */
type FigmaPaint = { type: string; visible?: boolean; opacity?: number; color?: { r: number; g: number; b: number; a: number } };
type FigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: FigmaPaint[];
  characters?: string;
  style?: {
    fontFamily?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    lineHeightUnit?: string;
    textCase?: string;
  };
};

/** Node types that are pure vector shapes: a group made only of these is an icon. */
const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "LINE", "STAR", "REGULAR_POLYGON", "ELLIPSE"]);
/** Above this size (px, on both sides) a vector-only group is an illustration, not an icon. Still exported as an image block. */
const MAX_ICON_SIZE = 128;

/** Calls the Figma REST API with the token and returns the parsed JSON. */
async function figmaGet<T>(pathAndQuery: string, token: string): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { "X-Figma-Token": token } });
  if (!res.ok) throw new Error(`Figma API ${res.status} on ${pathAndQuery}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Downloads a URL (Figma's temporary image links) to a local file. */
async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

/** "12-34" (URL form) -> "12:34" (API form). */
const normaliseId = (id: string) => id.replace("-", ":");
/** "12:34" -> "12-34", safe in file names on every OS. */
const fileSafe = (id: string) => id.replace(/[:;]/g, "-");

/** A node is drawn only if it and its paint are visible. */
const isVisible = (n: FigmaNode) => n.visible !== false;
const visiblePaints = (n: FigmaNode) => (n.fills ?? []).filter((p) => p.visible !== false);

/** True if the node is painted with (at least) one image fill. */
const hasImageFill = (n: FigmaNode) => visiblePaints(n).some((p) => p.type === "IMAGE");

/** True if every visible leaf under the node is a vector shape (i.e. the node is an icon or illustration). */
function isVectorOnly(n: FigmaNode): boolean {
  if (VECTOR_TYPES.has(n.type)) return true;
  const kids = (n.children ?? []).filter(isVisible);
  return kids.length > 0 && kids.every(isVectorOnly) && !visiblePaints(n).some((p) => p.type === "IMAGE");
}

/** The single opaque solid colour of a node's fills, as #rrggbb, or null (gradient, image, transparent, several fills). */
function solidColor(n: FigmaNode): string | null {
  const paints = visiblePaints(n);
  if (paints.length !== 1 || paints[0].type !== "SOLID" || !paints[0].color) return null;
  return figmaRgbToHex(paints[0].color);
}

/** Box of a node relative to its frame, rounded to 0.01 px (Figma gives floats). */
function relativeBox(n: FigmaNode, frame: FigmaNode): Box {
  const a = n.absoluteBoundingBox!, f = frame.absoluteBoundingBox!;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r(a.x - f.x), y: r(a.y - f.y), w: r(a.width), h: r(a.height) };
}

/** Text style of a TEXT node in CSS terms; `background` is the colour of the nearest painted ancestor. */
function textStyle(n: FigmaNode, background: string | null): Style {
  const s = n.style ?? {};
  return {
    fontFamily: s.fontFamily ?? null,
    fontWeight: s.fontWeight ?? null,
    fontSize: s.fontSize ?? null,
    // "INTRINSIC_%" is Figma's "auto" line height: there is no fixed value to compare.
    lineHeight: s.lineHeightUnit === "INTRINSIC_%" ? null : s.lineHeightPx ?? null,
    color: solidColor(n),
    background,
  };
}

/**
 * Walks a section's subtree and collects its key blocks.
 * `background` carries the solid colour of the nearest painted ancestor down the tree,
 * so a text knows which background it sits on.
 */
function collectBlocks(n: FigmaNode, frame: FigmaNode, sectionId: string, background: string | null, out: Block[]): void {
  if (!isVisible(n) || !n.absoluteBoundingBox) return;
  const base = { id: n.id, name: n.name, frameId: frame.id, sectionId, box: relativeBox(n, frame) };

  if (n.type === "TEXT" && n.characters?.trim()) {
    out.push({ ...base, kind: "text", text: n.characters, textCase: n.style?.textCase, style: textStyle(n, background) });
    return;
  }
  if (hasImageFill(n)) {
    out.push({ ...base, kind: "image", asset: `assets/${fileSafe(n.id)}.png` });
    return; // children of an image (overlays) are rare; the whole node is one block.
  }
  if (isVectorOnly(n)) {
    const small = base.box.w <= MAX_ICON_SIZE && base.box.h <= MAX_ICON_SIZE;
    out.push({ ...base, kind: "image", asset: `assets/${fileSafe(n.id)}.${small ? "svg" : "png"}` });
    return;
  }
  const here = solidColor(n) ?? background;
  for (const child of n.children ?? []) collectBlocks(child, frame, sectionId, here, out);
}

/** Asks Figma to render nodes and downloads the files. Batched, because the URL length is limited. */
async function renderNodes(fileKey: string, token: string, items: Array<{ id: string; file: string }>, format: "png" | "svg", scale: number): Promise<void> {
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    const ids = batch.map((b) => b.id).join(",");
    const { images } = await figmaGet<{ images: Record<string, string | null> }>(
      `/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${format}&scale=${scale}`, token);
    for (const b of batch) {
      const url = images[b.id];
      if (!url) { console.warn(`  ! Figma could not render ${b.id}`); continue; }
      await download(url, b.file);
    }
  }
}

/** Entry point: reads the options, calls Figma, writes mockups/<name>/. */
async function main(): Promise<void> {
  const args = parseArgs();
  const token = process.env.FIGMA_TOKEN;
  if (!token || !args.file || !args.desktop || !args.mobile || !args.name) {
    console.error("Usage: FIGMA_TOKEN=... npm run export -- --file <fileKey> --desktop <nodeId> --mobile <nodeId> --name <name>");
    process.exit(1);
  }
  const ids = { desktop: normaliseId(args.desktop), mobile: normaliseId(args.mobile) };
  const outDir = path.join(MOCKUPS_DIR, args.name);
  await mkdir(path.join(outDir, "assets"), { recursive: true });

  console.log(`Reading frames ${ids.desktop} and ${ids.mobile} from file ${args.file}...`);
  const { nodes } = await figmaGet<{ nodes: Record<string, { document: FigmaNode } | null> }>(
    `/files/${args.file}/nodes?ids=${encodeURIComponent(`${ids.desktop},${ids.mobile}`)}`, token);

  const design: Design = { source: { fileKey: args.file, exportedAt: new Date().toISOString() }, frames: [], sections: [], blocks: [] };
  for (const breakpoint of ["desktop", "mobile"] as const) {
    const frame = nodes[ids[breakpoint]]?.document;
    if (!frame?.absoluteBoundingBox) throw new Error(`Frame ${ids[breakpoint]} not found in the file.`);
    const f: Frame = { id: frame.id, name: frame.name, breakpoint, width: frame.absoluteBoundingBox.width, height: frame.absoluteBoundingBox.height };
    design.frames.push(f);
    // Sections are the direct visible children of the frame: that is how mockups are usually
    // laid out (header, hero, features, footer...). The agent reports conformity per section.
    // They are sorted from top to bottom (y): Figma lists children in layer order, which can
    // differ from the visual order, and the n-th desktop section is paired with the n-th
    // mobile section. Pairing by order keeps the export automatic; a pairing written by hand
    // in design.json would be lost at the next export.
    const children = (frame.children ?? []).filter((c) => isVisible(c) && c.absoluteBoundingBox)
      .sort((a, b) => a.absoluteBoundingBox!.y - b.absoluteBoundingBox!.y);
    for (const child of children) {
      const s: Section = { id: child.id, name: child.name, frameId: frame.id, box: relativeBox(child, frame) };
      design.sections.push(s);
      collectBlocks(child, frame, s.id, solidColor(frame), design.blocks);
    }
  }
  // Pairing by order only works if both frames have the same sections: stop rather than pair wrongly.
  const count = (b: Frame["breakpoint"]) => design.sections.filter((s) => s.frameId === design.frames.find((f) => f.breakpoint === b)!.id).length;
  if (count("desktop") !== count("mobile")) {
    throw new Error(`The desktop frame has ${count("desktop")} sections and the mobile frame ${count("mobile")}. `
      + "Sections are paired by order (top to bottom), so both frames need the same number. Fix the mockup in Figma, then export again.");
  }

  console.log(`Found ${design.sections.length} sections and ${design.blocks.length} key blocks. Rendering captures and assets...`);
  await renderNodes(args.file, token, design.frames.map((f) => ({ id: f.id, file: path.join(outDir, `${f.breakpoint}.png`) })), "png", 1);
  const assets = design.blocks.filter((b) => b.asset);
  await renderNodes(args.file, token, assets.filter((b) => b.asset!.endsWith(".png")).map((b) => ({ id: b.id, file: path.join(outDir, b.asset!) })), "png", 2);
  await renderNodes(args.file, token, assets.filter((b) => b.asset!.endsWith(".svg")).map((b) => ({ id: b.id, file: path.join(outDir, b.asset!) })), "svg", 1);

  await writeFile(path.join(outDir, "design.json"), JSON.stringify(design, null, 2));
  console.log(`Done: ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
