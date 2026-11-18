// Shared data shapes of the bench.
//
// `Design` is what `figma-export.ts` writes to mockups/<name>/design.json and
// what both the agent (through ./mockup/design.json) and `measure.ts` read.
// All boxes are in CSS pixels, relative to the top-left corner of their frame,
// so they can be compared directly with getBoundingClientRect() at the frame width.

/** A rectangle in CSS pixels, relative to its frame's top-left corner. */
export type Box = { x: number; y: number; w: number; h: number };

/** Text and background style values read from Figma, in CSS terms. */
export type Style = {
  fontFamily: string | null;
  fontWeight: number | null;
  fontSize: number | null;
  /** Line height in px; null when Figma says "auto" (no fixed value to compare). */
  lineHeight: number | null;
  /** Text colour as #rrggbb, or null if the fill is not a single solid colour. */
  color: string | null;
  /** Solid background colour of the nearest painted ancestor, as #rrggbb, or null. */
  background: string | null;
};

/** One top-level frame of the mockup: one per breakpoint (desktop, mobile). */
export type Frame = { id: string; name: string; breakpoint: "desktop" | "mobile"; width: number; height: number };

/** A section = a direct child of a frame. The agent reports conformity per section. */
export type Section = { id: string; name: string; frameId: string; box: Box };

/**
 * A key block, picked automatically by the export (texts, images, icons).
 * - text:  a TEXT node; matched in the page by its text content.
 * - image: a node painted with an image fill, or a vector-only group (icon);
 *          matched in the page by position among <img>, <svg>, <picture>, <video>
 *          and elements with a background-image.
 */
export type Block = {
  id: string;
  name: string;
  kind: "text" | "image";
  frameId: string;
  sectionId: string;
  box: Box;
  /** Only for text blocks: the characters, as typed in Figma. */
  text?: string;
  /** Only for text blocks: Figma's textCase, applied by CSS in the page (UPPER, LOWER, TITLE). */
  textCase?: string;
  /** Only for text blocks. */
  style?: Style;
  /** Only for image blocks: the exported file in ./mockup/assets/, if any. */
  asset?: string;
};

export type Design = {
  source: { fileKey: string; exportedAt: string };
  frames: Frame[];
  sections: Section[];
  blocks: Block[];
};

/** The final report the skill asks the agent to write in ./report.json. */
export type AgentReport = {
  sections: Array<{
    sectionId: string;
    status: "conforming" | "non-conforming";
    /** `visible`: the agent's own judgement of whether a human eye would see the gap. */
    issues: Array<{ blockId?: string; description: string; visible?: boolean }>;
  }>;
};

/**
 * Where a mockup text should be drawn, computed by `npm run text-reference` (D104) and
 * written to mockups/<name>/text-reference.json. Used by the measurement only: it is
 * never copied into the agent's workspace.
 *
 * Figma gives the frame of a text layer (often a fixed width, wider than the words) and,
 * with absoluteRenderBounds, the ink of its glyphs. Chrome measures text by the advance of
 * its letters, not by its ink, so neither Figma box compares directly with the page. The
 * reference is therefore computed in Chromium: the Figma text is laid out with Figma's
 * width and style, and measured with the same code as the page (page-extract.ts). Figma's
 * ink width is kept to check the reference.
 */
export type TextReference = {
  /** Text box offset and width, relative to the Figma frame box x (advance of the letters, like the page measure). */
  textBox: { dx: number; w: number };
  /** Words of each line, as Chromium breaks the text at Figma's width. */
  lines: string[][];
  /** Width of the ink in Figma (absoluteRenderBounds) and in the Chromium layout (canvas measureText), for the check. */
  inkFigma: number | null;
  inkProbe: number;
  /** Why the reference is not exact, if it is not (mixed styles, truncation...). */
  approximate?: string;
};

export type TextReferenceFile = {
  computedAt: string;
  fonts: Record<string, boolean>;
  /** Block id -> reference; a block is absent when its font could not be loaded. */
  blocks: Record<string, TextReference>;
};
