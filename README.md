# Stardew Visual Planner Agent

An AI agent that builds Stardew Valley farm layouts on [stardew.info/planner](https://stardew.info/planner)
via browser automation: you type a natural-language request, Claude builds the layout in
a real browser — placing objects, reading back the board state, looking at screenshots,
and correcting its own mistakes — while you watch.

```
"Place a Junimo Hut in the center of a standard farm, surrounded by a
 perfect grid of Iridium Sprinklers and Ancient Fruit crops"
        │
        ▼
 ┌────────────────────── agentic loop ───────────────────────┐
 │  Claude (claude-opus-4-8) ──tool_use──▶ harness            │
 │     ▲                                    │ Playwright       │
 │     └──tool_result (text/errors/PNG)◀────┘ clicks & drags   │
 └────────────────────────────────────────────────────────────┘
        │
        ▼
  stardew.info/planner — watch it build, get a screenshot + share URL
```

The loop architecture (and a primer on tool use, agentic loops, multimodal feedback,
and prompt caching) is documented in [`docs/agent-harness.md`](docs/agent-harness.md).

## Setup

```sh
npm install
npx playwright install chromium
cp .env.example .env   # add your Anthropic API key
```

## Usage

```sh
# Agentic mode (default): Claude builds interactively, observes results, adapts
npm run agent -- "A 15x15 ancient fruit field with iridium sprinklers and a junimo hut in the middle"

# Options
npm run agent -- "..." --headless     # invisible browser (uses software GL)
npm run agent -- "..." --save         # save on stardew.info, prints share URL
npm run agent -- "..." --pace 500     # slow down between actions
npm run agent -- "..." --max-turns 50 # raise the loop-iteration guard (default 30)

# v1 workflow mode: Claude plans once, code executes open-loop (cheaper, no feedback)
npm run agent -- --oneshot "..."
npm run agent -- --oneshot "..." --dry-run    # print the plan JSON only
npm run agent -- --oneshot --plan plans/plan-123.json   # re-run a saved plan
```

Agentic runs save a full transcript to `runs/` for post-mortems; oneshot plans are
saved to `plans/`. Final-board screenshots land in `screenshots/`.

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
| `src/agent.ts` | The agentic loop: Claude + tools + feedback (v2) |
| `src/tools.ts` | Tool definitions and dispatch onto the session |
| `src/session.ts` | Long-lived Playwright session driving the planner canvas |
| `src/plan.ts` | v1 oneshot: NL → placement plan via structured outputs |
| `src/executor.ts` | v1 oneshot: open-loop plan execution |
| `src/catalog.ts` | Item catalog loading/validation + prompt text |
| `src/types.ts` | Zod schemas for the v1 plan format |
| `src/probe*.ts`, `src/dump-catalog.ts` | Dev tools used to reverse-engineer the site |
| `docs/agent-harness.md` | v2 architecture plan + agent-concepts primer |
