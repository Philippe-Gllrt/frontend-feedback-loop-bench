// Side-by-side viewer: shows two versions of the page next to each other, each in a scaled
// device frame (like Responsively), for visual checks and screenshots.
//
// A version is either the Figma capture of a mockup (an image you scroll) or the built page
// of a trial (runs/<mockup>/<series>/<trial>/workspace/dist). Each trial is served at the
// root of its own port, because Vite builds use absolute paths (/assets/...).
//
// A small script is injected into every page served here: it reports the scroll position to
// the viewer and accepts scroll orders, so the two screens can scroll together. The trial's
// own files are not changed.
//
// Usage: npm run compare [-- --port 4400]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { MOCKUPS_DIR, RUNS_DIR } from "../lib/config.ts";
import { frameOffset } from "../lib/frame-crop.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf("--port");
const BASE_PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 4400;

type Frame = { breakpoint: string; width: number; height: number; image: string; offsetX: number; offsetY: number };
type Source =
  | { id: string; kind: "figma"; mockup: string; label: string; frames: Frame[] }
  | { id: string; kind: "trial"; mockup: string; series: string; trial: string; label: string; dist: string; port: number };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm",
};

const dirs = (p: string) => existsSync(p) ? readdirSync(p).filter((n) => !n.startsWith("_") && statSync(path.join(p, n)).isDirectory()) : [];

/** Every version found on disk: the Figma captures of each mockup, then every built trial. */
function discover(): Source[] {
  const sources: Source[] = [];
  for (const mockup of dirs(MOCKUPS_DIR)) {
    const designPath = path.join(MOCKUPS_DIR, mockup, "design.json");
    if (!existsSync(designPath)) continue;
    const design = JSON.parse(readFileSync(designPath, "utf8")) as { frames: { breakpoint: string; width: number; height: number }[] };
    const frames: Frame[] = [];
    for (const f of design.frames) {
      const image = path.join(MOCKUPS_DIR, mockup, `${f.breakpoint}.png`);
      if (!existsSync(image)) continue;
      // The capture can be wider than the frame (content sticking out): find where the frame starts.
      const { x, y } = frameOffset(PNG.sync.read(readFileSync(image)), f.width, f.height);
      frames.push({ breakpoint: f.breakpoint, width: f.width, height: f.height, image, offsetX: x, offsetY: y });
    }
    if (frames.length) sources.push({ id: `figma:${mockup}`, kind: "figma", mockup, label: `Figma — ${mockup}`, frames });
  }
  let port = BASE_PORT + 1;
  for (const mockup of dirs(RUNS_DIR)) {
    for (const series of dirs(path.join(RUNS_DIR, mockup))) {
      for (const trial of dirs(path.join(RUNS_DIR, mockup, series))) {
        const dist = path.join(RUNS_DIR, mockup, series, trial, "workspace", "dist");
        if (!existsSync(path.join(dist, "index.html"))) continue;
        sources.push({ id: `trial:${mockup}/${series}/${trial}`, kind: "trial", mockup, series, trial, label: `${series} / ${trial}`, dist, port: port++ });
      }
    }
  }
  return sources;
}

const BRIDGE = readFileSync(path.join(HERE, "bridge.js"), "utf8");
const withBridge = (html: string) => html.includes("</head>")
  ? html.replace("</head>", `<script>${BRIDGE}</script></head>`)
  : `<script>${BRIDGE}</script>${html}`;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

/** Serves a file from root, refusing paths outside it; unknown routes fall back to index.html (SPA). */
function serveStatic(root: string, req: IncomingMessage, res: ServerResponse) {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = path.join(root, path.normalize(urlPath));
  if (!file.startsWith(root)) return send(res, 403, "text/plain", "Forbidden");
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const index = path.join(file, "index.html");
    file = existsSync(index) ? index : path.join(root, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return send(res, 200, MIME[".html"], withBridge(readFileSync(file, "utf8")));
  send(res, 200, MIME[ext] ?? "application/octet-stream", readFileSync(file));
}

/** A page that shows a Figma capture at the frame's width, shifted so the frame starts at 0. */
function figmaPage(src: Extract<Source, { kind: "figma" }>, frame: Frame): string {
  return withBridge(`<!doctype html><html><head><meta charset="utf-8"><title>${src.label} (${frame.breakpoint})</title>
<style>html,body{margin:0;background:#fff}body{width:${frame.width}px;overflow-x:hidden}
.f{width:${frame.width}px;height:${frame.height}px;overflow:hidden;position:relative}
.f img{position:absolute;left:${-frame.offsetX}px;top:${-frame.offsetY}px;display:block}</style></head>
<body><div class="f"><img src="/figma-image/${encodeURIComponent(src.mockup)}/${frame.breakpoint}.png" alt=""></div></body></html>`);
}

const sources = discover();
const figmas = new Map(sources.filter((s) => s.kind === "figma").map((s) => [s.mockup, s]));

const main = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/" || url.pathname === "/index.html")
    return send(res, 200, MIME[".html"], readFileSync(path.join(HERE, "index.html"), "utf8"));
  if (url.pathname === "/api/sources") {
    const list = sources.map((s) => s.kind === "figma"
      ? { id: s.id, kind: s.kind, mockup: s.mockup, label: s.label, frames: s.frames.map(({ breakpoint, width, height }) => ({ breakpoint, width, height })) }
      : { id: s.id, kind: s.kind, mockup: s.mockup, series: s.series, trial: s.trial, label: s.label, port: s.port });
    return send(res, 200, MIME[".json"], JSON.stringify(list));
  }
  let m = url.pathname.match(/^\/figma\/([^/]+)\/([^/]+)$/);
  if (m) {
    const src = figmas.get(decodeURIComponent(m[1]));
    const frame = src?.kind === "figma" ? src.frames.find((f) => f.breakpoint === m![2]) : undefined;
    if (!src || src.kind !== "figma" || !frame) return send(res, 404, "text/plain", "Not found");
    return send(res, 200, MIME[".html"], figmaPage(src, frame));
  }
  m = url.pathname.match(/^\/figma-image\/([^/]+)\/([^/]+)\.png$/);
  if (m) {
    const src = figmas.get(decodeURIComponent(m[1]));
    const frame = src?.kind === "figma" ? src.frames.find((f) => f.breakpoint === m![2]) : undefined;
    if (!frame) return send(res, 404, "text/plain", "Not found");
    return send(res, 200, MIME[".png"], readFileSync(frame.image));
  }
  send(res, 404, "text/plain", "Not found");
});

main.listen(BASE_PORT, "127.0.0.1", () => {
  for (const s of sources) {
    if (s.kind !== "trial") continue;
    createServer((req, res) => serveStatic(s.dist, req, res)).listen(s.port, "127.0.0.1");
  }
  const trials = sources.filter((s) => s.kind === "trial").length;
  console.log(`Side-by-side viewer: http://localhost:${BASE_PORT}/  (${figmas.size} mockup(s), ${trials} trial(s), ports ${BASE_PORT + 1}-${BASE_PORT + trials})`);
});
