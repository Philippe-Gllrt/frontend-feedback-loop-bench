// Crops Figma's capture of a frame back to the frame itself.
//
// Figma exports a frame at the bounds of everything it draws: content that sticks out of the
// frame (an outer stroke, a band wider than the page) widens the image, and the frame then sits
// at an offset inside it. On Estatein, the desktop capture is 1942 px wide for a 1920 px frame:
// the services band sticks out 11 px on each side, so the whole page is shifted 11 px to the
// right (found 16/11/2026). The page capture starts at (0, 0), so the two must be aligned before
// comparing them pixel by pixel.
//
// The frame is found by its opaque background: the extra columns (rows) are transparent except
// where something sticks out. The offset is the first column (row) that is opaque on most of
// the image. With no excess, the image is returned as is.
import { PNG } from "pngjs";

/** Offset of the frame inside a capture of size >= the frame: first line opaque on more than half the image. */
export function frameOffset(img: PNG, frameWidth: number, frameHeight: number): { x: number; y: number } {
  const opaque = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3] > 128;
  const find = (excess: number, lineLength: number, isOpaque: (line: number, i: number) => boolean) => {
    if (excess <= 0) return 0;
    const step = Math.max(1, Math.floor(lineLength / 400)); // a sample of ~400 pixels per line is enough
    for (let line = 0; line <= excess; line++) {
      let n = 0, total = 0;
      for (let i = 0; i < lineLength; i += step) { total++; if (isOpaque(line, i)) n++; }
      if (n > total / 2) return line;
    }
    return Math.round(excess / 2); // no opaque line found: assume the overflow is even on both sides
  };
  const x = find(img.width - frameWidth, img.height, (col, row) => opaque(col, row));
  const y = find(img.height - frameHeight, img.width, (row, col) => opaque(col, row));
  return { x, y };
}

/** The part of the capture that is the frame, at the frame's size (or the capture itself if it is not larger). */
export function cropToFrame(img: PNG, frameWidth: number, frameHeight: number): PNG {
  const w = Math.round(frameWidth), h = Math.round(frameHeight);
  if (img.width <= w && img.height <= h) return img;
  const { x, y } = frameOffset(img, w, h);
  const out = new PNG({ width: Math.min(w, img.width), height: Math.min(h, img.height) });
  PNG.bitblt(img, out, x, y, out.width, out.height, 0, 0);
  return out;
}
