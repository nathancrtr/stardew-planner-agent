# Stardew Visual Planner Agent

An AI agent that builds Stardew Valley farm layouts on [stardew.info/planner](https://stardew.info/planner)
via browser automation — the "visual agent" approach: you type a natural-language request,
Claude designs the layout, and Playwright drives a real browser so you can watch it build.

```
"Place a Junimo Hut in the center of a standard farm, surrounded by a
 perfect grid of Iridium Sprinklers and Ancient Fruit crops"
        │
        ▼
  Claude API (claude-opus-4-8, structured outputs)
        │  JSON placement plan: [{type, item, column, row, ...}]
        ▼
  Playwright (headed Chromium)
        │  selects items, moves the mouse, clicks/drags on the PixiJS canvas
        ▼
  stardew.info/planner — watch it build, get a screenshot + share URL
```

## Setup

```sh
npm install
npx playwright install chromium
cp .env.example .env   # add your Anthropic API key
```

## Usage

```sh
# Full pipeline: natural language → plan → watch the browser build it
npm run agent -- "A 15x15 ancient fruit field with iridium sprinklers and a junimo hut in the middle"

# Options
npm run agent -- "..." --headless     # invisible browser (uses software GL)
npm run agent -- "..." --save         # save on stardew.info, prints share URL
npm run agent -- "..." --dry-run      # print the plan JSON, don't open a browser
npm run agent -- --plan plans/plan-123.json   # execute a saved plan (no API call)
npm run agent -- "..." --pace 500     # slow down between actions
```

Every generated plan is saved to `plans/` so you can re-run or hand-edit it.
A screenshot of the final board lands in `screenshots/`.

## How it works

The planner site is a PixiJS canvas app with no DOM menus, but it exposes a global
`window.planner` object. The executor reads geometry from it (tile size, the
tile→screen transform via `plannerSpriteContainer.toGlobal`) and acts through real
mouse events, so every placement goes through the app's own pointer pipeline:

1. `planner.changeGhostSprite(planner.getObjectByName(id))` — picks the item up as
   the cursor "brush" (the ghost sprite visibly follows the mouse)
2. `page.mouse.move(...)` to the target tile, then click — single placement for
   buildings/craftables, click-and-drag rows for crop/path fills (MULTI brush)
3. Placement verified against `planner.tiles[row][col]`; failures are reported per action

Claude gets a compact catalog of all ~650 placeable object ids (dumped from the live
site into `data/catalog.json` via `npx tsx src/dump-catalog.ts`), farm grid geometry,
and sprinkler/scarecrow/junimo coverage rules, and returns a schema-validated plan
(`zodOutputFormat` + `messages.parse`).

See `NOTES.md` for the full reverse-engineering notes on the planner's internals
(modal handling, WebGL-under-SwiftShader quirks, coordinate system, anchor semantics).

## Source layout

| File | Purpose |
|---|---|
| `src/cli.ts` | CLI entry point (`npm run agent`) |
| `src/plan.ts` | NL → placement plan via Claude API |
| `src/executor.ts` | Playwright driver for the planner canvas |
| `src/catalog.ts` | Item catalog loading/validation + prompt text |
| `src/types.ts` | Zod schemas for the plan format |
| `src/probe*.ts`, `src/dump-catalog.ts` | Dev tools used to reverse-engineer the site |
