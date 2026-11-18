---
name: frontend-feedback-loop
description: Builds a web page from captures of a Figma mockup (./mockup/desktop.png and ./mockup/mobile.png) in a React + TypeScript project, section by section, desktop and mobile, aiming at a pixel-perfect result, then writes a final conformity report. Use when asked to build, implement or integrate a Figma mockup or design.
---

# Frontend feedback loop

Build the page of the mockup, section by section, for the desktop and the mobile frame.
The target is pixel-perfect: every element at the exact position and size, and every
style identical to the captures.

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

- `./mockup/desktop.png` and `./mockup/mobile.png`: captures of the two frames, at scale 1
  (1 px of the capture is 1 px of the page). They are the reference: the layout, the
  texts, the fonts, the sizes and the colours are read from them.
- `./mockup/sections.json`:
  - `frames`: the desktop and the mobile frame, with their `width` and `height` in px. The
    page at that viewport width must match the capture. A capture can be a little wider
    than its frame when a decoration spills past the edge: the frame width is the viewport.
  - `sections`: the sections of the page, from top to bottom, each with its `id`, its
    `name` and its frame (`frameId`).
- `./mockup/assets/`: the images and icons to use. Their file names do not say where they
  go: find each one in the captures.
- A dev server is already running at http://localhost:5173, with hot reload. Do not start
  another one and do not change its port.

## Setup

Identify the font families in the captures and load them from Google Fonts, with the
weights the page uses. If you cannot identify a family, or it is not on Google Fonts,
write it in the final report.

## Order of work

Take the sections from top to bottom. The n-th section of the desktop frame and the n-th
section of the mobile frame are the same section of the page: build and check them
together, as one responsive section. Finish a section before starting the next one.

## The loop, for each section

A round ends with a commit. Round 0 builds the section; rounds 1 to 3 fix it.

### Round 0: build

Build the section for both frames from the captures, then commit.

### Rounds 1 to 3: open, measure, fix

1. Open http://localhost:5173 in a browser, at a viewport the width of the desktop frame,
   then of the mobile frame, then 1024 px wide.
2. At 1024 px, check the section: no horizontal scrolling, no block overlapping another.
3. At the two frame widths, compare every element of the section with the capture:
   - its box: x, y, width and height, in px, relative to the top-left corner of the page
     (the page is the frame);
   - for texts, the text itself and the six style values: font family, font weight, font
     size, line height, text colour, and background colour;
   - the errors in the browser console.
   A value is right only if it is equal: 0 px of gap, identical colours.
4. Fix the gaps, then commit.

Stop the loop when every element of the section is right on both frames and the section
holds at 1024 px, or after round 3.
Then move to the next section, and keep the remaining gaps for the final report.

### Commits

After every round, run:

```
git add -A && git commit -m "round <n>: <desktop section id>"
```

## Final report

When every section is done, write `./report.json`. Add one entry per section id of
`sections.json`, desktop and mobile alike. For each section, report its state at the end
of your work, with the same precision rule as the build: a value is right only if it is
equal to the capture (0 px of gap on x, y, width and height; identical style values,
colours included).

- `conforming`: every element is right.
- `non-conforming`: at least one element still differs from the capture (box, text or one
  of the six style values). List each such element in `issues`: say which element it is
  (its text, or what the image shows), its gap in numbers, and `visible`: `true` if you
  judge the gap visible to a human eye, `false` otherwise.

```json
{
  "sections": [
    { "sectionId": "12:34", "status": "conforming", "issues": [] },
    {
      "sectionId": "12:80",
      "status": "non-conforming",
      "issues": [
        { "description": "Title \"Our services\": y is 4px too low (512 instead of 508).", "visible": true }
      ]
    }
  ]
}
```

`sectionId` is an id of `sections.json`.

## Checklist

Copy this checklist and tick it for each section:

```
- [ ] Round 0: build desktop and mobile, commit
- [ ] Round 1: open, measure, fix, commit (skip if all right)
- [ ] Round 2: open, measure, fix, commit (skip if all right)
- [ ] Round 3: open, measure, fix, commit (skip if all right)
- [ ] Note the remaining gaps
```

At the end: `- [ ] ./report.json written, one entry per section id`.
