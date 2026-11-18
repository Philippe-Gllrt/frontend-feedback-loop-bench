// Pure comparison of line breaks (D104): are the words of each line those of the mockup?
// A client sees at once a heading that breaks at another word; the bench counts it.

import { normaliseQuotes } from "./score.ts";

/** Result for one text: how many lines each side draws, and how many words sit on another line. */
export type LineBreaks = { expectedLines: number; actualLines: number; movedWords: number };

/** Normalises a word for the comparison: lower case, so CSS text-transform and typed case do not matter; straight quotes, so ’ and ' are the same. */
const norm = (w: string) => normaliseQuotes(w).toLowerCase();

/**
 * Compares the lines of the reference with the lines drawn in the page.
 * Returns null when the two texts do not have the same words (then a line comparison has no
 * meaning: the text itself differs, or a word is split across elements).
 * `movedWords`: words whose line number differs from the reference. 0 = same breaks.
 */
export function compareLines(expected: string[][], actual: string[][]): LineBreaks | null {
  const lineOf = (lines: string[][]) => lines.flatMap((l, i) => l.map((w) => ({ w: norm(w), i })));
  const e = lineOf(expected), a = lineOf(actual);
  if (!e.length || e.length !== a.length || e.some((x, k) => x.w !== a[k].w)) return null;
  return { expectedLines: expected.length, actualLines: actual.length, movedWords: e.filter((x, k) => x.i !== a[k].i).length };
}

/** A text breaks wrongly if a word sits on another line, or the number of lines differs. */
export const isMisbroken = (r: LineBreaks | null) => !!r && (r.movedWords > 0 || r.expectedLines !== r.actualLines);
