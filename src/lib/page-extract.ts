// Code that runs INSIDE the rendered page (through Playwright's page.evaluate)
// and returns what the measurement needs: the boxes and computed styles of every
// text element and every image-like element.
//
// Kept in its own file because it must be self-contained: Playwright serialises the
// function and runs it in the browser, so it cannot use imports or outer variables.

/** One element of the page, as seen by the measurement. Coordinates are document coordinates in CSS px. */
export type PageElement = {
  index: number;
  kind: "text" | "image";
  /** Normalised text content (whitespace collapsed, lower case); only for text elements. */
  text?: string;
  /** Number of descendant elements: used to prefer the innermost element when several share the same text. */
  depth?: number;
  /** Id of the DOM element (an element with a background image and text gives two entries with the same id). */
  nodeId?: number;
  /** nodeIds of the DOM ancestors that are also in the list: tells nested elements apart from overlapping ones. */
  ancestors?: number[];
  box: { x: number; y: number; w: number; h: number };
  /**
   * The part of the box that can be seen, when an ancestor cuts it (overflow other than visible):
   * set only when it differs from `box`; w and h are 0 when nothing shows. Used by the overlap check
   * (17/11): a decorative image that spills out of its section, cut by it, overlaps nothing.
   */
  visibleBox?: { x: number; y: number; w: number; h: number };
  /**
   * Only for an element whose background image is drawn once (no-repeat): where the image itself is
   * drawn, from background-size, background-position and the image's own size (18/11). It differs
   * from `box` when the image is larger than its element or offset in it: a decoration that spills
   * out of its section in Figma (a 1924 px wide pattern behind a 920 px hero) is drawn that way in
   * CSS, and Figma's box is the whole image, not the element. Set only when it differs from `box`.
   */
  imageBox?: { x: number; y: number; w: number; h: number };
  /** Only for texts: an SVG <text> laid out along a path (<textPath>), e.g. a circular badge (18/11). */
  onPath?: boolean;
  /** Only for images: the file drawn (img src, or the url of a background-image), to recognise a mockup asset. */
  src?: string;
  /** Words of each drawn line, as typed (not lower-cased); only for text elements of a reasonable length. */
  lines?: string[][];
  style?: {
    fontFamily: string;
    fontWeight: string;
    fontSize: string;
    lineHeight: string;
    color: string;
    background: string;
  };
};

/**
 * Collects the page's text and image elements. Must stay free of imports and closures.
 *
 * Text box: x and width come from the element's text content (a DOM Range), not from
 * the element, because a heading usually spans its whole container while Figma's text
 * box is often the size of the text. y and height come from the element's box (see
 * below). This is the closest DOM equivalent of a Figma text box; the remaining
 * difference (font rendering, fixed-width text boxes in Figma) is the noise floor that
 * the control condition makes visible.
 */
export async function extractPage(): Promise<PageElement[]> {
  const out: PageElement[] = [];
  const source: Element[] = []; // the DOM element of each entry of out, for the visible-box pass at the end
  const add = (el: Element, e: PageElement) => { source.push(el); out.push(e); };
  const sx = window.scrollX, sy = window.scrollY;

  /**
   * The box once cut by the ancestors that clip it (overflow other than visible). An ancestor clips
   * an element only if it is on the element's containing-block chain: an absolute element escapes
   * the non-positioned ancestors between it and its containing block, a fixed one escapes all but
   * a transformed ancestor.
   */
  const clipped = (el: Element, b: PageElement["box"]): PageElement["box"] => {
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    let pos = getComputedStyle(el).position;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      const holds = pos === "absolute" ? pcs.position !== "static" || pcs.transform !== "none" : pos === "fixed" ? pcs.transform !== "none" : true;
      if (!holds) continue;
      pos = pcs.position;
      if (p === document.body) continue; // the body's overflow goes to the viewport, which is not a clip here
      const r = p.getBoundingClientRect();
      if (pcs.overflowX !== "visible") { x0 = Math.max(x0, r.left + sx); x1 = Math.min(x1, r.right + sx); }
      if (pcs.overflowY !== "visible") { y0 = Math.max(y0, r.top + sy); y1 = Math.min(y1, r.bottom + sy); }
    }
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  };
  // Same rule as normaliseText in score.ts (typographic quotes become straight ones), repeated here
  // because this function runs in the page and cannot import.
  const norm = (s: string) => s.replace(/[‘’ʼ′]/g, "'").replace(/[“”″]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
  const visible = (r: DOMRect) => r.width > 0 && r.height > 0;

  /**
   * The text the element shows (16/11): its text nodes, without those inside a descendant that
   * is not drawn (display: none, visibility: hidden). textContent keeps them, so a sentence hidden
   * at one width (a <span> shown on desktop only) made the whole paragraph "missing".
   */
  const shownText = (el: Element): string => {
    let t = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (p && p !== el && !p.checkVisibility({ visibilityProperty: true })) continue;
      t += n.textContent ?? "";
    }
    return t;
  };

  /** Width of a text drawn in an element's font (a placeholder has no DOM Range to measure). */
  const ctx = document.createElement("canvas").getContext("2d");
  const textWidth = (s: string, cs: CSSStyleDeclaration) => { if (!ctx) return 0; ctx.font = cs.font; return ctx.measureText(s).width; };

  /** Background of the nearest ancestor (or self) that paints a non-transparent background colour. */
  const backgroundOf = (el: Element): string => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return "rgba(0, 0, 0, 0)";
  };

  // DOM elements already in the list, with their id. querySelectorAll walks the tree in
  // document order, so an element's ancestors are always seen before it.
  const ids = new Map<Element, number>();
  const idOf = (el: Element): number => { if (!ids.has(el)) ids.set(el, ids.size); return ids.get(el)!; };
  const ancestorsOf = (el: Element): number[] => {
    const found: number[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) if (ids.has(p)) found.push(ids.get(p)!);
    return found;
  };

  /**
   * Words of each line the element draws (D104). Each word is a DOM Range; its first client
   * rect gives its line: a word starts a new line when it sits lower than half the height of
   * the current line's first word (so mixed font sizes on one line stay one line).
   */
  const linesOf = (root: Element): string[][] => {
    const lines: string[][] = [];
    let top = -Infinity, height = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest("svg")) continue;
      const t = n.textContent ?? "";
      const re = /\S+/g;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const rect = range.getClientRects()[0];
        if (!rect || rect.width === 0) continue;
        if (!lines.length || rect.top > top + height / 2) { lines.push([]); top = rect.top; height = rect.height; }
        lines[lines.length - 1].push(m[0]);
      }
    }
    return lines;
  };
  /** Above this length an element is a container (a section, the page), not a text: its lines are not read. */
  const MAX_LINE_TEXT = 3000;

  const all = Array.from(document.body.querySelectorAll("*"));

  // The own size of each background image (18/11), needed to know where it is drawn: loaded once
  // here, so this function is async. An image that does not load keeps its element's box.
  const bgUrl = (cs: CSSStyleDeclaration) => cs.backgroundImage.match(/url\(["']?([^"')]+)/)?.[1];
  const natural = new Map<string, { w: number; h: number }>();
  const urls = new Set<string>();
  for (const el of all) for (const p of [null, "::before", "::after"]) { const u = bgUrl(getComputedStyle(el, p)); if (u) urls.add(u); }
  await Promise.all([...urls].map((u) => new Promise<void>((done) => {
    const img = new Image();
    img.onload = () => { natural.set(u, { w: img.naturalWidth, h: img.naturalHeight }); done(); };
    img.onerror = () => done();
    img.src = u;
  })));

  /**
   * Where the first background layer's image is drawn, in document px (CSS Backgrounds 3: the
   * positioning area is the padding box unless background-origin says otherwise; background-size
   * cover, contain, auto, px or %; background-position in px or %). Undefined when the image
   * repeats, did not load, or a value is in a form not handled here (calc, keyword with offset).
   */
  const drawnImage = (r: { left: number; top: number; width: number; height: number }, cs: CSSStyleDeclaration): PageElement["box"] | undefined => {
    const first = (v: string) => v.split(",")[0].trim();
    if (first(cs.backgroundRepeat) !== "no-repeat") return undefined;
    const u = bgUrl(cs);
    const n = u ? natural.get(u) : undefined;
    if (!n || !n.w || !n.h) return undefined;
    const px = (v: string) => parseFloat(v) || 0;
    const origin = first(cs.backgroundOrigin);
    const inset = origin === "border-box" ? [0, 0, 0, 0]
      : [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)]
        .map((b, i) => origin === "content-box" ? b + px([cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft][i]) : b);
    const ax = r.left + inset[3], ay = r.top + inset[0];
    const aw = r.width - inset[1] - inset[3], ah = r.height - inset[0] - inset[2];
    let w: number, h: number;
    const size = first(cs.backgroundSize);
    if (size === "cover" || size === "contain") {
      const k = size === "cover" ? Math.max(aw / n.w, ah / n.h) : Math.min(aw / n.w, ah / n.h);
      w = n.w * k; h = n.h * k;
    } else {
      const [sw, sh = "auto"] = size.split(/\s+/);
      const len = (v: string, ref: number) => v === "auto" ? null : /^-?[\d.]+%$/.test(v) ? parseFloat(v) / 100 * ref : /^-?[\d.]+px$/.test(v) ? parseFloat(v) : NaN;
      let W = len(sw, aw), H = len(sh, ah);
      if (Number.isNaN(W) || Number.isNaN(H)) return undefined;
      if (W === null && H === null) { W = n.w; H = n.h; }
      else if (W === null) W = (H as number) * n.w / n.h;
      else if (H === null) H = W * n.h / n.w;
      w = W; h = H as number;
    }
    const pos = (v: string, free: number) => /^-?[\d.]+%$/.test(v) ? parseFloat(v) / 100 * free : /^-?[\d.]+px$/.test(v) ? parseFloat(v) : NaN;
    const x = pos(first(cs.backgroundPositionX), aw - w), y = pos(first(cs.backgroundPositionY), ah - h);
    if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
    return { x: ax + x + sx, y: ay + y + sy, w, h };
  };

  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") continue;

    // A hairline (16/11): Figma's line of width (or height) 0 becomes, in the trials, an element of
    // width 0 that draws itself with a 0.5 px box-shadow, an outline, a border, a ::before or ::after,
    // or a 0 px wide <img>. Its box has no area, so the image test below dropped it and the block was
    // "missing". It counts as an image with its 0 px box; score.ts gives the block 1 px to match it.
    const box = el.getBoundingClientRect();
    if ((box.width === 0) !== (box.height === 0) && !el.closest("svg")) {
      const pseudo = (p: string) => { const c = getComputedStyle(el, p).content; return c !== "none" && c !== "normal"; };
      const draws = tag === "img" || cs.boxShadow !== "none" || (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0)
        || ["top", "right", "bottom", "left"].some((s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== "none")
        || pseudo("::before") || pseudo("::after");
      if (draws) { add(el, { index: out.length, kind: "image", nodeId: idOf(el), ancestors: ancestorsOf(el), box: { x: box.left + sx, y: box.top + sy, w: box.width, h: box.height } }); continue; }
    }

    // A background image on a ::before or ::after (18/11): a decoration laid behind a block, e.g.
    // `.promo::before { position: absolute; inset: 0; background: url(...) center / 1920px auto }`.
    // A pseudo-element has no DOM box; it is read only when it is absolutely positioned in its
    // element, the usual form, with left, top, width and height resolved in px by the browser.
    if (!el.closest("svg")) for (const p of ["::before", "::after"]) {
      const ps = getComputedStyle(el, p);
      if (ps.content === "none" || ps.content === "normal" || ps.display === "none" || ps.visibility === "hidden" || !bgUrl(ps)) continue;
      if (ps.position !== "absolute" || cs.position === "static") continue;
      const left = parseFloat(ps.left), top = parseFloat(ps.top), w = parseFloat(ps.width), h = parseFloat(ps.height);
      if (![left, top, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      const r = el.getBoundingClientRect();
      const rect = { left: r.left + (parseFloat(cs.borderLeftWidth) || 0) + left, top: r.top + (parseFloat(cs.borderTopWidth) || 0) + top, width: w, height: h };
      const pbox = { x: rect.left + sx, y: rect.top + sy, w, h };
      const drawn = drawnImage(rect, ps);
      const differs = drawn && (Math.abs(drawn.x - pbox.x) > 0.01 || Math.abs(drawn.y - pbox.y) > 0.01 || Math.abs(drawn.w - pbox.w) > 0.01 || Math.abs(drawn.h - pbox.h) > 0.01);
      add(el, { index: out.length, kind: "image", nodeId: idOf(el), ancestors: ancestorsOf(el), box: pbox, imageBox: differs ? drawn : undefined, src: bgUrl(ps) });
    }

    // Image-like elements: what a Figma image fill or icon usually becomes in code.
    const isSvgRoot = tag === "svg" && !el.parentElement?.closest("svg");
    const isImage = tag === "img" || tag === "video" || tag === "canvas" || isSvgRoot || (cs.backgroundImage !== "none" && cs.backgroundImage.includes("url("));
    if (isImage) {
      const r = el.getBoundingClientRect();
      // The file drawn: currentSrc once loaded, the src attribute before (a lazy image not reached yet), else the background url.
      const src = (el as HTMLImageElement).currentSrc || el.getAttribute("src") || (cs.backgroundImage.match(/url\(["']?([^"')]+)/)?.[1] ?? undefined);
      if (visible(r)) {
        const box = { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
        const drawn = tag === "img" || tag === "video" || tag === "canvas" || isSvgRoot ? undefined : drawnImage(r, cs);
        const differs = drawn && (Math.abs(drawn.x - box.x) > 0.01 || Math.abs(drawn.y - box.y) > 0.01 || Math.abs(drawn.w - box.w) > 0.01 || Math.abs(drawn.h - box.h) > 0.01);
        add(el, { index: out.length, kind: "image", nodeId: idOf(el), ancestors: ancestorsOf(el), box, imageBox: differs ? drawn : undefined, src });
      }
      if (tag !== "div" && tag !== "section") continue; // an element with a background image may also hold text
    }

    // A text along a path (18/11): a circular badge is one <text> with a <textPath> in the page,
    // and one text layer per letter in Figma. It is kept, as one text, so score.ts can match the
    // letters with it. Its box is the ring's; its colour is its fill. Its font size is in the SVG's
    // own units: an SVG drawn smaller than its viewBox draws it smaller, so it is scaled to screen px.
    if (tag === "text" && el.querySelector("textPath")) {
      const r = el.getBoundingClientRect();
      const t = norm(el.textContent ?? "");
      const m = (el as SVGGraphicsElement).getScreenCTM();
      const scale = m ? Math.hypot(m.a, m.b) : 1;
      if (t && visible(r)) add(el, {
        index: out.length, kind: "text", text: t, depth: 0, onPath: true, nodeId: idOf(el), ancestors: ancestorsOf(el),
        box: { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height },
        style: { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: `${parseFloat(cs.fontSize) * scale}px`, lineHeight: cs.lineHeight, color: cs.fill.startsWith("rgb") ? cs.fill : cs.color, background: backgroundOf(el) },
      });
      continue;
    }

    if (el.closest("svg")) continue; // other SVG <text> is part of an icon, not of the page's text

    // A field's placeholder (16/11): Figma draws it as a text ("Enter Your Email"), the page keeps it
    // in an attribute, outside the text nodes. Box: horizontally, the text's width placed in the
    // field's content box at its text-align; vertically, the field's box.
    if (tag === "input" || tag === "textarea") {
      const field = el as HTMLInputElement;
      const r = el.getBoundingClientRect();
      if (field.placeholder && !field.value && visible(r)) {
        const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const inner = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) - left;
        const w = Math.min(textWidth(field.placeholder, cs), inner);
        const x = cs.textAlign === "center" ? left + (inner - w) / 2 : cs.textAlign === "right" || cs.textAlign === "end" ? left + inner - w : left;
        add(el, {
          index: out.length, kind: "text", text: norm(field.placeholder), depth: 0, nodeId: idOf(el), ancestors: ancestorsOf(el),
          box: { x: x + sx, y: r.top + sy, w, h: r.height },
          style: { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color, background: backgroundOf(el) },
        });
      }
      continue;
    }

    const text = norm(shownText(el));
    if (!text) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (!visible(r)) continue;
    // Horizontal extent from the text itself (Range); vertical extent from the element's
    // line boxes when it is not inline. A Range is only as tall as the glyphs, while a
    // Figma text box is (number of lines x line height) tall, like a block element's box.
    const e = el.getBoundingClientRect();
    const vertical = cs.display === "inline" ? r : e;
    add(el, {
      index: out.length,
      kind: "text",
      text,
      depth: el.querySelectorAll("*").length,
      nodeId: idOf(el),
      ancestors: ancestorsOf(el),
      box: { x: r.left + sx, y: vertical.top + sy, w: r.width, h: vertical.height },
      lines: text.length <= MAX_LINE_TEXT ? linesOf(el) : undefined,
      style: {
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        color: cs.color,
        background: backgroundOf(el),
      },
    });
  }
  for (const e of out) {
    const v = clipped(source[e.index], e.box);
    if (v.x !== e.box.x || v.y !== e.box.y || v.w !== e.box.w || v.h !== e.box.h) e.visibleBox = v;
  }
  return out;
}
