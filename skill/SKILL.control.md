---
name: frontend-feedback-loop
description: Builds a web page from a Figma mockup export (./mockup/design.json and reference captures) in a React + TypeScript project, section by section, desktop and mobile, aiming at a pixel-perfect result, then writes a final conformity report. Use when asked to build, implement or integrate a Figma mockup or design.
---

# Frontend feedback loop

Build the page of the mockup, section by section, for the desktop and the mobile frame.
The target is pixel-perfect: every block at the exact position and size, and every style
value identical to the mockup.

## A responsive page

As in any real project, the result is one responsive page:

- One page that adapts to every width, laid out in the flow (flexbox, grid, media
  queries). The desktop frame and the mobile frame are two states of this same page, not
  two separate pages.
- It holds across the whole range between the two frames and beyond, including the common
  widths 1280, 1024 and 768 px: no horizontal scrolling, no block overlapping another.
- At the two frame widths, the target stays pixel-perfect.
- Semantic HTML: landmarks (`header`, `nav`, `main`, `section`, `footer`), headings in
  order, `button` and `a` for actions.
- Optimised images: `alt` text, `width` and `height` attributes, `loading="lazy"` below
  the fold.

## Inputs

- `./mockup/design.json`: the reference.
  - `frames`: one desktop and one mobile frame, with their `width` and `height`.
  - `sections`: each section belongs to one frame (`frameId`) and has a `box`.
  - `blocks`: each block belongs to one section (`sectionId`), has a `box` (x, y, w, h in
    px, relative to the top-left corner of its frame), a `kind` (`text` or `image`), and:
    for text, `text` and `style` (`fontFamily`, `fontWeight`, `fontSize`, `lineHeight`,
    `color`, `background`); for images, `asset`.
- `./mockup/desktop.png` and `./mockup/mobile.png`: captures of the two frames.
- `./mockup/assets/`: the images and icons to use (the `asset` path of each image block).
- A dev server is already running at http://localhost:5173, with hot reload. Do not start
  another one and do not change its port.

The values of `design.json` are the reference for everything they describe. Use the
captures for everything they do not describe (shadows, gradients, borders, radii,
decorations).

## Setup

Load every font family used in `design.json` from Google Fonts, with the weights the
blocks use. If a family is not on Google Fonts, write it in the final report.

## Order of work

Take the sections from top to bottom. The n-th section of the desktop frame and the n-th
section of the mobile frame are the same section of the page: build them together, as one
responsive section. Finish a section before starting the next one.

## For each section

Build the section for both frames from `design.json`, then commit:

```
git add -A && git commit -m "round 0: <desktop section id>"
```

## Final report

When every section is done, write `./report.json`. Add one entry per section id of
`design.json`, desktop and mobile alike. For each section, report its state at the end of
your work, with the same precision rule as the build: a value is right only if it is equal
to `design.json` (0 px of gap on x, y, width and height; identical style values, colours
included).

- `conforming`: every block is right.
- `non-conforming`: at least one block still differs from `design.json` (box or one of the
  six style values). List each such block in `issues`, with its gap in numbers, and
  `visible`: `true` if you judge the gap visible to a human eye, `false` otherwise.

```json
{
  "sections": [
    { "sectionId": "12:34", "status": "conforming", "issues": [] },
    {
      "sectionId": "12:80",
      "status": "non-conforming",
      "issues": [
        { "blockId": "12:95", "description": "y is 4px too low (512 instead of 508).", "visible": true }
      ]
    }
  ]
}
```

`sectionId` and `blockId` are the ids of `design.json`.

## Checklist

Copy this checklist and tick it for each section:

```
- [ ] Build desktop and mobile, commit
```

At the end: `- [ ] ./report.json written, one entry per section id`.
