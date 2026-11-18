# The agent skill

This folder holds the skill every trial agent follows. It is written by hand by the
author of the bench, not generated. Two variants are expected:

| File | Used by | Content |
|---|---|---|
| `SKILL.md` | every browser tool | The full loop: read the mockup, build a section, open it in the browser, measure the gap, fix, repeat (at most `maxRoundsPerSection` rounds), final report. |
| `SKILL.control.md` | the control condition | The same skill without the "open in the browser" and "measure the gap" steps. |

The launcher copies the right variant into each trial workspace as
`.claude/skills/frontend-feedback-loop/SKILL.md`. The skill must not name any
browser tool: the agent discovers on its own which tools it has.

## What the bench needs from the skill (the contract)

The measurement scripts read files the agent produces. Whatever the wording of the
skill, it has to ask the agent for these three things, otherwise the measures fail:

1. **Where the mockup is.** `./mockup/design.json` (frames, sections, blocks with
   their box and style values), `./mockup/desktop.png` and `./mockup/mobile.png`
   (reference captures), `./mockup/assets/` (images and icons to use).
2. **One commit per round.** After each round of the loop, the agent runs
   `git add -A && git commit -m "round <n>: <section id>"`. The measurement replays
   these commits to draw the curve per round. A round that is not committed is not
   measured.
3. **A final report in `./report.json`**, with this shape:

```json
{
  "sections": [
    {
      "sectionId": "12:34",
      "status": "conforming",
      "issues": []
    },
    {
      "sectionId": "12:80",
      "status": "non-conforming",
      "issues": [
        { "blockId": "12:95", "description": "Title is 4px too low on mobile.", "visible": true }
      ]
    }
  ]
}
```

- `sectionId` and `blockId` are the ids found in `design.json`.
- A measured defect counts as **reported** only if its section is `non-conforming`
  **and** its block is listed in `issues`. Anything else is an **unreported defect**. A block
  listed while it has no defect is a **false alarm**. Both check the report against the page.
- `visible` (optional): the agent's judgement of whether a human eye would see the gap.
  The report splits reported defects by this judgement; it never changes what counts as
  a defect.

The skill should also tell the agent that a dev server is already running at
`devServerUrl` (`config/bench.json`): the launcher starts it before every trial.
